package service

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/pkg/kvstore"
	"github.com/inkbloom/server/internal/repository"
	"github.com/inkbloom/server/internal/service/cache"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

// newTestNovelService builds a NovelService whose stores are backed by an
// on-disk SQLite database and an in-memory cache, mirroring the harness style
// used across the service tests so ownership scoping and the Update path are
// exercised against real repositories.
func newTestNovelService(t *testing.T) (*NovelService, *gorm.DB) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "novel.db") + "?cache=shared"
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := db.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	if err := db.AutoMigrate(&model.Novel{}, &model.Chapter{}); err != nil {
		t.Fatalf("auto-migrate: %v", err)
	}
	cm := cache.NewCacheManager(kvstore.NewMemStore(), zap.NewNop())
	return NewNovelService(repository.NewNovelRepository(db), repository.NewChapterRepository(db), cm), db
}

// seedNovelWithDescription seeds a novel with an optional description pointer
// so UpdateNovel's description branch can be exercised from a known state.
func seedNovelWithDescription(t *testing.T, db *gorm.DB, userID, novelID int64, desc *string) {
	t.Helper()
	novel := &model.Novel{ID: novelID, UserID: userID, Title: "测试作品", Description: desc}
	if err := db.Create(novel).Error; err != nil {
		t.Fatalf("seed novel: %v", err)
	}
}

func TestUpdateNovelDescriptionTooLong(t *testing.T) {
	ctx := context.Background()
	s, db := newTestNovelService(t)
	const userID, novelID = int64(1), int64(100)
	seedNovel(t, db, userID, novelID)

	desc := strings.Repeat("字", DescriptionMaxRunes+1)
	_, err := s.UpdateNovel(ctx, userID, novelID, &dto.UpdateNovelRequest{Description: &desc})
	if !errors.Is(err, ErrDescriptionTooLong) {
		t.Fatalf("expected ErrDescriptionTooLong, got %v", err)
	}
}

func TestUpdateNovelDescriptionWhitespaceNormalized(t *testing.T) {
	ctx := context.Background()
	s, db := newTestNovelService(t)
	const userID, novelID = int64(1), int64(101)
	orig := "原始简介"
	seedNovelWithDescription(t, db, userID, novelID, &orig)

	desc := "   \n\t  "
	got, err := s.UpdateNovel(ctx, userID, novelID, &dto.UpdateNovelRequest{Description: &desc})
	if err != nil {
		t.Fatalf("UpdateNovel: %v", err)
	}
	if got.Description != "" {
		t.Fatalf("expected whitespace-only description to normalize to empty, got %q", got.Description)
	}

	stored, err := s.novelRepo.GetByID(ctx, userID, novelID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if stored.Description != nil {
		t.Fatalf("expected stored Description to be nil, got %q", *stored.Description)
	}
}

func TestUpdateNovelDescriptionTrimmedAndSaved(t *testing.T) {
	ctx := context.Background()
	s, db := newTestNovelService(t)
	const userID, novelID = int64(1), int64(102)
	seedNovel(t, db, userID, novelID)

	desc := "  一段正常简介  "
	got, err := s.UpdateNovel(ctx, userID, novelID, &dto.UpdateNovelRequest{Description: &desc})
	if err != nil {
		t.Fatalf("UpdateNovel: %v", err)
	}
	if got.Description != "一段正常简介" {
		t.Fatalf("expected trimmed description, got %q", got.Description)
	}
}

func TestUpdateNovelDescriptionNilKeepsOriginal(t *testing.T) {
	ctx := context.Background()
	s, db := newTestNovelService(t)
	const userID, novelID = int64(1), int64(103)
	orig := "原始简介"
	seedNovelWithDescription(t, db, userID, novelID, &orig)

	newTitle := "新标题"
	got, err := s.UpdateNovel(ctx, userID, novelID, &dto.UpdateNovelRequest{Title: &newTitle})
	if err != nil {
		t.Fatalf("UpdateNovel: %v", err)
	}
	if got.Description != orig {
		t.Fatalf("expected description unchanged when nil, got %q", got.Description)
	}
}

func TestUpdateNovelDescriptionNotOwnerReturnsNotFound(t *testing.T) {
	ctx := context.Background()
	s, db := newTestNovelService(t)
	const ownerID, novelID = int64(1), int64(104)
	seedNovel(t, db, ownerID, novelID)

	desc := "越权更新"
	_, err := s.UpdateNovel(ctx, int64(999), novelID, &dto.UpdateNovelRequest{Description: &desc})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("expected ErrNotFound for non-owner update, got %v", err)
	}
}
