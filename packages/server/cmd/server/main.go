package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/inkbloom/server/internal/config"
	"github.com/inkbloom/server/internal/database"
	"github.com/inkbloom/server/internal/handler"
	"github.com/inkbloom/server/internal/middleware"
	"github.com/inkbloom/server/internal/pkg/authtoken"
	"github.com/inkbloom/server/internal/pkg/breaker"
	"github.com/inkbloom/server/internal/pkg/contentsafety"
	"github.com/inkbloom/server/internal/pkg/dlock"
	"github.com/inkbloom/server/internal/pkg/kvstore"
	"github.com/inkbloom/server/internal/pkg/payment"
	"github.com/inkbloom/server/internal/pkg/ratelimit"
	"github.com/inkbloom/server/internal/pkg/sms"
	"github.com/inkbloom/server/internal/pkg/storage"
	"github.com/inkbloom/server/internal/repository"
	"github.com/inkbloom/server/internal/server"
	"github.com/inkbloom/server/internal/service"
	"github.com/inkbloom/server/internal/service/cache"
	"github.com/inkbloom/server/internal/service/format"
	"github.com/inkbloom/server/internal/service/task_engine"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
	"golang.org/x/sync/errgroup"
	"gorm.io/gorm"
)

// defaultJWTSecret mirrors the config package's placeholder jwt.secret;
// when local mode runs with this unchanged placeholder, a random session key
// is generated instead (task #37, M2-a: single-machine secrets must never be
// shared). Cloud mode refuses to boot with the placeholder (config.Load).
const defaultJWTSecret = "9c4e1f7ab02d8365e2f9a4c7d1b80f36a5e0d2c94b7f1a83e6d0c5b2a9f4e718"

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
	sugar.Infof("starting inkbloom server (mode=%s, run_mode=%s, port=%d)", cfg.Server.Mode, cfg.Mode, cfg.Server.Port)

	// ── Infrastructure: database + kv store + message broker ───────────────
	// Cloud mode: PostgreSQL + Redis + NATS (unchanged behavior).
	// Local embedded mode (task #37, M2-a): SQLite + in-process kv store +
	// LocalBus event bus (v2 §3.2), everything rooted at cfg.Server.DataRoot.
	// NOTE: wsHub is created before the infrastructure branch because the
	// local-mode LocalBus delivers task events straight into it.
	wsHub := server.NewWSHub(logger)

	var (
		db          *gorm.DB
		rdb         *redis.Client // nil in local mode
		kv          kvstore.Store
		natsMgr     *server.NATSManager
		fileStorage *storage.FileStorage
		outboxPub   *task_engine.OutboxPublisher
		distLock    dlock.LockAcquirer
		engineNats  task_engine.NATSPublisher
		backupHnd   *handler.BackupHandler // local mode only (task #38)
	)

	if cfg.IsLocal() {
		dataRoot, err := filepath.Abs(cfg.Server.DataRoot)
		if err != nil {
			sugar.Fatalf("invalid data root %s: %v", cfg.Server.DataRoot, err)
		}
		sugar.Infof("local embedded mode, data root: %s", dataRoot)

		db, err = database.NewSQLiteDB(dataRoot, logger)
		if err != nil {
			sugar.Fatalf("failed to open sqlite database: %v", err)
		}

		kv = kvstore.NewMemStore()
		engineNats = server.NewLocalBus(wsHub, logger)
		fileStorage = storage.NewFileStorageAt(filepath.Join(dataRoot, "assets"))
		outboxPub = task_engine.NewOutboxPublisher(db, engineNats, logger)
		distLock = dlock.NewLocalLock() // single process: in-process keyed lock (v2 §3.3)
		backupHnd = handler.NewBackupHandler(db, dataRoot, logger)
	} else {
		db, err = database.NewPostgresDB(cfg, logger)
		if err != nil {
			sugar.Fatalf("failed to connect to database: %v", err)
		}

		rdb, err = initRedis(cfg)
		if err != nil {
			sugar.Fatalf("failed to connect to redis: %v", err)
		}
		defer rdb.Close()
		kv = kvstore.NewRedisStore(rdb)

		natsMgr, err = server.NewNATSManager(cfg.NATS.URL, logger)
		if err != nil {
			sugar.Fatalf("failed to connect to NATS: %v", err)
		}
		defer natsMgr.Close()
		if err := natsMgr.CreateStreams(); err != nil {
			sugar.Fatalf("failed to create NATS streams: %v", err)
		}

		engineNats = natsMgr
		fileStorage = storage.NewFileStorage()
		outboxPub = task_engine.NewOutboxPublisher(db, natsMgr, logger)
		distLock = dlock.NewDistributedLock(rdb, logger)
	}
	sqlDB, _ := db.DB()
	defer sqlDB.Close()

	// Initialize Cache Manager (kvstore-backed in both modes)
	cacheMgr := cache.NewCacheManager(kv, logger)

	// Site-wide rate limiter (v2 §5.1): Redis sliding window in cloud mode,
	// in-process memory window in the local embedded mode.
	var rateLimiter *middleware.RateLimiter
	if cfg.IsLocal() {
		rateLimiter = middleware.NewRateLimiter(ratelimit.NewMemLimiter(), logger)
	} else {
		rateLimiter = middleware.NewRateLimiter(ratelimit.NewRedisLimiter(rdb), logger)
	}

	// Initialize account system (JWT manager, SMS provider, auth service)
	ensureJWTSecret(cfg, sugar)
	tokenMgr := authtoken.NewManager(cfg.JWT.Secret, cfg.JWT.AccessTTL, cfg.JWT.RefreshTTL)
	smsProvider := sms.NewDevProvider(logger)
	userRepo := repository.NewUserRepository(db)

	// Initialize M3 billing (task #39): subscription state machine + payment
	// orders. Only the sandbox channel is open; alipay/wechat are TODO stubs.
	subRepo := repository.NewSubscriptionRepository(db)
	orderRepo := repository.NewPaymentOrderRepository(db)
	subService := service.NewSubscriptionService(subRepo, logger)
	paymentService := service.NewPaymentService(orderRepo, subService,
		[]payment.Provider{
			payment.NewSandboxProvider(),
			payment.NewAlipayProvider(),
			payment.NewWechatProvider(),
		}, logger)

	// Initialize M4 token billing (task #43): accounts / ledger / orders.
	// AI entitlements depend ONLY on the token balance (independent of the
	// subscription gate above).
	tokenAccountRepo := repository.NewTokenAccountRepository(db)
	tokenLedgerRepo := repository.NewTokenLedgerRepository(db)
	tokenOrderRepo := repository.NewTokenOrderRepository(db)
	tokenService := service.NewTokenService(tokenAccountRepo, tokenLedgerRepo, tokenOrderRepo, logger)

	authService := service.NewAuthService(userRepo, kv, tokenMgr, smsProvider, subService, tokenService, cfg.Admin.Phones, logger)

	// M5 back-office (task #49): admin endpoints + the per-request account
	// state guard (ban enforcement + admin role gate, 60s cached).
	userGuard := service.NewUserGuard(userRepo)
	adminService := service.NewAdminService(
		repository.NewAdminRepository(db), userRepo, subRepo, tokenService, userGuard, logger)
	adminHandler := handler.NewAdminHandler(adminService)

	// M6 rollout & feedback (task #51): anonymous public flags / desktop
	// download + user feedback with back-office management.
	publicService := service.NewPublicService(cfg.Rollout, cfg.Desktop)
	publicHandler := handler.NewPublicHandler(publicService, tokenMgr)
	feedbackService := service.NewFeedbackService(repository.NewFeedbackRepository(db), logger)
	feedbackHandler := handler.NewFeedbackHandler(feedbackService)

	// Seed the id=1 demo account (phone 13800000000 / inkbloom123)
	if err := authService.EnsureDemoUser(context.Background()); err != nil {
		sugar.Errorf("failed to ensure demo user: %v", err)
	}

	// Backfill a trial subscription for every user without one (demo account
	// + accounts registered before M3), so legacy users stay writable.
	if n, err := subService.EnsureForExistingUsers(context.Background()); err != nil {
		sugar.Errorf("failed to backfill subscriptions: %v", err)
	} else if n > 0 {
		sugar.Infof("backfilled %d trial subscription(s) for existing users", n)
	}

	// M4 (task #43): backfill empty token accounts for users without one
	// (demo account + pre-M4 registrations). No experience pack is granted
	// here to avoid double issuance.
	if n, err := tokenService.EnsureAccounts(context.Background()); err != nil {
		sugar.Errorf("failed to backfill token accounts: %v", err)
	} else if n > 0 {
		sugar.Infof("backfilled %d empty token account(s) for existing users", n)
	}

	// WS /ws authenticates via query token=<JWT access>.
	// Local embedded mode additionally admits tokenless connections as the
	// anonymous local user (v2 §3.4): the listener is loopback-bound.
	if cfg.IsLocal() {
		wsHub.SetLocalAnon(true)
	}
	// WS Origin whitelist (v2 §5.3): reuse the CORS origin config so the
	// browser-facing surface has one source of truth.
	wsHub.SetAllowedOrigins(cfg.Server.CORSOrigins)
	wsHub.SetAuthenticator(func(token string) (int64, error) {
		claims, err := tokenMgr.ParseTyped(token, authtoken.TypeAccess)
		if err != nil {
			return 0, err
		}
		return claims.UID()
	})

	// Initialize NATS→WebSocket Bridge (cloud only: needs a real broker)
	var bridge *server.NATSWsBridge
	if natsMgr != nil {
		bridge = server.NewNATSWsBridge(natsMgr, wsHub, logger)
	}

	// Initialize repositories
	novelRepo := repository.NewNovelRepository(db)
	chapterRepo := repository.NewChapterRepository(db)
	volumeRepo := repository.NewVolumeRepository(db)
	knowledgeRepo := repository.NewKnowledgeRepository(db)
	taskRepo := repository.NewTaskRepository(db)
	assetRepo := repository.NewAssetRepository(db)
	aigcRecordRepo := repository.NewAIGCRecordRepository(db)
	docRepo := repository.NewNovelDocRepository(db)
	mediaRepo := repository.NewMediaRepository(db)

	// Initialize services
	novelService := service.NewNovelService(novelRepo, chapterRepo, cacheMgr, docRepo)
	chapterService := service.NewChapterService(chapterRepo, novelRepo, cacheMgr)
	volumeService := service.NewVolumeService(volumeRepo)
	knowledgeService := service.NewKnowledgeService(knowledgeRepo, cfg.AIService.URL)
	aiContextBuilder := service.NewAIContextBuilder(chapterRepo, novelRepo, db, logger)
	docService := service.NewNovelDocService(novelRepo, docRepo, chapterRepo)
	agentContextService := service.NewAgentContextService(novelRepo, docRepo, chapterRepo)
	mediaService := service.NewMediaService(mediaRepo)

	// M5 data export/import (task #47): .inkbloom packages.
	syncService := service.NewSyncService(db, fileStorage, novelRepo, docRepo, userRepo, logger)

	// Initialize handlers
	novelHandler := handler.NewNovelHandler(novelService)
	chapterHandler := handler.NewChapterHandler(chapterService)
	volumeHandler := handler.NewVolumeHandler(volumeService)
	aiBreaker := breaker.NewBreaker("ai_upstream", 20, 10, 30*time.Second)
	aiHandler := handler.NewAIHandler(cfg.AIService.URL, aiContextBuilder, logger,
		handler.WithAIBreaker(aiBreaker),
		handler.WithAgentContextService(agentContextService),
		handler.WithTokenService(tokenService),
	)
	knowledgeHandler := handler.NewKnowledgeHandler(knowledgeService)
	docHandler := handler.NewNovelDocHandler(docService)
	mediaHandler := handler.NewMediaHandler(mediaService)
	syncHandler := handler.NewSyncHandler(syncService, logger)
	portraitHandler := handler.NewPortraitHandler(fileStorage)
	// Unified image store (task #57): ingest/dedupe/list/delete gallery
	// images under /api/v1/images.
	imageService := service.NewImageService(assetRepo, fileStorage, logger)
	imageAPIHandler := handler.NewImageHandler(imageService)
	authHandler := handler.NewAuthHandler(authService)
	subscriptionHandler := handler.NewSubscriptionHandler(subService, paymentService)
	paymentHandler := handler.NewPaymentHandler(paymentService)
	tokenHandler := handler.NewTokenHandler(tokenService)

	// Initialize distributed task engine components
	taskBreaker := breaker.NewBreaker("task_execution", 50, 10, 30*time.Second)
	engine := task_engine.NewTaskEngine(db, rdb, engineNats, distLock, taskRepo, taskBreaker, logger, 4)
	taskAPIHandler := handler.NewTaskAPIHandler(engine, taskRepo)

	// Content-safety gateway (v2 §9.1): no-op until the provider is
	// provisioned; violations are recorded to content_violations.
	var csChecker contentsafety.Checker = contentsafety.NewNoopChecker()
	if cfg.ContentSafety.Enabled && cfg.ContentSafety.Provider == "aliyun" {
		csChecker = contentsafety.NewAliyunChecker(
			cfg.ContentSafety.Endpoint, cfg.ContentSafety.AccessKey, cfg.ContentSafety.SecretKey)
		sugar.Info("content safety gateway enabled (aliyun)")
	} else if !cfg.IsLocal() {
		sugar.Warn("content safety gateway DISABLED in cloud mode — enable before production launch")
	}
	csChecker = contentsafety.NewRecordingChecker(csChecker, db, logger)

	// Local mode (v2 §3.2): the LocalBus doubles as the task feed — route
	// outbox-published creation events into the engine's in-process queue.
	if bus, ok := engineNats.(*server.LocalBus); ok {
		bus.SetTaskSink(engine.SubmitLocal)
	}

	// Register AIGC image task handler
	imageHandler := task_engine.NewImageTaskHandler(cfg.AIService.URL, assetRepo, aigcRecordRepo, logger)
	engine.RegisterHandler(imageHandler)

	// AIGC HTTP handler
	aigcHandler := handler.NewAIGCHandler(engine, assetRepo, handler.WithTaskRepo(taskRepo), handler.WithAIGCLogger(logger), handler.WithAIGCTokenService(tokenService), handler.WithAIGCRecordRepo(aigcRecordRepo), handler.WithContentSafety(csChecker))

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
	webDist := ""
	if cfg.IsLocal() {
		webDist = cfg.Server.WebDist
	}
	httpServer := server.New(cfg, logger, server.Handlers{
		Novel:        novelHandler,
		Chapter:      chapterHandler,
		Volume:       volumeHandler,
		AI:           aiHandler,
		Task:         taskAPIHandler,
		AIGC:         aigcHandler,
		Knowledge:    knowledgeHandler,
		Format:       formatHandler,
		Export:       exportHandler,
		Doc:          docHandler,
		Media:        mediaHandler,
		Sync:         syncHandler,
		Portrait:     portraitHandler,
		Image:        imageAPIHandler,
		Auth:         authHandler,
		Backup:       backupHnd,
		Subscription: subscriptionHandler,
		Payment:      paymentHandler,
		Token:        tokenHandler,
		Admin:        adminHandler,
		Feedback:     feedbackHandler,
		Public:       publicHandler,
		UserState:    userGuard.State,
		Writable:     subService.ReadOnly,
		Tokens:       tokenMgr,
		WSHub:        wsHub,
		RateLimiter:  rateLimiter,
		Storage:      fileStorage,
		WebDist:      webDist,
		DB:           db,
	})

	// Local mode binds loopback only: the embedded server must never be
	// reachable from the network.
	addr := fmt.Sprintf(":%d", cfg.Server.Port)
	if cfg.IsLocal() {
		addr = fmt.Sprintf("127.0.0.1:%d", cfg.Server.Port)
	}

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

	// Start NATS→WebSocket Bridge (cloud only)
	if bridge != nil {
		g.Go(func() error {
			return bridge.Start(gctx)
		})
	}

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

// ensureJWTSecret replaces the placeholder JWT secret with a random one in
// local mode, so each installed desktop instance signs its own tokens.
func ensureJWTSecret(cfg *config.Config, sugar *zap.SugaredLogger) {
	if cfg.JWT.Secret != defaultJWTSecret {
		return // explicitly configured: honor it in any mode
	}
	if !cfg.IsLocal() {
		return // cloud keeps its configured/default secret behavior unchanged
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		sugar.Fatalf("failed to generate local jwt secret: %v", err)
	}
	cfg.JWT.Secret = hex.EncodeToString(buf)
	sugar.Info("local mode: generated random JWT session secret")
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
