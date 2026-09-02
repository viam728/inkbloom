package service

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
	"gorm.io/gorm"
)

// newTestAgentContextService builds an AgentContextService whose stores are
// backed by an on-disk SQLite database so the novel description assembly path
// runs against real repositories.
func newTestAgentContextService(t *testing.T) (*AgentContextService, *gorm.DB) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "agentctx.db") + "?cache=shared"
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := db.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	if err := db.AutoMigrate(&model.Novel{}, &model.NovelOutline{}, &model.NovelMemory{}, &model.Chapter{}); err != nil {
		t.Fatalf("auto-migrate: %v", err)
	}
	return NewAgentContextService(
		repository.NewNovelRepository(db),
		repository.NewNovelDocRepository(db),
		repository.NewChapterRepository(db),
	), db
}

func TestBuildAgentContextCarriesNovelDescription(t *testing.T) {
	ctx := context.Background()
	s, db := newTestAgentContextService(t)
	const userID, novelID = int64(1), int64(200)
	desc := "一个关于剑客的故事"
	seedNovelWithDescription(t, db, userID, novelID, &desc)

	payload, err := s.BuildAgentContext(ctx, userID, novelID, "chapter", nil, nil, "写下一章")
	if err != nil {
		t.Fatalf("BuildAgentContext: %v", err)
	}
	if payload.Context.NovelDescription != desc {
		t.Errorf("NovelDescription = %q, want %q", payload.Context.NovelDescription, desc)
	}
}

func TestBuildAgentContextEmptyDescriptionDegrades(t *testing.T) {
	ctx := context.Background()
	s, db := newTestAgentContextService(t)
	const userID, novelID = int64(1), int64(201)
	seedNovel(t, db, userID, novelID)

	payload, err := s.BuildAgentContext(ctx, userID, novelID, "chapter", nil, nil, "写下一章")
	if err != nil {
		t.Fatalf("BuildAgentContext: %v", err)
	}
	if payload.Context.NovelDescription != "" {
		t.Errorf("NovelDescription = %q, want empty string", payload.Context.NovelDescription)
	}
}

func TestBuildAgentContextTruncatesOverlongDescription(t *testing.T) {
	ctx := context.Background()
	s, db := newTestAgentContextService(t)
	const userID, novelID = int64(1), int64(202)
	long := strings.Repeat("字", 900)
	seedNovelWithDescription(t, db, userID, novelID, &long)

	payload, err := s.BuildAgentContext(ctx, userID, novelID, "chapter", nil, nil, "写下一章")
	if err != nil {
		t.Fatalf("BuildAgentContext: %v", err)
	}
	got := payload.Context.NovelDescription
	if n := len([]rune(got)); n != descriptionContextBudget {
		t.Errorf("truncated length = %d runes, want %d", n, descriptionContextBudget)
	}
	if !strings.HasPrefix(long, got) {
		t.Errorf("description is not a prefix-preserving truncation")
	}
}
