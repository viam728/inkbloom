package repository

import (
	"context"
	"errors"
	"fmt"
	"time"
	_ "time/tzdata" // embed the tz database so LoadLocation works on Windows hosts

	"github.com/inkbloom/server/internal/model"
	"gorm.io/gorm"
)

// ErrTokenInsufficient is returned by Consume when the combined usable
// balance (paid + unexpired gift) cannot cover the requested units.
var ErrTokenInsufficient = errors.New("token balance insufficient")

// ledgerWriter is shared by the account/ledger repositories: every balance
// mutation appends exactly one ledger row inside the same transaction.
const maxTokenTxRetries = 5

// TokenAccountRepository defines data access for token_accounts. All balance
// mutations are single-transaction "update account + append ledger" units so
// the ledger stays the source of truth (plan doc §5.1).
type TokenAccountRepository interface {
	GetByUserID(ctx context.Context, userID int64) (*model.TokenAccount, error)
	Create(ctx context.Context, acct *model.TokenAccount) error
	// Consume atomically deducts units (unexpired gift first, then paid
	// balance) and appends entry to the ledger. entry.BalanceAfter is
	// populated before insert. Returns ErrTokenInsufficient when the usable
	// balance is too small.
	Consume(ctx context.Context, userID int64, units int64, entry *model.TokenLedger) error
	// Credit atomically adds paid balance (recharge/refund) and appends the
	// ledger entry; total_recharged grows only for reason=recharge.
	Credit(ctx context.Context, userID int64, units int64, entry *model.TokenLedger) error
	// GrantGift atomically adds gift balance with an expiry and appends the
	// ledger entry (used by the registration experience pack).
	GrantGift(ctx context.Context, userID int64, units int64, expiresAt time.Time, entry *model.TokenLedger) error
	// ListUserIDsMissingAccount returns ids of users without a token account
	// row (startup backfill target; no gift is granted for them).
	ListUserIDsMissingAccount(ctx context.Context) ([]int64, error)
}

type tokenAccountRepository struct {
	db *gorm.DB
}

// NewTokenAccountRepository creates a new TokenAccountRepository.
func NewTokenAccountRepository(db *gorm.DB) TokenAccountRepository {
	return &tokenAccountRepository{db: db}
}

func (r *tokenAccountRepository) GetByUserID(ctx context.Context, userID int64) (*model.TokenAccount, error) {
	var acct model.TokenAccount
	if err := r.db.WithContext(ctx).Where("user_id = ?", userID).First(&acct).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &acct, nil
}

func (r *tokenAccountRepository) Create(ctx context.Context, acct *model.TokenAccount) error {
	return r.db.WithContext(ctx).Create(acct).Error
}

// Consume implements the atomic deduction: optimistic-lock retry loop around
// a conditional UPDATE (version guard + CHECK(balance>=0) backstop) plus the
// ledger insert, all in one transaction.
func (r *tokenAccountRepository) Consume(ctx context.Context, userID int64, units int64, entry *model.TokenLedger) error {
	if units <= 0 {
		return errors.New("consume units must be positive")
	}
	for attempt := 0; attempt < maxTokenTxRetries; attempt++ {
		acct, err := r.GetByUserID(ctx, userID)
		if err != nil {
			return err
		}
		if acct == nil {
			return ErrTokenInsufficient
		}

		now := time.Now()
		fromGift := acct.UsableGift(now)
		if fromGift > units {
			fromGift = units
		}
		fromPaid := units - fromGift
		if fromPaid > acct.Balance {
			return ErrTokenInsufficient
		}

		var balanceAfter int64
		txErr := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			res := tx.Model(&model.TokenAccount{}).
				Where("user_id = ? AND version = ?", userID, acct.Version).
				Updates(map[string]interface{}{
					"balance":        gorm.Expr("balance - ?", fromPaid),
					"gift_balance":   gorm.Expr("gift_balance - ?", fromGift),
					"total_consumed": gorm.Expr("total_consumed + ?", units),
					"version":        gorm.Expr("version + 1"),
					"updated_at":     now,
				})
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected != 1 {
				return gorm.ErrRecordNotFound // version conflict: retry
			}
			balanceAfter = (acct.Balance - fromPaid) + (acct.GiftBalance - fromGift)
			entry.UserID = userID
			entry.Direction = model.LedgerDirectionDebit
			entry.Amount = units
			entry.BalanceAfter = balanceAfter
			entry.CreatedAt = now
			return tx.Create(entry).Error
		})

		if txErr == nil {
			return nil
		}
		if errors.Is(txErr, gorm.ErrRecordNotFound) {
			continue // optimistic-lock conflict: reload and retry
		}
		return txErr
	}
	return errors.New("token account busy: too many concurrent balance updates")
}

// Credit atomically adds paid balance and appends the ledger entry.
func (r *tokenAccountRepository) Credit(ctx context.Context, userID int64, units int64, entry *model.TokenLedger) error {
	if units <= 0 {
		return errors.New("credit units must be positive")
	}
	for attempt := 0; attempt < maxTokenTxRetries; attempt++ {
		acct, err := r.GetByUserID(ctx, userID)
		if err != nil {
			return err
		}
		if acct == nil {
			return gorm.ErrRecordNotFound
		}

		now := time.Now()
		updates := map[string]interface{}{
			"balance":    gorm.Expr("balance + ?", units),
			"version":    gorm.Expr("version + 1"),
			"updated_at": now,
		}
		if entry.Reason == model.LedgerReasonRecharge {
			updates["total_recharged"] = gorm.Expr("total_recharged + ?", units)
		}

		var balanceAfter int64
		txErr := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			res := tx.Model(&model.TokenAccount{}).
				Where("user_id = ? AND version = ?", userID, acct.Version).
				Updates(updates)
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected != 1 {
				return gorm.ErrRecordNotFound
			}
			balanceAfter = acct.Balance + units + acct.UsableGift(now)
			entry.UserID = userID
			entry.Direction = model.LedgerDirectionCredit
			entry.Amount = units
			entry.BalanceAfter = balanceAfter
			entry.CreatedAt = now
			return tx.Create(entry).Error
		})

		if txErr == nil {
			return nil
		}
		if errors.Is(txErr, gorm.ErrRecordNotFound) {
			continue
		}
		return txErr
	}
	return errors.New("token account busy: too many concurrent balance updates")
}

// GrantGift atomically adds gift balance with an expiry and appends the
// ledger entry.
func (r *tokenAccountRepository) GrantGift(ctx context.Context, userID int64, units int64, expiresAt time.Time, entry *model.TokenLedger) error {
	if units <= 0 {
		return errors.New("gift units must be positive")
	}
	for attempt := 0; attempt < maxTokenTxRetries; attempt++ {
		acct, err := r.GetByUserID(ctx, userID)
		if err != nil {
			return err
		}
		if acct == nil {
			return gorm.ErrRecordNotFound
		}

		now := time.Now()
		var balanceAfter int64
		txErr := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			res := tx.Model(&model.TokenAccount{}).
				Where("user_id = ? AND version = ?", userID, acct.Version).
				Updates(map[string]interface{}{
					"gift_balance":    gorm.Expr("gift_balance + ?", units),
					"gift_expires_at": expiresAt,
					"version":         gorm.Expr("version + 1"),
					"updated_at":      now,
				})
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected != 1 {
				return gorm.ErrRecordNotFound
			}
			balanceAfter = acct.Balance + acct.GiftBalance + units
			entry.UserID = userID
			entry.Direction = model.LedgerDirectionCredit
			entry.Amount = units
			entry.BalanceAfter = balanceAfter
			entry.CreatedAt = now
			return tx.Create(entry).Error
		})

		if txErr == nil {
			return nil
		}
		if errors.Is(txErr, gorm.ErrRecordNotFound) {
			continue
		}
		return txErr
	}
	return errors.New("token account busy: too many concurrent balance updates")
}

func (r *tokenAccountRepository) ListUserIDsMissingAccount(ctx context.Context) ([]int64, error) {
	var ids []int64
	err := r.db.WithContext(ctx).
		Raw(`SELECT u.id FROM users u LEFT JOIN token_accounts t ON t.user_id = u.id WHERE t.user_id IS NULL`).
		Scan(&ids).Error
	if err != nil {
		return nil, err
	}
	return ids, nil
}

// TokenLedgerRepository defines append-only statement access (token_ledger).
type TokenLedgerRepository interface {
	// ListByUser returns the most recent ledger rows, created_at descending.
	ListByUser(ctx context.Context, userID int64, limit int) ([]model.TokenLedger, error)
	// DailyConsumption is one aggregated consumption bucket.
	// ConsumeSeriesByDay aggregates debit rows into YYYY-MM-DD buckets from
	// `since` onward, rendering bucket keys in the IANA timezone `tz`
	// (task #46: both dialects must agree on day boundaries; gaps are filled
	// by the caller).
	ConsumeSeriesByDay(ctx context.Context, userID int64, since time.Time, tz string) ([]DailyConsumption, error)
	// HasReason reports whether the user has any ledger row of the given
	// reason. Used by the publish service as the user-level fallback for the
	// AIInspired flag (A17): when no chapter-level ai_rewrite signal is
	// available, any past AI call means the author has used generative AI on
	// the platform, so the work is disclosed as AI-inspired. The fallback is
	// imprecise — it can flag a work whose AI edit went into a different
	// piece — and that limitation is documented on the publish service.
	HasReason(ctx context.Context, userID int64, reason string) (bool, error)
}

// DailyConsumption is the consumed total of one calendar day.
type DailyConsumption struct {
	Day      string
	Consumed int64
}

type tokenLedgerRepository struct {
	db *gorm.DB
}

// NewTokenLedgerRepository creates a new TokenLedgerRepository.
func NewTokenLedgerRepository(db *gorm.DB) TokenLedgerRepository {
	return &tokenLedgerRepository{db: db}
}

func (r *tokenLedgerRepository) ListByUser(ctx context.Context, userID int64, limit int) ([]model.TokenLedger, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var rows []model.TokenLedger
	err := r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("created_at DESC, id DESC").
		Limit(limit).
		Find(&rows).Error
	return rows, err
}

func (r *tokenLedgerRepository) HasReason(ctx context.Context, userID int64, reason string) (bool, error) {
	var n int64
	err := r.db.WithContext(ctx).
		Model(&model.TokenLedger{}).
		Where("user_id = ? AND reason = ?", userID, reason).
		Count(&n).Error
	return n > 0, err
}

func (r *tokenLedgerRepository) ConsumeSeriesByDay(ctx context.Context, userID int64, since time.Time, tz string) ([]DailyConsumption, error) {
	if tz == "" {
		tz = "Asia/Shanghai"
	}
	var (
		dayExpr string
		args    []interface{}
	)
	if r.db.Dialector.Name() == "postgres" {
		// PG session timezone is UTC; render bucket keys in the billing
		// timezone explicitly (task #46). The AT TIME ZONE placeholder
		// appears first in the SQL, so tz leads the args list.
		dayExpr = "to_char(created_at AT TIME ZONE ?, 'YYYY-MM-DD')"
		args = []interface{}{tz, userID, model.LedgerDirectionDebit, since}
	} else {
		// SQLite date functions normalize to UTC; shift by the zone's offset
		// at `since` so bucket keys match the PG side (no DST in the
		// default Asia/Shanghai zone, so a fixed offset is exact).
		loc, err := time.LoadLocation(tz)
		if err != nil || loc == nil {
			loc = time.FixedZone("CST", 8*3600)
		}
		_, offset := since.In(loc).Zone()
		modifier := fmt.Sprintf("%+d minutes", offset/60)
		dayExpr = "strftime('%Y-%m-%d', created_at, '" + modifier + "')"
		args = []interface{}{userID, model.LedgerDirectionDebit, since}
	}
	var rows []DailyConsumption
	err := r.db.WithContext(ctx).
		Raw(`SELECT `+dayExpr+` AS day, SUM(amount) AS consumed
			FROM token_ledger
			WHERE user_id = ? AND direction = ? AND created_at >= ?
			GROUP BY 1`, args...).
		Scan(&rows).Error
	return rows, err
}

// TokenOrderRepository defines data access for token_orders.
type TokenOrderRepository interface {
	Create(ctx context.Context, order *model.TokenOrder) error
	GetByOutTradeNo(ctx context.Context, outTradeNo string) (*model.TokenOrder, error)
	// MarkPaid atomically flips created→paid; returns won=false when another
	// caller already paid the order (idempotent delivery guard).
	MarkPaid(ctx context.Context, id int64, at time.Time) (bool, error)
	ListByUser(ctx context.Context, userID int64, limit int) ([]model.TokenOrder, error)
}

type tokenOrderRepository struct {
	db *gorm.DB
}

// NewTokenOrderRepository creates a new TokenOrderRepository.
func NewTokenOrderRepository(db *gorm.DB) TokenOrderRepository {
	return &tokenOrderRepository{db: db}
}

func (r *tokenOrderRepository) Create(ctx context.Context, order *model.TokenOrder) error {
	return r.db.WithContext(ctx).Create(order).Error
}

func (r *tokenOrderRepository) GetByOutTradeNo(ctx context.Context, outTradeNo string) (*model.TokenOrder, error) {
	var order model.TokenOrder
	if err := r.db.WithContext(ctx).Where("out_trade_no = ?", outTradeNo).First(&order).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &order, nil
}

func (r *tokenOrderRepository) MarkPaid(ctx context.Context, id int64, at time.Time) (bool, error) {
	tx := r.db.WithContext(ctx).Model(&model.TokenOrder{}).
		Where("id = ? AND status = ?", id, model.TokenOrderStatusCreated).
		Updates(map[string]interface{}{
			"status":  model.TokenOrderStatusPaid,
			"paid_at": at,
		})
	if tx.Error != nil {
		return false, tx.Error
	}
	return tx.RowsAffected == 1, nil
}

func (r *tokenOrderRepository) ListByUser(ctx context.Context, userID int64, limit int) ([]model.TokenOrder, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	var rows []model.TokenOrder
	err := r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("created_at DESC, id DESC").
		Limit(limit).
		Find(&rows).Error
	return rows, err
}
