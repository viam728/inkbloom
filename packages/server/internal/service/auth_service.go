package service

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"time"
	"unicode"

	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/pkg/authtoken"
	"github.com/inkbloom/server/internal/pkg/kvstore"
	"github.com/inkbloom/server/internal/pkg/password"
	"github.com/inkbloom/server/internal/pkg/sms"
	"github.com/inkbloom/server/internal/repository"
	"go.uber.org/zap"
)

// Auth-related TTLs.
const (
	smsCodeTTL = 300 * time.Second // smscode:{phone}
	smsRateTTL = 60 * time.Second  // per-phone send frequency control
)

// Demo account seeded at startup (backfill target of task #33).
const (
	DemoUserPhone    = "13800000000"
	DemoUserNickname = "本地数据用户"
	DemoUserPassword = "inkbloom123"
)

// Sentinel errors surfaced by AuthService (mapped to HTTP codes in the handler).
var (
	ErrInvalidPhone      = errors.New("invalid phone number")
	ErrCodeRateLimited   = errors.New("sms code requested too frequently, retry after 60s")
	ErrInvalidCode       = errors.New("invalid or expired verification code")
	ErrUserExists        = errors.New("phone number already registered")
	ErrUserNotFound      = errors.New("user not found")
	ErrInvalidCredential = errors.New("incorrect phone number or password")
	ErrUserDisabled      = errors.New("account is disabled")
	ErrWeakPassword      = errors.New("password must be 8-64 characters containing both letters and digits")
	ErrMissingCredential = errors.New("verification code or password is required")
	ErrTokenRevoked      = errors.New("refresh token revoked or expired")
	// ErrTermsNotAgreed is returned when registration arrives without the
	// terms/privacy acceptance flag (tech plan v2 §9.2).
	ErrTermsNotAgreed = errors.New("must accept the terms of service and privacy policy")
)

var phoneRegexp = regexp.MustCompile(`^1[3-9]\d{9}$`)

// TokenPair is a freshly issued access + refresh token duo.
type TokenPair struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	// ExpiresIn is the access token lifetime in seconds.
	ExpiresIn int64 `json:"expires_in"`
}

// AuthService implements registration, login, token refresh/logout and the
// SMS verification code flow (kvstore-backed, no table). Cloud mode wires a
// Redis adapter; the local embedded mode wires the in-memory store.
type AuthService struct {
	users       repository.UserRepository
	kv          kvstore.Store
	tokens      *authtoken.Manager
	smsProvider sms.Provider
	// subs opens the 14-day trial on registration (task #39). Optional:
	// when nil registration skips trial creation (defensive fallback).
	subs *SubscriptionService
	// tokenSvc grants the registration experience pack (task #43). Optional.
	tokenSvc *TokenService
	// adminPhones are auto-promoted to operator role at register/login
	// (task #49, M5: config admin.phones).
	adminPhones map[string]bool
	logger      *zap.Logger
}

// NewAuthService creates an AuthService. subs and tokenSvc may be nil.
func NewAuthService(users repository.UserRepository, kv kvstore.Store,
	tokens *authtoken.Manager, smsProvider sms.Provider, subs *SubscriptionService, tokenSvc *TokenService,
	adminPhones []string, logger *zap.Logger) *AuthService {
	adminSet := make(map[string]bool, len(adminPhones))
	for _, p := range adminPhones {
		if p != "" {
			adminSet[p] = true
		}
	}
	return &AuthService{
		users:       users,
		kv:          kv,
		tokens:      tokens,
		smsProvider: smsProvider,
		subs:        subs,
		tokenSvc:    tokenSvc,
		adminPhones: adminSet,
		logger:      logger,
	}
}

// ── Redis key helpers ──────────────────────────────────────────────────────

func smsCodeKey(phone string) string          { return "smscode:" + phone }
func smsRateKey(phone string) string          { return "smscode:rate:" + phone }
func refreshKey(uid int64, jti string) string { return fmt.Sprintf("refresh:%d:%s", uid, jti) }

// ── SMS code ───────────────────────────────────────────────────────────────

// SendCode issues a 6-digit verification code for the phone number with a
// 60s per-phone frequency control. The code is stored in the kv store for 300s.
func (s *AuthService) SendCode(ctx context.Context, phone string) error {
	if !phoneRegexp.MatchString(phone) {
		return ErrInvalidPhone
	}

	ok, err := s.kv.SetNX(ctx, smsRateKey(phone), "1", smsRateTTL)
	if err != nil {
		return err
	}
	if !ok {
		return ErrCodeRateLimited
	}

	n, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return fmt.Errorf("generating sms code: %w", err)
	}
	code := fmt.Sprintf("%06d", n.Int64())

	if err := s.kv.Set(ctx, smsCodeKey(phone), code, smsCodeTTL); err != nil {
		return err
	}

	return s.smsProvider.Send(ctx, phone, code)
}

// verifyCode consumes the stored code: it is deleted after a successful check.
func (s *AuthService) verifyCode(ctx context.Context, phone, code string) error {
	stored, err := s.kv.Get(ctx, smsCodeKey(phone))
	if errors.Is(err, kvstore.ErrNotFound) || stored != code {
		return ErrInvalidCode
	}
	if err != nil {
		return err
	}
	_, err = s.kv.Del(ctx, smsCodeKey(phone))
	return err
}

// ── Register / Login ───────────────────────────────────────────────────────

// Register creates a new account after verifying the SMS code, then issues a
// token pair. nickname defaults to "创作者" + phone tail.
func (s *AuthService) Register(ctx context.Context, phone, code, pwd, nickname string, agreedTerms bool) (*model.User, *TokenPair, error) {
	if !agreedTerms {
		return nil, nil, ErrTermsNotAgreed
	}
	if err := ValidatePassword(pwd); err != nil {
		return nil, nil, err
	}
	if !phoneRegexp.MatchString(phone) {
		return nil, nil, ErrInvalidPhone
	}
	if err := s.verifyCode(ctx, phone, code); err != nil {
		return nil, nil, err
	}

	existing, err := s.users.GetByPhone(ctx, phone)
	if err != nil {
		return nil, nil, err
	}
	if existing != nil {
		return nil, nil, ErrUserExists
	}

	hash, err := password.Hash(pwd)
	if err != nil {
		return nil, nil, fmt.Errorf("hashing password: %w", err)
	}

	if nickname == "" {
		nickname = defaultNickname(phone)
	}
	now := time.Now()
	user := &model.User{
		Phone:             &phone,
		PasswordHash:      &hash,
		Nickname:          nickname,
		Status:            model.UserStatusActive,
		Role:              model.RoleUser,
		RegisteredChannel: "sms",
		LastLoginAt:       &now,
		AgreedTermsAt:     &now, // v2 §9.2: terms accepted at registration
	}
	// Task #49: phones listed in admin.phones start as operators.
	if s.adminPhones[phone] {
		user.Role = model.RoleOperator
	}
	if err := s.users.Create(ctx, user); err != nil {
		return nil, nil, err
	}

	// M3: registration opens the 14-day free trial automatically. Best
	// effort — a billing hiccup must not break sign-up (GET /subscription
	// lazily creates the row as a second safety net).
	if s.subs != nil {
		if err := s.subs.StartTrial(ctx, user.ID, now); err != nil {
			s.logger.Error("failed to start trial on registration",
				zap.Int64("user_id", user.ID), zap.Error(err))
		}
	}
	// M4 (task #43): registration grants the 500k-unit experience pack
	// (valid 90 days). Best effort, same policy as the trial above.
	if s.tokenSvc != nil {
		if err := s.tokenSvc.GrantTrialGift(ctx, user.ID); err != nil {
			s.logger.Error("failed to grant trial token gift on registration",
				zap.Int64("user_id", user.ID), zap.Error(err))
		}
	}

	pair, err := s.issueTokens(ctx, user.ID)
	if err != nil {
		return nil, nil, err
	}
	s.logger.Info("user registered", zap.Int64("user_id", user.ID), zap.String("phone", phone))
	return user, pair, nil
}

// Login authenticates by SMS code (preferred) or password, updates
// last_login_at and issues a token pair.
func (s *AuthService) Login(ctx context.Context, phone, pwd, code string) (*model.User, *TokenPair, error) {
	if code == "" && pwd == "" {
		return nil, nil, ErrMissingCredential
	}

	user, err := s.users.GetByPhone(ctx, phone)
	if err != nil {
		return nil, nil, err
	}
	if user == nil {
		return nil, nil, ErrInvalidCredential
	}

	if code != "" {
		if err := s.verifyCode(ctx, phone, code); err != nil {
			return nil, nil, err
		}
	} else {
		if user.PasswordHash == nil || !password.Verify(pwd, *user.PasswordHash) {
			return nil, nil, ErrInvalidCredential
		}
	}

	if user.Status != model.UserStatusActive {
		return nil, nil, ErrUserDisabled
	}

	// Task #49: phones listed in admin.phones are promoted on login
	// (role=max(role,1); never demotes existing higher roles).
	if s.adminPhones[phone] && user.Role < model.RoleOperator {
		if err := s.users.UpdateRole(ctx, user.ID, model.RoleOperator); err != nil {
			s.logger.Error("failed to promote admin phone",
				zap.Int64("user_id", user.ID), zap.Error(err))
		} else {
			user.Role = model.RoleOperator
		}
	}

	now := time.Now()
	if err := s.users.UpdateLastLogin(ctx, user.ID, now); err != nil {
		return nil, nil, err
	}
	user.LastLoginAt = &now

	pair, err := s.issueTokens(ctx, user.ID)
	if err != nil {
		return nil, nil, err
	}
	return user, pair, nil
}

// ── Refresh / Logout ───────────────────────────────────────────────────────

// Refresh rotates the token pair: the presented refresh token's jti must
// still exist in Redis; it is deleted and a fresh pair is issued.
func (s *AuthService) Refresh(ctx context.Context, refreshToken string) (*model.User, *TokenPair, error) {
	claims, err := s.tokens.ParseTyped(refreshToken, authtoken.TypeRefresh)
	if err != nil {
		return nil, nil, ErrTokenRevoked
	}
	uid, err := claims.UID()
	if err != nil {
		return nil, nil, ErrTokenRevoked
	}

	deleted, err := s.kv.Del(ctx, refreshKey(uid, claims.ID))
	if err != nil {
		return nil, nil, err
	}
	if deleted == 0 {
		// Already rotated, logged out or expired.
		return nil, nil, ErrTokenRevoked
	}

	user, err := s.users.GetByID(ctx, uid)
	if err != nil {
		return nil, nil, err
	}
	if user == nil {
		return nil, nil, ErrUserNotFound
	}
	if user.Status != model.UserStatusActive {
		return nil, nil, ErrUserDisabled
	}

	pair, err := s.issueTokens(ctx, uid)
	if err != nil {
		return nil, nil, err
	}
	return user, pair, nil
}

// Logout revokes refresh sessions of uid. When refreshToken is provided only
// that session's jti is removed; otherwise all sessions of the user are wiped.
func (s *AuthService) Logout(ctx context.Context, uid int64, refreshToken string) error {
	if refreshToken != "" {
		claims, err := s.tokens.ParseTyped(refreshToken, authtoken.TypeRefresh)
		if err != nil {
			return nil // nothing revocable; treat as success
		}
		target, err := claims.UID()
		if err != nil || target != uid {
			return nil
		}
		_, err = s.kv.Del(ctx, refreshKey(target, claims.ID))
		return err
	}

	keys, err := s.kv.KeysWithPrefix(ctx, fmt.Sprintf("refresh:%d:", uid))
	if err != nil {
		return err
	}
	if len(keys) == 0 {
		return nil
	}
	_, err = s.kv.Del(ctx, keys...)
	return err
}

// Me returns the authenticated user's profile.
func (s *AuthService) Me(ctx context.Context, uid int64) (*model.User, error) {
	user, err := s.users.GetByID(ctx, uid)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, ErrUserNotFound
	}
	return user, nil
}

// ── Account deregistration (tech plan v2 §9.2) ──────────────────────────────

// ErrAlreadyCancelling is returned when a deregistration is already in its
// cool-down window.
var ErrAlreadyCancelling = errors.New("account deregistration already in progress")

// ErrNotCancelling is returned by CancelDeregistration when the account is
// not in the cool-down state.
var ErrNotCancelling = errors.New("account is not in deregistration cool-down")

// RequestDeregistration marks the account as cool-down (status=2) and
// revokes every session. The 15-day physical-deletion sweep runs as an
// ops-side cron (out of scope for the request path).
func (s *AuthService) RequestDeregistration(ctx context.Context, uid int64) error {
	user, err := s.users.GetByID(ctx, uid)
	if err != nil {
		return err
	}
	if user == nil {
		return ErrUserNotFound
	}
	if user.Status == model.UserStatusCoolDown {
		return ErrAlreadyCancelling
	}
	if err := s.users.UpdateStatus(ctx, uid, model.UserStatusCoolDown); err != nil {
		return err
	}
	// Revoke all sessions so the account cannot keep acting while cooling.
	return s.Logout(ctx, uid, "")
}

// CancelDeregistration reverses a cool-down account back to active.
func (s *AuthService) CancelDeregistration(ctx context.Context, uid int64) error {
	user, err := s.users.GetByID(ctx, uid)
	if err != nil {
		return err
	}
	if user == nil {
		return ErrUserNotFound
	}
	if user.Status != model.UserStatusCoolDown {
		return ErrNotCancelling
	}
	return s.users.UpdateStatus(ctx, uid, model.UserStatusActive)
}

// ── Demo account ───────────────────────────────────────────────────────────

// EnsureDemoUser seeds the id=1 demo account (phone 13800000000 /
// password inkbloom123) used by task #33 for legacy data backfill.
func (s *AuthService) EnsureDemoUser(ctx context.Context) error {
	hash, err := password.Hash(DemoUserPassword)
	if err != nil {
		return fmt.Errorf("hashing demo password: %w", err)
	}
	return s.users.EnsureDemoUser(ctx, DemoUserPhone, DemoUserNickname, hash)
}

// ── helpers ────────────────────────────────────────────────────────────────

// issueTokens signs a fresh access/refresh pair and records the new refresh
// jti in Redis (sliding 30-day window = refresh token TTL).
func (s *AuthService) issueTokens(ctx context.Context, uid int64) (*TokenPair, error) {
	access, err := s.tokens.IssueAccess(uid)
	if err != nil {
		return nil, err
	}
	refresh, jti, err := s.tokens.IssueRefresh(uid)
	if err != nil {
		return nil, err
	}
	if err := s.kv.Set(ctx, refreshKey(uid, jti), "1", s.tokens.RefreshTTL()); err != nil {
		return nil, err
	}
	return &TokenPair{
		AccessToken:  access,
		RefreshToken: refresh,
		TokenType:    "Bearer",
		ExpiresIn:    int64(s.tokens.AccessTTL().Seconds()),
	}, nil
}

// ValidatePassword enforces the password policy: 8-64 chars, letters + digits.
func ValidatePassword(pwd string) error {
	if len(pwd) < 8 || len(pwd) > 64 {
		return ErrWeakPassword
	}
	var hasLetter, hasDigit bool
	for _, r := range pwd {
		switch {
		case unicode.IsLetter(r):
			hasLetter = true
		case unicode.IsDigit(r):
			hasDigit = true
		}
	}
	if !hasLetter || !hasDigit {
		return ErrWeakPassword
	}
	return nil
}

func defaultNickname(phone string) string {
	tail := phone
	if len(phone) >= 4 {
		tail = phone[len(phone)-4:]
	}
	return "创作者" + tail
}
