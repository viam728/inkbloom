package repository

import (
	"context"
	"time"

	"github.com/inkbloom/server/internal/model"
	"gorm.io/gorm"
)

// AdminStats is the raw dashboard aggregation (subscription state counts are
// derived by the service layer so the time-driven state machine stays in one
// place).
type AdminStats struct {
	UsersTotal         int64
	UsersToday         int64
	TokenBalanceTotal  int64
	TokenConsumedToday int64
	NovelsTotal        int64
	AICallsToday       int64
}

// AdminUserRow is one joined row of the admin user list.
type AdminUserRow struct {
	ID                int64
	Phone             string
	Nickname          string
	Status            int16
	Role              int16
	RegisteredChannel string
	CreatedAt         time.Time
	LastLoginAt       *time.Time
	SubStatus         *string
	SubExpiresAt      *time.Time
	TokenBalance      int64
}

// AdminRepository defines data access for the back-office endpoints
// (task #49, M5). All queries are read-only except status flips and the
// subscription extension, which the service layer orchestrates.
type AdminRepository interface {
	// Stats aggregates dashboard counters since today's local midnight.
	Stats(ctx context.Context, sinceToday time.Time) (*AdminStats, error)
	// ListAllSubscriptions returns every subscription row so the service can
	// derive effective states (trialing/active/grace/dormant) consistently.
	ListAllSubscriptions(ctx context.Context) ([]model.Subscription, error)
	// ListUsers returns the filtered, paginated user list joined with the
	// subscription and token balance.
	ListUsers(ctx context.Context, search string, status string, page, size int) (int64, []AdminUserRow, error)
	// SetSubscriptionExpiry rewrites expires_at/grace_until (admin extend).
	SetSubscriptionExpiry(ctx context.Context, userID int64, expiresAt, graceUntil time.Time) error
	ListPaymentOrders(ctx context.Context, limit int) ([]model.PaymentOrder, error)
	ListTokenOrders(ctx context.Context, limit int) ([]model.TokenOrder, error)
}

type adminRepository struct {
	db *gorm.DB
}

// NewAdminRepository creates a new AdminRepository.
func NewAdminRepository(db *gorm.DB) AdminRepository {
	return &adminRepository{db: db}
}

func (r *adminRepository) Stats(ctx context.Context, sinceToday time.Time) (*AdminStats, error) {
	var s AdminStats
	db := r.db.WithContext(ctx)

	if err := db.Raw(`SELECT COUNT(*) FROM users`).Scan(&s.UsersTotal).Error; err != nil {
		return nil, err
	}
	if err := db.Raw(`SELECT COUNT(*) FROM users WHERE created_at >= ?`, sinceToday).
		Scan(&s.UsersToday).Error; err != nil {
		return nil, err
	}
	if err := db.Raw(`SELECT COALESCE(SUM(balance),0) + COALESCE(SUM(gift_balance),0) FROM token_accounts`).
		Scan(&s.TokenBalanceTotal).Error; err != nil {
		return nil, err
	}
	if err := db.Raw(
		`SELECT COALESCE(SUM(amount),0) FROM token_ledger WHERE direction = ? AND created_at >= ?`,
		model.LedgerDirectionDebit, sinceToday).
		Scan(&s.TokenConsumedToday).Error; err != nil {
		return nil, err
	}
	if err := db.Raw(`SELECT COUNT(*) FROM novels`).Scan(&s.NovelsTotal).Error; err != nil {
		return nil, err
	}
	// ai_calls_today approximates AI activity by today's debit ledger rows
	// (task #49: explicit approximation allowed).
	if err := db.Raw(
		`SELECT COUNT(*) FROM token_ledger WHERE direction = ? AND created_at >= ?`,
		model.LedgerDirectionDebit, sinceToday).
		Scan(&s.AICallsToday).Error; err != nil {
		return nil, err
	}
	return &s, nil
}

func (r *adminRepository) ListAllSubscriptions(ctx context.Context) ([]model.Subscription, error) {
	var subs []model.Subscription
	err := r.db.WithContext(ctx).Find(&subs).Error
	return subs, err
}

func (r *adminRepository) ListUsers(ctx context.Context, search string, status string, page, size int) (int64, []AdminUserRow, error) {
	if size <= 0 || size > 100 {
		size = 20
	}
	if page <= 0 {
		page = 1
	}

	var where []string
	var args []interface{}
	if search != "" {
		// Phone/nickname fuzzy match + exact uid match (CAST is portable
		// across PostgreSQL and SQLite).
		where = append(where, `(u.phone LIKE ? OR u.nickname LIKE ? OR CAST(u.id AS TEXT) = ?)`)
		like := "%" + search + "%"
		args = append(args, like, like, search)
	}
	switch status {
	case "", "all":
	case "active":
		where = append(where, `u.status = 0`)
	case "disabled":
		where = append(where, `u.status <> 0`)
	default:
		where = append(where, `u.status = ?`)
		args = append(args, status)
	}
	whereSQL := ""
	if len(where) > 0 {
		for i, clause := range where {
			if i == 0 {
				whereSQL = " WHERE " + clause
			} else {
				whereSQL += " AND " + clause
			}
		}
	}

	var total int64
	if err := r.db.WithContext(ctx).
		Raw(`SELECT COUNT(*) FROM users u`+whereSQL, args...).
		Scan(&total).Error; err != nil {
		return 0, nil, err
	}

	var rows []AdminUserRow
	err := r.db.WithContext(ctx).
		Raw(`SELECT u.id, COALESCE(u.phone, '') AS phone, u.nickname, u.status, u.role,
			u.registered_channel, u.created_at, u.last_login_at,
			s.status AS sub_status, s.expires_at AS sub_expires_at,
			COALESCE(ta.balance, 0) + COALESCE(ta.gift_balance, 0) AS token_balance
			FROM users u
			LEFT JOIN subscriptions s ON s.user_id = u.id
			LEFT JOIN token_accounts ta ON ta.user_id = u.id`+
			whereSQL+
			` ORDER BY u.id DESC LIMIT ? OFFSET ?`,
			append(args, size, (page-1)*size)...).
		Scan(&rows).Error
	if err != nil {
		return 0, nil, err
	}
	return total, rows, nil
}

func (r *adminRepository) SetSubscriptionExpiry(ctx context.Context, userID int64, expiresAt, graceUntil time.Time) error {
	res := r.db.WithContext(ctx).Model(&model.Subscription{}).
		Where("user_id = ?", userID).
		Updates(map[string]interface{}{
			"expires_at":  expiresAt,
			"grace_until": graceUntil,
			"updated_at":  time.Now(),
		})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func (r *adminRepository) ListPaymentOrders(ctx context.Context, limit int) ([]model.PaymentOrder, error) {
	var rows []model.PaymentOrder
	err := r.db.WithContext(ctx).
		Order("created_at DESC, id DESC").
		Limit(limit).
		Find(&rows).Error
	return rows, err
}

func (r *adminRepository) ListTokenOrders(ctx context.Context, limit int) ([]model.TokenOrder, error) {
	var rows []model.TokenOrder
	err := r.db.WithContext(ctx).
		Order("created_at DESC, id DESC").
		Limit(limit).
		Find(&rows).Error
	return rows, err
}
