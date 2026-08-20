package service

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
	"go.uber.org/zap"
)

// ErrAdminTargetNotFound is returned when an admin action targets a missing
// user/subscription row (mapped to HTTP 404).
var ErrAdminTargetNotFound = errors.New("target user or subscription not found")

// AdminService implements the back-office operations (task #49, M5; plan doc
// §6.6). It reuses the existing billing services instead of duplicating
// their logic: token grants flow through TokenService, subscription state is
// derived by DeriveSubscriptionState.
type AdminService struct {
	admin    repository.AdminRepository
	users    repository.UserRepository
	subs     repository.SubscriptionRepository
	tokenSvc *TokenService
	guard    *UserGuard
	logger   *zap.Logger
}

// NewAdminService creates an AdminService.
func NewAdminService(
	admin repository.AdminRepository,
	users repository.UserRepository,
	subs repository.SubscriptionRepository,
	tokenSvc *TokenService,
	guard *UserGuard,
	logger *zap.Logger,
) *AdminService {
	return &AdminService{admin: admin, users: users, subs: subs, tokenSvc: tokenSvc, guard: guard, logger: logger}
}

// Dashboard builds the dashboard payload. Day counters use the server's
// local midnight boundary (same convention as token stats, task #46).
func (s *AdminService) Dashboard(ctx context.Context) (*dto.AdminDashboard, error) {
	now := time.Now()
	sinceToday := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)

	stats, err := s.admin.Stats(ctx, sinceToday)
	if err != nil {
		return nil, err
	}
	subs, err := s.admin.ListAllSubscriptions(ctx)
	if err != nil {
		return nil, err
	}

	out := &dto.AdminDashboard{
		UsersTotal:         stats.UsersTotal,
		UsersToday:         stats.UsersToday,
		TokenBalanceTotal:  stats.TokenBalanceTotal,
		TokenConsumedToday: stats.TokenConsumedToday,
		NovelsTotal:        stats.NovelsTotal,
		AICallsToday:       stats.AICallsToday,
	}
	for i := range subs {
		status, _ := DeriveSubscriptionState(&subs[i], now)
		switch status {
		case model.SubscriptionActive:
			out.SubsActive++
		case model.SubscriptionTrialing:
			out.SubsTrialing++
		case model.SubscriptionGrace:
			out.SubsGrace++
		}
	}
	return out, nil
}

// ListUsers returns the paginated user list with subscription and token
// balance joined in.
func (s *AdminService) ListUsers(ctx context.Context, search, status string, page, size int) (*dto.AdminUserList, error) {
	total, rows, err := s.admin.ListUsers(ctx, search, status, page, size)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	items := make([]dto.AdminUserItem, 0, len(rows))
	for _, r := range rows {
		item := dto.AdminUserItem{
			ID:                r.ID,
			Phone:             r.Phone,
			Nickname:          r.Nickname,
			Status:            r.Status,
			Role:              r.Role,
			RegisteredChannel: r.RegisteredChannel,
			CreatedAt:         r.CreatedAt,
			LastLoginAt:       r.LastLoginAt,
			TokenBalance:      r.TokenBalance,
		}
		if r.SubStatus != nil {
			sub := &model.Subscription{
				UserID:    r.ID,
				Status:    *r.SubStatus,
				ExpiresAt: time.Time{},
			}
			if r.SubExpiresAt != nil {
				sub.ExpiresAt = *r.SubExpiresAt
			}
			derived, _ := DeriveSubscriptionState(sub, now)
			item.Subscription = &dto.AdminSubscriptionSummary{
				Status:    derived,
				ExpiresAt: r.SubExpiresAt,
			}
		}
		items = append(items, item)
	}
	return &dto.AdminUserList{Total: total, Items: items}, nil
}

// SetUserStatus bans (1) or un-bans (0) a user and drops the cached guard
// entry so the change applies from the very next request.
func (s *AdminService) SetUserStatus(ctx context.Context, operatorID, userID int64, status int16) error {
	user, err := s.users.GetByID(ctx, userID)
	if err != nil {
		return err
	}
	if user == nil {
		return ErrAdminTargetNotFound
	}
	if err := s.users.UpdateStatus(ctx, userID, status); err != nil {
		return err
	}
	if s.guard != nil {
		s.guard.Invalidate(userID)
	}
	s.logger.Info("admin: user status changed",
		zap.Int64("operator_id", operatorID),
		zap.Int64("user_id", userID),
		zap.Int16("status", status))
	return nil
}

// ExtendSubscription prolongs the target's subscription by n days from
// max(now, expires_at) and rewrites the grace window accordingly.
func (s *AdminService) ExtendSubscription(ctx context.Context, operatorID, userID int64, n int) (*model.Subscription, error) {
	sub, err := s.subs.GetByUserID(ctx, userID)
	if err != nil {
		return nil, err
	}
	if sub == nil {
		return nil, ErrAdminTargetNotFound
	}

	now := time.Now()
	base := sub.ExpiresAt
	if now.After(base) {
		base = now
	}
	expires := base.AddDate(0, 0, n)
	grace := expires.AddDate(0, 0, model.GraceDays)
	if err := s.admin.SetSubscriptionExpiry(ctx, userID, expires, grace); err != nil {
		return nil, err
	}

	sub.ExpiresAt = expires
	sub.GraceUntil = &grace
	s.logger.Info("admin: subscription extended",
		zap.Int64("operator_id", operatorID),
		zap.Int64("user_id", userID),
		zap.Int("days", n),
		zap.Time("expires_at", expires))
	return sub, nil
}

// GrantTokens credits tokens through the existing TokenService (atomic
// account update + ledger row), recorded as reason=admin_grant.
func (s *AdminService) GrantTokens(ctx context.Context, operatorID, userID, amount int64, note string) error {
	user, err := s.users.GetByID(ctx, userID)
	if err != nil {
		return err
	}
	if user == nil {
		return ErrAdminTargetNotFound
	}

	if len(note) > 60 {
		note = note[:60]
	}
	refType := "admin_note"
	meta := ConsumeMeta{Reason: model.LedgerReasonAdminGrant, RefType: &refType}
	if note != "" {
		meta.RefID = &note
	}
	if err := s.tokenSvc.Refund(ctx, userID, amount, meta); err != nil {
		return err
	}
	s.logger.Info("admin: tokens granted",
		zap.Int64("operator_id", operatorID),
		zap.Int64("user_id", userID),
		zap.Int64("amount", amount),
		zap.String("note", note))
	return nil
}

// ListOrders merges payment_orders (subscription) and token_orders in
// created_at descending order. kind filters one source ("subscription" |
// "token"); empty returns both merged.
func (s *AdminService) ListOrders(ctx context.Context, kind string, limit int) ([]dto.AdminOrderItem, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var items []dto.AdminOrderItem

	if kind == "" || kind == model.OrderKindSubscription {
		rows, err := s.admin.ListPaymentOrders(ctx, limit)
		if err != nil {
			return nil, err
		}
		for _, o := range rows {
			items = append(items, dto.AdminOrderItem{
				Kind:        "subscription",
				ID:          o.ID,
				UserID:      o.UserID,
				AmountCents: o.AmountCents,
				Status:      o.Status,
				Channel:     o.Channel,
				OutTradeNo:  o.OutTradeNo,
				CreatedAt:   o.CreatedAt,
				PaidAt:      o.PaidAt,
			})
		}
	}
	if kind == "" || kind == "token" {
		rows, err := s.admin.ListTokenOrders(ctx, limit)
		if err != nil {
			return nil, err
		}
		for _, o := range rows {
			items = append(items, dto.AdminOrderItem{
				Kind:        "token",
				ID:          o.ID,
				UserID:      o.UserID,
				AmountCents: o.AmountCents,
				Tokens:      o.Tokens,
				Status:      o.Status,
				Channel:     o.Channel,
				OutTradeNo:  o.OutTradeNo,
				CreatedAt:   o.CreatedAt,
				PaidAt:      o.PaidAt,
			})
		}
	}

	sort.Slice(items, func(i, j int) bool {
		if !items[i].CreatedAt.Equal(items[j].CreatedAt) {
			return items[i].CreatedAt.After(items[j].CreatedAt)
		}
		return items[i].Kind < items[j].Kind
	})
	if len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}
