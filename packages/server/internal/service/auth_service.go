package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
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

// Demo account seeded at startup (backfill target of migrations/010:
// every business row carries user_id DEFAULT 1). The account must exist so
// legacy data has an owner, but it must never be loggable — there is no
// password constant on purpose.
const (
	DemoUserPhone    = "13800000000"
	DemoUserNickname = "本地数据用户"
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

// DeviceInfo captures request metadata recorded against a session (plan A22).
// The handler derives it from User-Agent and remote address.
type DeviceInfo struct {
	DeviceName string
	DeviceType string
	IP         string
}

// maxSessionsPerUser caps concurrent sessions per account (plan A22: three
// devices online; a new login evicts the least-recently-active one).
const maxSessionsPerUser = 3

// AuthService implements registration, login, token refresh/logout and the
// SMS verification code flow (kvstore-backed, no table). Cloud mode wires a
// Redis adapter; the local embedded mode wires the in-memory store.
type AuthService struct {
	users    repository.UserRepository
	kv       kvstore.Store
	tokens   *authtoken.Manager
	sessions repository.UserSessionRepository
	// smsProvider sends verification codes (kvstore-backed, no device dim).
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
	tokens *authtoken.Manager, sessions repository.UserSessionRepository,
	smsProvider sms.Provider, subs *SubscriptionService, tokenSvc *TokenService,
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
		sessions:    sessions,
		smsProvider: smsProvider,
		subs:        subs,
		tokenSvc:    tokenSvc,
		adminPhones: adminSet,
		logger:      logger,
	}
}

// ── Redis key helpers ──────────────────────────────────────────────────────

func smsCodeKey(phone string) string { return "smscode:" + phone }
func smsRateKey(phone string) string { return "smscode:rate:" + phone }

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
func (s *AuthService) Register(ctx context.Context, phone, code, pwd, nickname string, agreedTerms bool, device DeviceInfo) (*model.User, *TokenPair, error) {
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

	pair, err := s.issueTokens(ctx, user.ID, device)
	if err != nil {
		return nil, nil, err
	}
	s.logger.Info("user registered", zap.Int64("user_id", user.ID), zap.String("phone", phone))
	return user, pair, nil
}

// Login authenticates by SMS code (preferred) or password, updates
// last_login_at and issues a token pair.
func (s *AuthService) Login(ctx context.Context, phone, pwd, code string, device DeviceInfo) (*model.User, *TokenPair, error) {
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

	pair, err := s.issueTokens(ctx, user.ID, device)
	if err != nil {
		return nil, nil, err
	}
	return user, pair, nil
}

// ── Refresh / Logout ───────────────────────────────────────────────────────

// Refresh rotates the token pair: the presented refresh token's jti must
// still exist as a live session; it is atomically consumed and a fresh pair
// is issued (carrying the same device metadata forward).
func (s *AuthService) Refresh(ctx context.Context, refreshToken string, device DeviceInfo) (*model.User, *TokenPair, error) {
	claims, err := s.tokens.ParseTyped(refreshToken, authtoken.TypeRefresh)
	if err != nil {
		return nil, nil, ErrTokenRevoked
	}
	uid, err := claims.UID()
	if err != nil {
		return nil, nil, ErrTokenRevoked
	}

	old, ok, err := s.sessions.Consume(ctx, claims.ID)
	if err != nil {
		return nil, nil, err
	}
	if !ok || old.UserID != uid || old.ExpiresAt.Before(time.Now()) {
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

	// Carry the device identity forward so a refresh doesn't spawn a brand-new
	// device entry (which would trip the 3-device limit on every rotation).
	if device.DeviceName == "" {
		device.DeviceName = old.DeviceName
	}
	if device.DeviceType == "" {
		device.DeviceType = old.DeviceType
	}
	if device.IP == "" {
		device.IP = old.IP
	}

	pair, err := s.issueTokens(ctx, uid, device)
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
		_, _, err = s.sessions.Consume(ctx, claims.ID)
		return err
	}
	return s.sessions.DeleteByUser(ctx, uid)
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

// EnsureDemoUser seeds the id=1 demo account that owns pre-isolation legacy
// data (migrations/010 backfills every row to user_id = 1). Ownership is the
// only reason this account exists, so on a production install it is created
// with a random, never-logged password and locked — it must never be loggable
// there. disableLogin carries that production decision (see Config.IsProduction).
//
// Installs seeded by older builds carry the well-known "inkbloom123" password;
// those are locked on first production startup. In a non-production (local
// dev) run the gate is inverted: a previously-locked account is re-enabled so
// development keeps a known, usable account.
func (s *AuthService) EnsureDemoUser(ctx context.Context, disableLogin bool) error {
	existing, err := s.users.GetByPhone(ctx, DemoUserPhone)
	if err != nil {
		return err
	}
	if existing != nil {
		if disableLogin {
			if existing.Status == model.UserStatusDisabled {
				return nil
			}
			// Legacy seed with a public password: lock it down now.
			if err := s.users.UpdateStatus(ctx, existing.ID, model.UserStatusDisabled); err != nil {
				return fmt.Errorf("locking legacy demo account: %w", err)
			}
			s.logger.Warn("demo account disabled: it owns legacy data and is not meant to be logged into",
				zap.Int64("user_id", existing.ID))
			return nil
		}
		// Non-production: restore a previously-locked account so local dev can
		// log in with the well-known seed password again.
		if existing.Status != model.UserStatusActive {
			if err := s.users.UpdateStatus(ctx, existing.ID, model.UserStatusActive); err != nil {
				return fmt.Errorf("re-enabling demo account for local dev: %w", err)
			}
			s.logger.Info("demo account re-enabled for non-production run",
				zap.Int64("user_id", existing.ID))
		}
		return nil
	}

	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Errorf("generating demo password: %w", err)
	}
	hash, err := password.Hash(hex.EncodeToString(buf))
	if err != nil {
		return fmt.Errorf("hashing demo password: %w", err)
	}

	status := model.UserStatusActive
	if disableLogin {
		status = model.UserStatusDisabled
	}
	if err := s.users.EnsureDemoUser(ctx, DemoUserPhone, DemoUserNickname, hash, status); err != nil {
		return err
	}
	s.logger.Info("demo account seeded", zap.String("phone", DemoUserPhone),
		zap.Bool("login_disabled", disableLogin))
	return nil
}

// ── helpers ────────────────────────────────────────────────────────────────

// issueTokens signs a fresh access/refresh pair, records a persistent
// session row (sliding 30-day window = refresh token TTL) and enforces the
// per-account device limit.
func (s *AuthService) issueTokens(ctx context.Context, uid int64, device DeviceInfo) (*TokenPair, error) {
	access, err := s.tokens.IssueAccess(uid)
	if err != nil {
		return nil, err
	}
	refresh, jti, err := s.tokens.IssueRefresh(uid)
	if err != nil {
		return nil, err
	}

	now := time.Now()
	// Enforce the 3-device cap before persisting the new session. Best effort:
	// an eviction failure must not block login, so we only warn.
	if s.sessions != nil {
		if n, err := s.sessions.CountActive(ctx, uid); err == nil && n >= maxSessionsPerUser {
			if err := s.sessions.DeleteOldest(ctx, uid); err != nil {
				s.logger.Warn("failed to evict oldest session", zap.Int64("user_id", uid), zap.Error(err))
			}
		}
		if device.DeviceName == "" {
			device.DeviceName = "未命名设备"
		}
		sess := &model.UserSession{
			UserID:       uid,
			JTI:          jti,
			DeviceName:   device.DeviceName,
			DeviceType:   device.DeviceType,
			IP:           device.IP,
			LastActiveAt: now,
			ExpiresAt:    now.Add(s.tokens.RefreshTTL()),
		}
		if err := s.sessions.Create(ctx, sess); err != nil {
			return nil, err
		}
	}

	return &TokenPair{
		AccessToken:  access,
		RefreshToken: refresh,
		TokenType:    "Bearer",
		ExpiresIn:    int64(s.tokens.AccessTTL().Seconds()),
	}, nil
}

// ListSessions returns the user's live sessions for the device management
// page (plan A22).
func (s *AuthService) ListSessions(ctx context.Context, uid int64) ([]model.UserSession, error) {
	if s.sessions == nil {
		return nil, nil
	}
	return s.sessions.ListByUser(ctx, uid)
}

// DeleteSession revokes one session by id (plan A22).
func (s *AuthService) DeleteSession(ctx context.Context, uid, id int64) error {
	if s.sessions == nil {
		return nil
	}
	return s.sessions.DeleteByID(ctx, uid, id)
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
