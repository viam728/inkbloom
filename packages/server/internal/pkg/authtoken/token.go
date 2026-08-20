// Package authtoken issues and validates the HS256 JWTs used by the
// account system (access + refresh token pair).
package authtoken

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Token types carried in the "typ" claim.
const (
	TypeAccess  = "access"
	TypeRefresh = "refresh"
)

// Errors returned by parsing helpers.
var (
	ErrInvalidToken   = errors.New("invalid token")
	ErrTokenType      = errors.New("unexpected token type")
	ErrInvalidSubject = errors.New("invalid token subject")
)

// Claims carries the user id (sub), token type (typ) and jti on top of the
// standard registered claims (iat / exp).
type Claims struct {
	Type string `json:"typ"`
	jwt.RegisteredClaims
}

// UID parses the subject claim into the numeric user id.
func (c *Claims) UID() (int64, error) {
	uid, err := strconv.ParseInt(c.Subject, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%w: %q", ErrInvalidSubject, c.Subject)
	}
	return uid, nil
}

// Manager signs and verifies JWTs with a shared HS256 secret.
type Manager struct {
	secret     []byte
	accessTTL  time.Duration
	refreshTTL time.Duration
}

// NewManager creates a Manager. accessTTL/refreshTTL fall back to sane
// defaults when non-positive.
func NewManager(secret string, accessTTL, refreshTTL time.Duration) *Manager {
	if accessTTL <= 0 {
		accessTTL = 2 * time.Hour
	}
	if refreshTTL <= 0 {
		refreshTTL = 720 * time.Hour
	}
	return &Manager{
		secret:     []byte(secret),
		accessTTL:  accessTTL,
		refreshTTL: refreshTTL,
	}
}

// AccessTTL returns the configured access token lifetime.
func (m *Manager) AccessTTL() time.Duration { return m.accessTTL }

// RefreshTTL returns the configured refresh token lifetime.
func (m *Manager) RefreshTTL() time.Duration { return m.refreshTTL }

// IssueAccess signs a short-lived access token for the given user id.
func (m *Manager) IssueAccess(uid int64) (string, error) {
	return m.sign(uid, TypeAccess, m.accessTTL, "")
}

// IssueRefresh signs a long-lived refresh token with a fresh jti, which the
// caller persists in Redis to make the token revocable. The jti is returned
// alongside the token.
func (m *Manager) IssueRefresh(uid int64) (token, jti string, err error) {
	jti, err = RandomJTI()
	if err != nil {
		return "", "", err
	}
	token, err = m.sign(uid, TypeRefresh, m.refreshTTL, jti)
	if err != nil {
		return "", "", err
	}
	return token, jti, nil
}

func (m *Manager) sign(uid int64, typ string, ttl time.Duration, jti string) (string, error) {
	now := time.Now()
	claims := &Claims{
		Type: typ,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   strconv.FormatInt(uid, 10),
			ID:        jti,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
		},
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(m.secret)
}

// Parse verifies the signature and expiry of a token and returns its claims.
func (m *Manager) Parse(token string) (*Claims, error) {
	claims := &Claims{}
	parsed, err := jwt.ParseWithClaims(token, claims, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("%w: unexpected signing method %v", ErrInvalidToken, t.Header["alg"])
		}
		return m.secret, nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))
	if err != nil || !parsed.Valid {
		return nil, ErrInvalidToken
	}
	return claims, nil
}

// ParseTyped parses a token and additionally enforces the expected typ claim.
func (m *Manager) ParseTyped(token, typ string) (*Claims, error) {
	claims, err := m.Parse(token)
	if err != nil {
		return nil, err
	}
	if claims.Type != typ {
		return nil, fmt.Errorf("%w: got %q, want %q", ErrTokenType, claims.Type, typ)
	}
	return claims, nil
}

// RandomJTI generates a random 128-bit hex token id.
func RandomJTI() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
