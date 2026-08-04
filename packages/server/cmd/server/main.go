package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/inkbloom/server/internal/config"
	"github.com/inkbloom/server/internal/database"
	"github.com/inkbloom/server/internal/handler"
	"github.com/inkbloom/server/internal/pkg/breaker"
	"github.com/inkbloom/server/internal/pkg/dlock"
	"github.com/inkbloom/server/internal/repository"
	"github.com/inkbloom/server/internal/server"
	"github.com/inkbloom/server/internal/service"
	"github.com/inkbloom/server/internal/service/cache"
	"github.com/inkbloom/server/internal/service/format"
	"github.com/inkbloom/server/internal/service/task_engine"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
	"golang.org/x/sync/errgroup"
)

func main() {
	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to load config: %v\n", err)
		os.Exit(1)
	}

	// Initialize logger
	logger, err := initLogger(cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to init logger: %v\n", err)
		os.Exit(1)
	}
	defer logger.Sync()

	sugar := logger.Sugar()
	sugar.Infof("starting inkbloom server (mode=%s, port=%d)", cfg.Server.Mode, cfg.Server.Port)

	// Initialize database connection
	db, err := database.NewPostgresDB(cfg, logger)
	if err != nil {
		sugar.Fatalf("failed to connect to database: %v", err)
	}
	sqlDB, _ := db.DB()
	defer sqlDB.Close()

	// Initialize Redis
	rdb, err := initRedis(cfg)
	if err != nil {
		sugar.Fatalf("failed to connect to redis: %v", err)
	}
	defer rdb.Close()

	// Initialize Cache Manager
	cacheMgr := cache.NewCacheManager(rdb, logger)

	// Initialize NATS
	natsMgr, err := server.NewNATSManager(cfg.NATS.URL, logger)
	if err != nil {
		sugar.Fatalf("failed to connect to NATS: %v", err)
	}
	defer natsMgr.Close()

	if err := natsMgr.CreateStreams(); err != nil {
		sugar.Fatalf("failed to create NATS streams: %v", err)
	}

	// Initialize WebSocket Hub
	wsHub := server.NewWSHub(logger)

	// Initialize NATS→WebSocket Bridge
	bridge := server.NewNATSWsBridge(natsMgr, wsHub, logger)

	// Initialize repositories
	novelRepo := repository.NewNovelRepository(db)
	chapterRepo := repository.NewChapterRepository(db)
	volumeRepo := repository.NewVolumeRepository(db)
	knowledgeRepo := repository.NewKnowledgeRepository(db)
	taskRepo := repository.NewTaskRepository(db)
	assetRepo := repository.NewAssetRepository(db)
	docRepo := repository.NewNovelDocRepository(db)
	mediaRepo := repository.NewMediaRepository(db)

	// Initialize services
	novelService := service.NewNovelService(novelRepo, chapterRepo, cacheMgr, docRepo)
	chapterService := service.NewChapterService(chapterRepo, novelRepo, cacheMgr)
	volumeService := service.NewVolumeService(volumeRepo)
	knowledgeService := service.NewKnowledgeService(knowledgeRepo, cfg.AIService.URL)
	aiContextBuilder := service.NewAIContextBuilder(chapterRepo, novelRepo, db, logger)
	docService := service.NewNovelDocService(novelRepo, docRepo, chapterRepo)
	mediaService := service.NewMediaService(mediaRepo)

	// Initialize handlers
	novelHandler := handler.NewNovelHandler(novelService)
	chapterHandler := handler.NewChapterHandler(chapterService)
	volumeHandler := handler.NewVolumeHandler(volumeService)
	aiBreaker := breaker.NewBreaker("ai_upstream", 20, 10, 30*time.Second)
	aiHandler := handler.NewAIHandler(cfg.AIService.URL, aiContextBuilder, logger, handler.WithAIBreaker(aiBreaker))
	knowledgeHandler := handler.NewKnowledgeHandler(knowledgeService)
	docHandler := handler.NewNovelDocHandler(docService)
	mediaHandler := handler.NewMediaHandler(mediaService)

	// Initialize distributed task engine components
	distributedLock := dlock.NewDistributedLock(rdb, logger)
	taskBreaker := breaker.NewBreaker("task_execution", 50, 10, 30*time.Second)
	engine := task_engine.NewTaskEngine(db, rdb, natsMgr, distributedLock, taskRepo, taskBreaker, logger, 4)
	outboxPub := task_engine.NewOutboxPublisher(db, natsMgr, logger)
	taskAPIHandler := handler.NewTaskAPIHandler(engine, taskRepo)

	// Register AIGC image task handler
	imageHandler := task_engine.NewImageTaskHandler(cfg.AIService.URL, assetRepo, logger)
	engine.RegisterHandler(imageHandler)

	// AIGC HTTP handler
	aigcHandler := handler.NewAIGCHandler(engine, assetRepo, handler.WithTaskRepo(taskRepo), handler.WithAIGCLogger(logger))

	// Initialize format engine with all renderers
	formatEngine := format.NewFormatEngine()
	formatEngine.RegisterRenderer(format.NewMarkdownRenderer())
	formatEngine.RegisterRenderer(format.NewHTMLRenderer())
	formatEngine.RegisterRenderer(format.NewWechatRenderer())
	formatEngine.RegisterRenderer(format.NewZhihuRenderer())
	formatEngine.RegisterRenderer(format.NewQidianRenderer())
	formatHandler := handler.NewFormatHandler(formatEngine)
	exportHandler := handler.NewExportHandler(chapterRepo, novelRepo, formatEngine)

	// Create HTTP server with handlers
	httpServer := server.New(cfg, logger, server.Handlers{
		Novel:     novelHandler,
		Chapter:   chapterHandler,
		Volume:    volumeHandler,
		AI:        aiHandler,
		Task:      taskAPIHandler,
		AIGC:      aigcHandler,
		Knowledge: knowledgeHandler,
		Format:    formatHandler,
		Export:    exportHandler,
		Doc:       docHandler,
		Media:     mediaHandler,
		WSHub:     wsHub,
	})
	addr := fmt.Sprintf(":%d", cfg.Server.Port)

	// errgroup for orchestration + signal handling
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	g, gctx := errgroup.WithContext(ctx)

	// Start task engine
	g.Go(func() error {
		return engine.Start(gctx)
	})

	// Start outbox publisher
	g.Go(func() error {
		return outboxPub.Start(gctx)
	})

	// Start WebSocket Hub
	g.Go(func() error {
		wsHub.Run(gctx)
		return nil
	})

	// Start NATS→WebSocket Bridge
	g.Go(func() error {
		return bridge.Start(gctx)
	})

	// Start HTTP server
	g.Go(func() error {
		sugar.Infof("HTTP server listening on %s", addr)
		return httpServer.Start(addr)
	})

	// Wait for shutdown signal
	g.Go(func() error {
		<-gctx.Done()
		sugar.Info("shutdown signal received, shutting down gracefully...")
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), cfg.Server.ShutdownTimeout)
		defer shutdownCancel()
		return httpServer.Shutdown(shutdownCtx)
	})

	if err := g.Wait(); err != nil {
		sugar.Fatalf("server exited with error: %v", err)
	}
	sugar.Info("server stopped")
}

func initLogger(cfg *config.Config) (*zap.Logger, error) {
	level, err := zap.ParseAtomicLevel(cfg.Log.Level)
	if err != nil {
		return nil, fmt.Errorf("invalid log level %q: %w", cfg.Log.Level, err)
	}

	zapCfg := zap.NewProductionConfig()
	zapCfg.Level = level
	if cfg.Log.Format == "console" {
		zapCfg.Encoding = "console"
	}

	return zapCfg.Build()
}

func initRedis(cfg *config.Config) (*redis.Client, error) {
	opts, err := redis.ParseURL(cfg.Redis.URL)
	if err != nil {
		return nil, fmt.Errorf("parse redis URL: %w", err)
	}

	rdb := redis.NewClient(opts)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := rdb.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("redis ping: %w", err)
	}

	return rdb, nil
}
