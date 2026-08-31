package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/inkbloom/server/internal/middleware"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
	"go.uber.org/zap"
)

// Token billing service (task #43, M4; product-commercialization-plan §5).
// AI entitlements depend ONLY on the token balance — this service never
// consults the subscription state (the two systems stay decoupled).

// ErrInvalidTokenPack is returned for unknown recharge packs.
var ErrInvalidTokenPack = errors.New("invalid token pack")

// ErrInvalidTokenChannel is returned for unsupported payment channels.
var ErrInvalidTokenChannel = errors.New("支付通道暂未开放")

// ErrTokenInsufficient is re-exported from the repository layer so handlers
// can map balance failures to HTTP 402 without importing repository.
var ErrTokenInsufficient = repository.ErrTokenInsufficient

// TokenStatsTimezone is the IANA timezone used to render stats day buckets
// (task #46: the SQL day-bucket expression and the Go-side bucket
// backfill must agree on day boundaries). Configurable; defaults to the
// product's target locale.
var TokenStatsTimezone = "Asia/Shanghai"

// statsLocation resolves TokenStatsTimezone to a *time.Location, falling
// back to a fixed UTC+8 zone so stats never crash on a bad zone name.
func statsLocation() *time.Location {
	loc, err := time.LoadLocation(TokenStatsTimezone)
	if err != nil || loc == nil {
		return time.FixedZone("CST", 8*3600)
	}
	return loc
}

// ConsumeMeta carries the billing context recorded on the ledger entry.
type ConsumeMeta struct {
	Reason           string  // ai_call | image_gen | refund | ...
	Model            *string // upstream model name, optional
	PromptTokens     *int    // upstream usage, optional
	CompletionTokens *int    // upstream usage, optional
	Endpoint         *string // upstream endpoint path
	RefType          *string // task | order | ...
	RefID            *string // external reference id
}

// TokenService orchestrates token account mutations, ledger reads and
// recharge orders. Every balance mutation is delegated to the repository
// layer, which applies it atomically (single transaction: conditional
// account update with an optimistic-lock version guard plus the ledger
// insert).
type TokenService struct {
	accounts repository.TokenAccountRepository
	ledger   repository.TokenLedgerRepository
	orders   repository.TokenOrderRepository
	usage    repository.TokenUsageRepository
	logger   *zap.Logger
}

// NewTokenService creates a new TokenService.
func NewTokenService(
	accounts repository.TokenAccountRepository,
	ledger repository.TokenLedgerRepository,
	orders repository.TokenOrderRepository,
	usage repository.TokenUsageRepository,
	logger *zap.Logger,
) *TokenService {
	return &TokenService{accounts: accounts, ledger: ledger, orders: orders, usage: usage, logger: logger}
}

// tokenPackSpec binds a pack name to its price and granted units.
type tokenPackSpec struct {
	amountCents int
	tokens      int64
}

var tokenPackSpecs = map[string]tokenPackSpec{
	model.TokenPackStandard: {amountCents: 990, tokens: 3_000_000},
	model.TokenPackPro:      {amountCents: 2590, tokens: 10_000_000},
}

// Balance returns the account for the user, lazily creating an empty one so
// every authenticated user always sees a balance payload.
func (s *TokenService) Balance(ctx context.Context, userID int64) (*model.TokenAccount, error) {
	acct, err := s.accounts.GetByUserID(ctx, userID)
	if err != nil {
		return nil, err
	}
	if acct == nil {
		acct = &model.TokenAccount{UserID: userID}
		if err := s.accounts.Create(ctx, acct); err != nil {
			// Lost a race to a concurrent creator: reload instead.
			if existing, loadErr := s.accounts.GetByUserID(ctx, userID); loadErr == nil && existing != nil {
				return existing, nil
			}
			return nil, err
		}
	}
	return acct, nil
}

// CanConsume reports whether the usable balance covers units (pre-check used
// by AI endpoints before calling upstream).
func (s *TokenService) CanConsume(ctx context.Context, userID int64, units int64) (bool, error) {
	acct, err := s.Balance(ctx, userID)
	if err != nil {
		return false, err
	}
	return acct.UsableBalance(time.Now()) >= units, nil
}

// Consume atomically deducts units from the user account (unexpired gift
// first, then paid balance) and appends the ledger entry. Returns
// ErrTokenInsufficient when the usable balance cannot cover the units.
func (s *TokenService) Consume(ctx context.Context, userID int64, units int64, meta ConsumeMeta) error {
	if units <= 0 {
		return errors.New("consume units must be positive")
	}
	entry := &model.TokenLedger{
		Reason:           meta.Reason,
		Model:            meta.Model,
		PromptTokens:     meta.PromptTokens,
		CompletionTokens: meta.CompletionTokens,
		Endpoint:         meta.Endpoint,
		RefType:          meta.RefType,
		RefID:            meta.RefID,
	}
	if entry.Reason == "" {
		entry.Reason = model.LedgerReasonAICall
	}
	// v2 §8.1: observe the deduction for the /metrics endpoint counter.
	if meta.Endpoint != nil {
		middleware.ObserveTokenConsume(*meta.Endpoint, units)
	}
	if err := s.accounts.Consume(ctx, userID, units, entry); err != nil {
		return err
	}
	// T3 (plan A30): accumulate the daily usage aggregate. Best effort — a
	// failed aggregation must not fail the deduction itself.
	if s.usage != nil {
		if err := s.recordDailyUsage(ctx, userID, units, meta); err != nil {
			s.logger.Warn("daily usage aggregation failed", zap.Int64("user_id", userID), zap.Error(err))
		}
	}
	return nil
}

// recordDailyUsage writes one day-bucket increment for a deduction. Image
// generations go to the image counters; everything else counts as text.
func (s *TokenService) recordDailyUsage(ctx context.Context, userID, units int64, meta ConsumeMeta) error {
	date := time.Now().In(statsLocation()).Format("2006-01-02")
	if meta.Reason == model.LedgerReasonImageGen {
		return s.usage.UpsertDaily(ctx, userID, date, 0, 1, units)
	}
	return s.usage.UpsertDaily(ctx, userID, date, units, 0, 0)
}

// UnitsFromUsage converts an upstream usage block into deduction units:
// input x1 + output x2 (plan doc §5.2).
func UnitsFromUsage(promptTokens, completionTokens int) int64 {
	return int64(promptTokens)*model.UnitPriceInput + int64(completionTokens)*model.UnitPriceOutput
}

// Refund returns units to the paid balance as compensation (e.g. a failed
// image-generation submission). Recorded as reason=refund, which does not
// inflate total_recharged.
func (s *TokenService) Refund(ctx context.Context, userID int64, units int64, meta ConsumeMeta) error {
	if units <= 0 {
		return errors.New("refund units must be positive")
	}
	entry := &model.TokenLedger{
		Reason:   meta.Reason,
		Model:    meta.Model,
		Endpoint: meta.Endpoint,
		RefType:  meta.RefType,
		RefID:    meta.RefID,
	}
	if entry.Reason == "" {
		entry.Reason = model.LedgerReasonRefund
	}
	return s.accounts.Credit(ctx, userID, units, entry)
}

// Ledger returns the most recent statement rows, created_at descending.
func (s *TokenService) Ledger(ctx context.Context, userID int64, limit int) ([]model.TokenLedger, error) {
	return s.ledger.ListByUser(ctx, userID, limit)
}

// DailyUsage returns the recent daily consumption aggregates (plan A30),
// ordered oldest-first for chart rendering.
func (s *TokenService) DailyUsage(ctx context.Context, userID int64, days int) ([]model.TokenUsageDaily, error) {
	if s.usage == nil {
		return []model.TokenUsageDaily{}, nil
	}
	list, err := s.usage.ListDaily(ctx, userID, days)
	if err != nil {
		return nil, err
	}
	for i, j := 0, len(list)-1; i < j; i, j = i+1, j-1 {
		list[i], list[j] = list[j], list[i]
	}
	return list, nil
}

// StatsPoint is one aggregated consumption bucket of the stats series.
type StatsPoint struct {
	Bucket   string `json:"bucket"` // YYYY-MM-DD (day, or the week/month start)
	Consumed int64  `json:"consumed"`
}

// StatsResult is the stats endpoint payload.
type StatsResult struct {
	Total  int64        `json:"total"`
	Series []StatsPoint `json:"series"`
}

// Stats aggregates debits into buckets: range=day → last 14 days,
// range=week → last 8 ISO weeks (bucket = Monday), range=month → last 6
// months (bucket = first day). Missing buckets are filled with 0.
func (s *TokenService) Stats(ctx context.Context, userID int64, rng string) (*StatsResult, error) {
	// Task #46: render every bucket boundary in the billing timezone so the
	// SQL day keys and the Go-side backfill never disagree (previously the
	// SQL side used the UTC session zone while the backfill used time.Local,
	// shifting 00:00–08:00 consumption into the previous day's bucket).
	loc := statsLocation()
	now := time.Now().In(loc)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)

	var buckets []time.Time
	switch rng {
	case "day":
		for i := 13; i >= 0; i-- {
			buckets = append(buckets, today.AddDate(0, 0, -i))
		}
	case "week":
		// Monday of the current week.
		monday := today.AddDate(0, 0, -int((int(today.Weekday())+6)%7))
		for i := 7; i >= 0; i-- {
			buckets = append(buckets, monday.AddDate(0, 0, -7*i))
		}
	case "month":
		first := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, loc)
		for i := 5; i >= 0; i-- {
			buckets = append(buckets, first.AddDate(0, -i, 0))
		}
	default:
		return nil, errors.New("invalid stats range")
	}

	days, err := s.ledger.ConsumeSeriesByDay(ctx, userID, buckets[0], TokenStatsTimezone)
	if err != nil {
		return nil, err
	}
	byDay := make(map[string]int64, len(days))
	for _, d := range days {
		byDay[d.Day] = d.Consumed
	}

	res := &StatsResult{Series: make([]StatsPoint, 0, len(buckets))}
	switch rng {
	case "day":
		for _, b := range buckets {
			c := byDay[b.Format("2006-01-02")]
			res.Series = append(res.Series, StatsPoint{Bucket: b.Format("2006-01-02"), Consumed: c})
			res.Total += c
		}
	case "week":
		for _, b := range buckets {
			var consumed int64
			for i := 0; i < 7; i++ {
				consumed += byDay[b.AddDate(0, 0, i).Format("2006-01-02")]
			}
			res.Series = append(res.Series, StatsPoint{Bucket: b.Format("2006-01-02"), Consumed: consumed})
			res.Total += consumed
		}
	case "month":
		for i, b := range buckets {
			end := b.AddDate(0, 1, 0)
			if i == len(buckets)-1 {
				end = today.AddDate(0, 0, 1) // last bucket: up to today inclusive
			}
			var consumed int64
			for d := b; d.Before(end); d = d.AddDate(0, 0, 1) {
				consumed += byDay[d.Format("2006-01-02")]
			}
			res.Series = append(res.Series, StatsPoint{Bucket: b.Format("2006-01-02"), Consumed: consumed})
			res.Total += consumed
		}
	}
	return res, nil
}

// CreateOrder creates a recharge order. The sandbox channel pays instantly
// (atomic created→paid flip, then credit; the flip guarantees a single
// delivery even under concurrent callbacks). Other channels are rejected.
func (s *TokenService) CreateOrder(ctx context.Context, userID int64, pack, channel string) (*model.TokenOrder, error) {
	spec, ok := tokenPackSpecs[pack]
	if !ok {
		return nil, ErrInvalidTokenPack
	}
	if channel != model.TokenOrderChannelSandbox {
		return nil, ErrInvalidTokenChannel
	}

	// Make sure the account exists before crediting.
	if _, err := s.Balance(ctx, userID); err != nil {
		return nil, err
	}

	order := &model.TokenOrder{
		UserID:      userID,
		Pack:        pack,
		Tokens:      spec.tokens,
		AmountCents: spec.amountCents,
		Channel:     channel,
		OutTradeNo:  newOutTradeNo(),
		Status:      model.TokenOrderStatusCreated,
	}
	if err := s.orders.Create(ctx, order); err != nil {
		return nil, err
	}

	if channel == model.TokenOrderChannelSandbox {
		if err := s.deliverOrder(ctx, order); err != nil {
			return nil, err
		}
	}
	return order, nil
}

// deliverOrder atomically marks the order paid and credits the tokens. The
// MarkPaid flip is the single-delivery guard: only the winner credits.
func (s *TokenService) deliverOrder(ctx context.Context, order *model.TokenOrder) error {
	now := time.Now()
	won, err := s.orders.MarkPaid(ctx, order.ID, now)
	if err != nil {
		return err
	}
	if !won {
		return nil // already delivered (idempotent)
	}
	outTradeNo := order.OutTradeNo
	refType := model.LedgerRefTypeOrder
	entry := &model.TokenLedger{
		Reason:  model.LedgerReasonRecharge,
		RefType: &refType,
		RefID:   &outTradeNo,
	}
	if err := s.accounts.Credit(ctx, order.UserID, order.Tokens, entry); err != nil {
		return fmt.Errorf("credit tokens for order %s: %w", order.OutTradeNo, err)
	}
	order.Status = model.TokenOrderStatusPaid
	order.PaidAt = &now
	return nil
}

// ListOrders returns the most recent recharge orders, created_at descending.
func (s *TokenService) ListOrders(ctx context.Context, userID int64, limit int) ([]model.TokenOrder, error) {
	return s.orders.ListByUser(ctx, userID, limit)
}

// GrantTrialGift grants the registration experience pack (500k units, valid
// 90 days). Best-effort at call sites: the account row is created first so
// the gift never lands on a missing account.
func (s *TokenService) GrantTrialGift(ctx context.Context, userID int64) error {
	if _, err := s.Balance(ctx, userID); err != nil {
		return err
	}
	expiresAt := time.Now().AddDate(0, 0, model.GiftValidDays)
	reason := model.LedgerReasonGift
	entry := &model.TokenLedger{Reason: reason}
	return s.accounts.GrantGift(ctx, userID, model.TrialGiftUnits, expiresAt, entry)
}

// EnsureAccounts creates empty token accounts for users that have none
// (demo account + users registered before M4). No experience pack is
// granted here to avoid double issuance. Returns the number of rows created.
func (s *TokenService) EnsureAccounts(ctx context.Context) (int, error) {
	ids, err := s.accounts.ListUserIDsMissingAccount(ctx)
	if err != nil {
		return 0, err
	}
	created := 0
	for _, id := range ids {
		if err := s.accounts.Create(ctx, &model.TokenAccount{UserID: id}); err != nil {
			s.logger.Error("failed to backfill token account", zap.Int64("user_id", id), zap.Error(err))
			continue
		}
		created++
	}
	return created, nil
}
