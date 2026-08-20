package service

import (
	"context"
	"math"
	"time"

	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
	"go.uber.org/zap"
)

// SubscriptionService owns the subscription state machine. The stored row
// only records the last persisted status; the *effective* status is derived
// from timestamps at read time (time-driven, no cron), concentrated in
// DeriveSubscriptionState so middleware and handlers share one definition.
type SubscriptionService struct {
	subs   repository.SubscriptionRepository
	logger *zap.Logger
}

// NewSubscriptionService creates a SubscriptionService.
func NewSubscriptionService(subs repository.SubscriptionRepository, logger *zap.Logger) *SubscriptionService {
	return &SubscriptionService{subs: subs, logger: logger}
}

func days(n int) time.Duration { return time.Duration(n) * 24 * time.Hour }

// DeriveSubscriptionState computes the effective status from timestamps:
//
//	now <  expires_at         → stored status (trialing/active), writable
//	now >= expires_at + 180d  → dormant, read-only (deletion mark; the real
//	                             cleanup cron is deferred, plan doc §3.1)
//	now >= expires_at         → grace, read-only
func DeriveSubscriptionState(sub *model.Subscription, now time.Time) (status string, readOnly bool) {
	if !now.Before(sub.ExpiresAt) { // now >= expires_at
		if !now.Before(sub.ExpiresAt.Add(days(model.DormantDays))) {
			return model.SubscriptionDormant, true
		}
		return model.SubscriptionGrace, true
	}
	if sub.Status == model.SubscriptionTrialing {
		return model.SubscriptionTrialing, false
	}
	return model.SubscriptionActive, false
}

// StartTrial opens the 14-day free trial (no card required, plan doc §3.1).
func (s *SubscriptionService) StartTrial(ctx context.Context, userID int64, now time.Time) error {
	expires := now.Add(days(model.TrialDays))
	grace := expires.Add(days(model.GraceDays))
	sub := &model.Subscription{
		UserID:     userID,
		Plan:       "base",
		Status:     model.SubscriptionTrialing,
		StartedAt:  now,
		ExpiresAt:  expires,
		GraceUntil: &grace,
	}
	return s.subs.Create(ctx, sub)
}

// loadOrStartTrial returns the subscription row, lazily opening a trial when
// the row is missing (defensive: startup backfill and registration normally
// create it up front).
func (s *SubscriptionService) loadOrStartTrial(ctx context.Context, userID int64, now time.Time) (*model.Subscription, error) {
	sub, err := s.subs.GetByUserID(ctx, userID)
	if err != nil {
		return nil, err
	}
	if sub != nil {
		return sub, nil
	}
	if err := s.StartTrial(ctx, userID, now); err != nil {
		return nil, err
	}
	return s.subs.GetByUserID(ctx, userID)
}

// View builds the GET /api/v1/subscription response.
func (s *SubscriptionService) View(ctx context.Context, userID int64) (*dto.SubscriptionResponse, error) {
	now := time.Now()
	sub, err := s.loadOrStartTrial(ctx, userID, now)
	if err != nil {
		return nil, err
	}

	status, readOnly := DeriveSubscriptionState(sub, now)
	daysLeft := 0
	if !readOnly {
		daysLeft = int(math.Ceil(sub.ExpiresAt.Sub(now).Hours() / 24))
		if daysLeft < 0 {
			daysLeft = 0
		}
	}

	return &dto.SubscriptionResponse{
		Plan:       sub.Plan,
		Status:     status,
		StartedAt:  sub.StartedAt,
		ExpiresAt:  sub.ExpiresAt,
		GraceUntil: sub.GraceUntil,
		DaysLeft:   daysLeft,
		ReadOnly:   readOnly,
	}, nil
}

// ReadOnly reports whether the user's subscription currently forbids writes.
// It is the WritabilityChecker wired into the RequireWritable middleware.
// Unknown states fail open (billing trouble must not brick the product).
func (s *SubscriptionService) ReadOnly(ctx context.Context, userID int64) (bool, error) {
	sub, err := s.subs.GetByUserID(ctx, userID)
	if err != nil {
		return false, err
	}
	if sub == nil {
		return false, nil // no row yet (legacy/backdoor): keep writable
	}
	_, readOnly := DeriveSubscriptionState(sub, time.Now())
	return readOnly, nil
}

// Extend prolongs the subscription by n days from max(now, expires_at) and
// marks it active. Called once per successfully paid order.
func (s *SubscriptionService) Extend(ctx context.Context, userID, orderID int64, n int, now time.Time) error {
	sub, err := s.loadOrStartTrial(ctx, userID, now)
	if err != nil {
		return err
	}

	base := sub.ExpiresAt
	if now.After(base) {
		base = now
	}
	expires := base.Add(days(n))
	grace := expires.Add(days(model.GraceDays))

	sub.Status = model.SubscriptionActive
	sub.ExpiresAt = expires
	sub.GraceUntil = &grace
	sub.LastPaymentOrderID = &orderID
	if err := s.subs.Update(ctx, sub); err != nil {
		return err
	}
	s.logger.Info("subscription extended",
		zap.Int64("user_id", userID),
		zap.Int64("order_id", orderID),
		zap.Int("days", n),
		zap.Time("expires_at", expires))
	return nil
}

// EnsureForExistingUsers backfills a trial subscription for every user that
// has none (demo account + users registered before M3), so legacy accounts
// stay writable. Returns the number of rows created.
func (s *SubscriptionService) EnsureForExistingUsers(ctx context.Context) (int, error) {
	ids, err := s.subs.ListUserIDsMissingSubscription(ctx)
	if err != nil {
		return 0, err
	}
	now := time.Now()
	created := 0
	for _, id := range ids {
		if err := s.StartTrial(ctx, id, now); err != nil {
			s.logger.Error("failed to backfill subscription", zap.Int64("user_id", id), zap.Error(err))
			continue
		}
		created++
	}
	return created, nil
}
