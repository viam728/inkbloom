package repository

import (
	"context"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/inkbloom/server/internal/model"
	"gorm.io/gorm"
)

// UpsertDaily 的 ON CONFLICT 表达式为了绕开 Postgres 的 SQLSTATE 42702（裸列名
// 与 EXCLUDED 伪表歧义）用了表名限定。SQLite 的 UPSERT 只允许限定名出现在
// SET 右侧……两侧都限定时必须以标识符引号包裹，而 GORM 生成的正是带引号形式。
// 这里用真实的 SQLite 跑一遍累加，锁死「改了限定写法不会把 local 模式打挂」。
func TestTokenUsageUpsertDailyAccumulates(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:token_usage_test?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.AutoMigrate(&model.TokenUsageDaily{}); err != nil {
		t.Fatalf("automigrate: %v", err)
	}

	repo := NewTokenUsageRepository(db)
	ctx := context.Background()
	if err := repo.UpsertDaily(ctx, 1, "2026-09-03", 5, 1, 2); err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	if err := repo.UpsertDaily(ctx, 1, "2026-09-03", 7, 2, 3); err != nil {
		t.Fatalf("second upsert (conflict path): %v", err)
	}
	// 不同用户/不同日期互不影响
	if err := repo.UpsertDaily(ctx, 2, "2026-09-03", 9, 0, 0); err != nil {
		t.Fatalf("other user upsert: %v", err)
	}

	list, err := repo.ListDaily(ctx, 1, 30)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("want 1 row for user 1, got %d", len(list))
	}
	got := list[0]
	if got.TextUnits != 12 || got.ImageCount != 3 || got.ImageUnits != 5 {
		t.Fatalf("accumulate mismatch: text=%d image_count=%d image_units=%d, want 12/3/5",
			got.TextUnits, got.ImageCount, got.ImageUnits)
	}
}
