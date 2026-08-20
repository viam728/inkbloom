// Package scope provides shared GORM scopes that enforce per-user data
// isolation (M1). Every repository query touching user-owned business tables
// must apply scope.ForUser(uid) — either directly via .Scopes() or through an
// equivalent "user_id = ?" predicate — so no endpoint can read or mutate
// another user's rows.
package scope

import "gorm.io/gorm"

// ForUser returns a GORM scope restricting the query to rows owned by
// userID. Usage: db.Scopes(scope.ForUser(uid)).Find(&rows).
func ForUser(userID int64) func(*gorm.DB) *gorm.DB {
	return func(db *gorm.DB) *gorm.DB {
		return db.Where("user_id = ?", userID)
	}
}
