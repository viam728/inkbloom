package server

import (
	"context"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/config"
	"github.com/inkbloom/server/internal/handler"
	"github.com/inkbloom/server/internal/middleware"
	"github.com/inkbloom/server/internal/pkg/authtoken"
	"github.com/inkbloom/server/internal/pkg/signedurl"
	"github.com/inkbloom/server/internal/pkg/storage"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

// Handlers bundles all HTTP handlers for route registration.
type Handlers struct {
	Novel     *handler.NovelHandler
	Chapter   *handler.ChapterHandler
	Volume    *handler.VolumeHandler
	AI        *handler.AIHandler
	Task      *handler.TaskAPIHandler
	AIGC      *handler.AIGCHandler
	Knowledge *handler.KnowledgeHandler
	Format    *handler.FormatHandler
	Export    *handler.ExportHandler
	Doc       *handler.NovelDocHandler
	Media     *handler.MediaHandler
	Portrait  *handler.PortraitHandler
	// Image serves the unified image store /api/v1/images (task #57).
	Image *handler.ImageHandler
	Auth  *handler.AuthHandler
	// Sync serves the M5 .inkbloom export/import endpoints (task #47).
	Sync *handler.SyncHandler
	// Backup is the local-mode SQLite checkpoint endpoint (task #38, M2-b).
	// Nil in cloud mode, where these routes are never registered.
	Backup *handler.BackupHandler
	// Subscription / Payment handlers (M3 billing, task #39). Optional.
	Subscription *handler.SubscriptionHandler
	Payment      *handler.PaymentHandler
	// Token handler (M4 token billing, task #43). Optional.
	Token *handler.TokenHandler
	// Admin serves the back-office endpoints (M5, task #49). Optional.
	Admin *handler.AdminHandler
	// Feedback serves user feedback submission plus the back-office
	// feedback list/status endpoints (M6, task #51). Optional.
	Feedback *handler.FeedbackHandler
	// History serves the E1 chapter version history endpoints (business plan
	// v3, plan A05). Optional.
	History *handler.HistoryHandler
	// NovelVersion serves the Q3 whole-novel milestone snapshots (Agent
	// safety work Q3). Optional.
	NovelVersion *handler.NovelVersionHandler
	// Events ingests product-analytics batches (plan A40). Mounted on the
	// anonymous group so unauthenticated readers are measurable too. Optional.
	Events *handler.EventHandler
	// Foreshadow serves the E2 foreshadow tracking endpoints (plan A12).
	// Optional.
	Foreshadow *handler.ForeshadowHandler
	// Publish serves the E4 author-facing publishing endpoints (plan A17).
	// Optional.
	Publish *handler.PublishHandler
	// Reader serves the E4 public reading surface (plan A18): anonymous
	// reads of published works plus logged-in progress/follows. Optional.
	Reader *handler.ReaderHandler
	// Interaction serves the E5 reader-interaction endpoints (plan A28). Optional.
	Interaction *handler.InteractionHandler
	// Story drives the Agent full-book creation pipeline (plan P1). Optional.
	Story *handler.StoryHandler
	// Agent drives the conversational creation Agent (tool-calling). Optional.
	Agent *handler.AgentHandler
	// Trash serves the outline-node recycle bin (chapter+node+content together
	// in, restore with act re-selection). Optional.
	Trash *handler.TrashHandler
	// Public serves the anonymous rollout flags + desktop download
	// endpoints under /api/v1/public (M6, task #51). Optional.
	Public *handler.PublicHandler
	// UserState re-checks the persisted account status/role on every
	// authenticated request (ban enforcement + admin gate, task #49).
	// Optional: nil keeps the legacy JWT-only behavior.
	UserState middleware.UserStateChecker
	// Writable gates write requests on subscription state (402 in
	// grace/dormant). Optional: nil disables the gate.
	Writable middleware.WritabilityChecker
	// Tokens signs/validates JWTs for the AuthJWT middleware.
	Tokens *authtoken.Manager
	WSHub  *WSHub
	// RateLimiter enforces the site-wide quotas (tech plan v2 §5.1).
	// Optional: nil disables rate limiting (tests / dev).
	RateLimiter *middleware.RateLimiter
	// Storage is the asset/portrait file storage root. Optional: when nil
	// the legacy ~/.inkbloom default is used (cloud mode); local mode
	// injects a storage rooted at the configured data directory.
	Storage *storage.FileStorage
	// WebDist, when non-empty (local mode), serves the built frontend as a
	// static SPA site with index.html fallback for client-side routes.
	WebDist string
	// DB, when set (cloud mode), powers the /health dependency probe.
	DB *gorm.DB
}

// HTTPServer wraps the Gin engine and http.Server.
type HTTPServer struct {
	engine *gin.Engine
	server *http.Server
	logger *zap.Logger
}

// New creates a new HTTPServer with registered routes and middleware.
func New(cfg *config.Config, logger *zap.Logger, h Handlers) *HTTPServer {
	if cfg.Server.Mode == "release" {
		gin.SetMode(gin.ReleaseMode)
	}

	engine := gin.New()

	// Middleware chain: Recovery → CORS → Logger → Metrics
	engine.Use(middleware.Recovery(logger))
	engine.Use(middleware.CORS(cfg.Server.CORSOrigins))
	engine.Use(middleware.Logger(logger))
	engine.Use(middleware.Metrics())

	// Static file serving for generated assets. Task #57 replaced the plain
	// engine.StaticFS with a custom handler: http.ServeContent preserves
	// Range requests, directory listing stays disabled, and content-
	// addressed gallery files carry immutable cache headers. All legacy
	// paths (portraits etc.) keep serving exactly as before.
	fs := h.Storage
	if fs == nil {
		fs = storage.NewFileStorage()
	}
	assetRoot := http.Dir(fs.NovelAssetDir(0))
	serveAssetFile := func(c *gin.Context) {
		rel := c.Param("filepath")
		// C11 (asset auth): a request may hold either a valid signed URL
		// (uid/sig/exp query, for <img> tags that cannot send a header) or a
		// valid Bearer access token (for API clients). Anything else is denied
		// so private media/memo/draft assets are no longer world-readable.
		if !assetRequestAllowed(c, h.Tokens, rel) {
			c.String(http.StatusForbidden, "403 forbidden")
			return
		}
		f, err := assetRoot.Open(strings.TrimPrefix(rel, "/"))
		if err != nil {
			c.String(http.StatusNotFound, "404 not found")
			return
		}
		defer f.Close()
		st, err := f.Stat()
		if err != nil || st.IsDir() {
			// Directory browsing is forbidden.
			c.String(http.StatusNotFound, "404 not found")
			return
		}
		if isImmutableAsset(rel, st.Name()) {
			c.Header("Cache-Control", "public, max-age=31536000, immutable")
		}
		// Sniff the real content type up front: gallery thumbnails store
		// JPEG bytes under a .webp path, which extension typing mislabels.
		var buf [512]byte
		n, _ := f.Read(buf[:])
		if n > 0 {
			c.Header("Content-Type", http.DetectContentType(buf[:n]))
		}
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			c.String(http.StatusInternalServerError, "500 internal error")
			return
		}
		http.ServeContent(c.Writer, c.Request, st.Name(), st.ModTime(), f)
	}
	engine.GET("/assets/files/*filepath", serveAssetFile)
	engine.HEAD("/assets/files/*filepath", serveAssetFile)

	// Local embedded mode (task #37): host the built web frontend as a
	// static SPA site so Electron can load it from the Go server directly.
	// Registered before the API routes are matched; unmatched non-API,
	// non-asset paths fall back to index.html (SPA client-side routing).
	if h.WebDist != "" {
		distDir := http.Dir(h.WebDist)
		fileServer := http.FileServer(distDir)
		engine.NoRoute(func(c *gin.Context) {
			p := c.Request.URL.Path
			if strings.HasPrefix(p, "/api/") {
				c.JSON(http.StatusNotFound, gin.H{"code": 404, "message": "not found"})
				return
			}
			// Serve the file when it exists, otherwise fall back to the SPA shell.
			rel := strings.TrimPrefix(strings.TrimPrefix(p, "/"), "/")
			if rel != "" {
				if f, err := distDir.Open(rel); err == nil {
					f.Close()
					fileServer.ServeHTTP(c.Writer, c.Request)
					return
				}
			}
			if f, err := distDir.Open("index.html"); err == nil {
				f.Close()
				c.Request.URL.Path = "/"
				fileServer.ServeHTTP(c.Writer, c.Request)
				return
			}
			c.String(http.StatusNotFound, "web dist not available")
		})
		logger.Info("web dist hosted", zap.String("dir", h.WebDist))
	}

	// Health endpoint (no auth). Cloud mode probes the database (v2 §8.1);
	// local mode stays the lightweight liveness signal.
	var healthHandler *handler.HealthHandler
	if h.DB != nil && !cfg.IsLocal() {
		healthHandler = handler.NewHealthHandlerWithDB(h.DB)
	} else {
		healthHandler = handler.NewHealthHandler()
	}
	engine.GET("/health", healthHandler.Health)

	// Prometheus metrics (v2 §8.1): cloud mode only — the local embedded
	// mode is loopback-bound and single-user, scraping adds nothing there.
	if !cfg.IsLocal() {
		engine.GET("/metrics", gin.WrapH(promhttp.Handler()))
	}

	// Local-mode backup checkpoint (task #38, M2-b). Registered WITHOUT the
	// JWT middleware on purpose: the desktop shell snapshots the DB at
	// startup before any user has logged in. Safe because the route only
	// exists in local mode, whose listener is bound to 127.0.0.1.
	if h.Backup != nil {
		system := engine.Group("/api/v1/system")
		system.POST("/backup", h.Backup.CreateBackup)
		system.GET("/backups", h.Backup.ListBackups)
		// Restore swaps the live DB for a chosen snapshot (v2 §7.3); the
		// desktop shell restarts the embedded server afterwards.
		system.POST("/restore", h.Backup.Restore)
	}

	// WebSocket endpoint (auth via query param)
	if h.WSHub != nil {
		engine.GET("/ws", h.WSHub.HandleConnection)
	}

	// Public endpoints (M6, task #51): no AuthJWT. flags optionally parses
	// a Bearer token itself to compute the per-user enabled switch.
	// Rate limit (v2 §5.1): anonymous IP 5 req/s.
	if h.Public != nil {
		publicGroup := engine.Group("/api/v1/public")
		if h.RateLimiter != nil {
			publicGroup.Use(h.RateLimiter.Scope(middleware.ScopeAnon))
		}
		{
			publicGroup.GET("/flags", h.Public.Flags)
			publicGroup.GET("/download/desktop", h.Public.DownloadDesktop)
		}
	}

	// Public reading surface (plan A18): anonymous GET reads of published
	// works/chapters. Registered before AuthJWT on purpose — a reader who
	// never logs in is the whole point. Rate-limited per-IP via ScopeAnon so
	// the reading traffic cannot drown the authenticated API.
	if h.Reader != nil {
		readerGroup := engine.Group("/api/v1/read")
		if h.RateLimiter != nil {
			readerGroup.Use(h.RateLimiter.Scope(middleware.ScopeAnon))
		}
		readerGroup.GET("/works/:slug", h.Reader.GetWork)
		readerGroup.GET("/works/:slug/chapters", h.Reader.ListChapters)
		readerGroup.GET("/chapters/:pid", h.Reader.GetChapter)
		readerGroup.GET("/chapters/:pid/interactions", h.Interaction.List)
		readerGroup.GET("/discover", h.Reader.Discover)
	}

	// Analytics ingestion (plan A40): intentionally anonymous — a reader who
	// never logs in is exactly the funnel P1 is measured on. Registered before
	// AuthJWT so the endpoint stays reachable without a session.
	if h.Events != nil {
		eventsGroup := engine.Group("/api/v1/events")
		if h.RateLimiter != nil {
			eventsGroup.Use(h.RateLimiter.Scope(middleware.ScopeAnon))
		}
		eventsGroup.POST("", h.Events.Ingest)
	}

	// Auth middleware: JWT access tokens (with optional legacy static-token backdoor).
	// Local embedded mode additionally admits headerless requests as the
	// anonymous local user (uid=0) — offline creation without a cloud
	// account (v2 §3.4); the listener is loopback-bound so this is safe.
	authMiddleware := middleware.AuthJWTWithLocalAnon(h.Tokens, cfg.Auth.LegacyToken, cfg.Auth.Token, h.UserState, cfg.IsLocal())

	// Auth endpoints (register/login etc. do not require AuthJWT).
	// Rate limits (v2 §5.1): sms-code per phone 1/60s; the rest per IP 5/s.
	if h.Auth != nil {
		authGroup := engine.Group("/api/v1/auth")
		if h.RateLimiter != nil {
			authGroup.Use(h.RateLimiter.Scope(middleware.ScopeAnon))
		}
		{
			authGroup.POST("/register", h.Auth.Register)
			authGroup.POST("/login", h.Auth.Login)
			authGroup.POST("/refresh", h.Auth.Refresh)
			authGroup.POST("/logout", authMiddleware, h.Auth.Logout)
			authGroup.GET("/me", authMiddleware, h.Auth.Me)
			// Account deregistration (v2 §9.2): cool-down + cancel.
			authGroup.POST("/deregister", authMiddleware, h.Auth.Deregister)
			authGroup.POST("/deregister/cancel", authMiddleware, h.Auth.CancelDeregister)
			// Session/device management (plan A22).
			authGroup.GET("/sessions", authMiddleware, h.Auth.ListSessions)
			authGroup.DELETE("/sessions/:id", authMiddleware, h.Auth.DeleteSession)
		}
		// sms-code carries the stricter per-phone scope on top of the
		// group-level anon-IP limit.
		smsGroup := engine.Group("/api/v1/auth")
		if h.RateLimiter != nil {
			smsGroup.Use(h.RateLimiter.Scope(middleware.ScopeSMS))
		}
		smsGroup.POST("/sms-code", h.Auth.SendSMSCode)
	}

	// Payment channel callbacks: no AuthJWT (callbacks come from the
	// payment channel, not the user). Sandbox uses the same entry.
	if h.Payment != nil {
		payGroup := engine.Group("/api/v1/payment")
		{
			payGroup.POST("/notify/:channel", h.Payment.Notify)
		}
	}

	// Back-office (M5, task #49): AuthJWT + RequireAdmin only. Registered
	// outside the RequireWritable gate below (admin operations must stay
	// available even while the operator's own subscription is read-only).
	if h.Admin != nil {
		adminGroup := engine.Group("/api/v1/admin")
		adminGroup.Use(authMiddleware, middleware.RequireAdmin())
		{
			adminGroup.GET("/dashboard", h.Admin.Dashboard)
			adminGroup.GET("/users", h.Admin.ListUsers)
			adminGroup.POST("/users/:id/status", h.Admin.SetUserStatus)
			adminGroup.POST("/subscriptions/:user_id/extend", h.Admin.ExtendSubscription)
			adminGroup.POST("/token/grant", h.Admin.GrantTokens)
			adminGroup.GET("/orders", h.Admin.ListOrders)
			if h.Feedback != nil {
				adminGroup.GET("/feedbacks", h.Feedback.List)
				adminGroup.POST("/feedbacks/:id/status", h.Feedback.SetStatus)
			}
		}
	}

	// Authenticated API v1 routes
	api := engine.Group("/api/v1")
	api.Use(authMiddleware)
	// Site-wide rate limiting (v2 §5.1): 20 req/s per user on regular
	// business endpoints; AI endpoints get the stricter 1 req/s scope below.
	if h.RateLimiter != nil {
		api.Use(h.RateLimiter.Scope(middleware.ScopeAPI))
	}
	// M3: subscription read-only gate (402 on grace/dormant writes).
	// Exempts /auth, /subscription, /payment prefixes internally.
	api.Use(middleware.RequireWritable(h.Writable))
	{
		// Asset signing (C11): returns a signed URL for a stored asset path so
		// the frontend can render <img> tags without an Authorization header.
		api.GET("/assets/sign", func(c *gin.Context) {
			path := c.Query("path")
			if !strings.HasPrefix(path, "/assets/files/") {
				c.JSON(http.StatusBadRequest, gin.H{"error": "path must start with /assets/files/"})
				return
			}
			c.JSON(http.StatusOK, gin.H{"url": signedurl.SignURL(handler.GetUserID(c), path)})
		})

		// Subscription & payment (M3 billing, task #39)
		if h.Subscription != nil {
			api.GET("/subscription", h.Subscription.Get)
			api.POST("/subscription/orders", h.Subscription.CreateOrder)
		}
		if h.Payment != nil {
			api.GET("/payment/orders", h.Payment.ListOrders)
		}

		// Foreshadow tracking (E2, plan A12). Static segments (pending /
		// detect / scan) must be registered before the `:fid` wildcard per
		// contract C5 — otherwise "/foreshadows/detect" would match ":fid".
		if h.Foreshadow != nil {
			api.GET("/novels/:id/foreshadows", h.Foreshadow.List)
			api.GET("/novels/:id/foreshadows/pending", h.Foreshadow.ListPending)
			api.GET("/novels/:id/foreshadows/hints", h.Foreshadow.Hints)
			api.POST("/novels/:id/foreshadows", h.Foreshadow.Create)
			api.POST("/novels/:id/foreshadows/detect", h.Foreshadow.DetectPlants)
			api.POST("/novels/:id/foreshadows/scan", h.Foreshadow.ScanChapter)
			api.PUT("/foreshadows/:fid", h.Foreshadow.UpdateStatus)
			api.DELETE("/foreshadows/:fid", h.Foreshadow.Delete)
		}

		// E4 publishing (plan A17): author-facing endpoints for publishing
		// works and chapters.
		if h.Publish != nil {
			api.GET("/publish/works", h.Publish.ListMyWorks)
			api.POST("/publish/works", h.Publish.CreateWork)
			api.PUT("/publish/works/:wid", h.Publish.UpdateWork)
			api.DELETE("/publish/works/:wid", h.Publish.Unpublish)
			api.POST("/publish/works/:wid/chapters", h.Publish.PublishChapter)
			api.GET("/publish/works/:wid/chapters", h.Publish.ListWorkChapters)
			api.DELETE("/publish/chapters/:pid", h.Publish.UnpublishChapter)
			api.GET("/publish/chapters/:pid/emotions", h.Publish.GetChapterEmotions)
			api.GET("/publish/works/:wid/stats", h.Publish.GetWorkStats)
		}

		// E4 reader logged-in endpoints (plan A18): progress & follows.
		// The anonymous reads are registered above in the read group; these
		// are the writes that need a user_id.
		if h.Reader != nil {
			api.GET("/read/progress", h.Reader.GetProgress)
			api.PUT("/read/progress", h.Reader.UpsertProgress)
			api.POST("/read/follows", h.Reader.Follow)
			api.GET("/read/follows/:wid", h.Reader.GetFollow)
			api.DELETE("/read/follows/:wid", h.Reader.Unfollow)
			// Reader interactions (plan A28): comment/mood/like/adopt.
			api.POST("/read/chapters/:pid/interactions", h.Interaction.Create)
			api.POST("/interactions/:iid/like", h.Interaction.Like)
			api.DELETE("/interactions/:iid", h.Interaction.Hide)
			api.POST("/publish/interactions/:iid/adopt", h.Interaction.Adopt)
		}

		// Token billing (M4, task #43): balance / ledger / stats / orders.
		if h.Token != nil {
			api.GET("/token/balance", h.Token.Balance)
			api.GET("/token/ledger", h.Token.Ledger)
			api.GET("/token/stats", h.Token.Stats)
			api.GET("/token/usage/daily", h.Token.DailyUsage)
			api.POST("/token/orders", h.Token.CreateOrder)
			api.GET("/token/orders", h.Token.ListOrders)
		}

		// Novels
		api.POST("/novels", h.Novel.CreateNovel)
		api.GET("/novels", h.Novel.ListNovels)
		api.GET("/novels/:id", h.Novel.GetNovel)
		api.PUT("/novels/:id", h.Novel.UpdateNovel)
		api.DELETE("/novels/:id", h.Novel.DeleteNovel)

		// Chapters (nested under novel)
		api.GET("/novels/:id/chapters", h.Chapter.ListChaptersByNovel)
		api.PUT("/novels/:id/chapters/order", h.Chapter.ReorderChapters)

		// Chapters
		api.POST("/chapters", h.Chapter.CreateChapter)
		api.GET("/chapters/:id", h.Chapter.GetChapter)
		api.GET("/chapters/:id/content", h.Chapter.GetChapterContent)
		api.PUT("/chapters/:id", h.Chapter.UpdateChapter)
		api.DELETE("/chapters/:id", h.Chapter.DeleteChapter)

		// Chapter version history (E1, plan A05). The static `restore`
		// segment must be registered before the `:vid` wildcard (contract C5).
		if h.History != nil {
			api.GET("/chapters/:id/versions", h.History.ListVersions)
			api.POST("/chapters/:id/versions", h.History.CreateSnapshot)
			api.POST("/chapters/:id/versions/:vid/restore", h.History.RestoreVersion)
			api.GET("/chapters/:id/versions/:vid", h.History.GetVersion)
		}

		// Whole-novel milestone snapshots (Q3). The static `restore` segment
		// is registered before the `:vid` wildcard per contract C5 —
		// otherwise "/versions/restore" would match ":vid".
		if h.NovelVersion != nil {
			api.GET("/novels/:id/versions", h.NovelVersion.List)
			api.POST("/novels/:id/versions", h.NovelVersion.Create)
			api.POST("/novels/:id/versions/:vid/restore", h.NovelVersion.Restore)
			api.GET("/novels/:id/versions/:vid", h.NovelVersion.Get)
		}

		// Volumes (nested under novel)
		api.GET("/novels/:id/volumes", h.Volume.ListVolumes)

		// 垃圾桶：删除要点进桶 / 列表 / 重选幕恢复 / 彻底删除。
		if h.Trash != nil {
			api.GET("/novels/:id/trash", h.Trash.List)
			api.POST("/novels/:id/trash", h.Trash.TrashNode)
			api.POST("/novels/:id/trash/:trashId/restore", h.Trash.Restore)
			api.DELETE("/novels/:id/trash/:trashId", h.Trash.Purge)
		}

		// Volumes
		api.POST("/volumes", h.Volume.CreateVolume)
		api.PUT("/volumes/:id", h.Volume.UpdateVolume)
		api.DELETE("/volumes/:id", h.Volume.DeleteVolume)

		// AI (v2 §5.1: stricter 1 req/s per user on top of the group quota)
		if h.AI != nil {
			aiGroup := api.Group("")
			if h.RateLimiter != nil {
				aiGroup.Use(h.RateLimiter.Scope(middleware.ScopeAI))
			}
			aiGroup.POST("/ai/chat", h.AI.Chat)
			aiGroup.POST("/ai/inline", h.AI.Inline)
			aiGroup.POST("/ai/rewrite", h.AI.Rewrite)
			aiGroup.POST("/aigc/prompt", h.AI.GenerateImagePrompt)
			aiGroup.POST("/ai/candidates", h.AI.Candidates)
			aiGroup.POST("/ai/review", h.AI.Review)
			aiGroup.POST("/ai/inspiration", h.AI.Inspiration)
			aiGroup.POST("/ai/analyze-story", h.AI.AnalyzeStory)
			aiGroup.POST("/ai/analyze-media", h.AI.AnalyzeMedia)
			aiGroup.POST("/ai/expand-outline", h.AI.ExpandOutline)
			aiGroup.POST("/ai/generate-titles", h.AI.GenerateTitles)
			aiGroup.POST("/ai/adapt-content", h.AI.AdaptContent)
			aiGroup.POST("/ai/agent/generate", h.AI.AgentGenerate)
			aiGroup.POST("/ai/story-overview", h.AI.StoryOverview)
			aiGroup.POST("/prompt/build", h.AI.PromptBuild)

			// Conversational creation Agent (tool-calling loop).
			if h.Agent != nil {
				aiGroup.POST("/agent/chat", h.Agent.Chat)
			}

			// Agent full-book creation pipeline (plan P1): story jobs.
			if h.Story != nil {
				// Cheap state-management endpoints (create / list / get /
				// delete / adopt / advance / stage) are plain DB ops. They
				// ride the regular 20 req/s ScopeAPI quota, NOT the 1 req/s
				// AI quota — otherwise rapid slider drags (POST /stage + the
				// follow-up GET refresh in the same second) get 429'd and
				// surface to the author as "切换阶段失败".
				api.POST("/story/jobs", h.Story.Create)
				api.GET("/story/jobs", h.Story.List)
				api.GET("/story/jobs/:id", h.Story.Get)
				api.DELETE("/story/jobs/:id", h.Story.Delete)
				api.POST("/story/jobs/:id/chapters/adopt", h.Story.AdoptChapter)
				api.POST("/story/jobs/:id/advance", h.Story.AdvanceStage)
				api.POST("/story/jobs/:id/stage", h.Story.SetStage)
				// The actual LLM generation call stays on the stricter 1 req/s
				// AI quota (consistent with /aigc/generate above).
				if h.RateLimiter != nil {
					api.POST("/story/jobs/:id/generate", h.RateLimiter.Scope(middleware.ScopeAI), h.Story.GenerateStage)
				} else {
					api.POST("/story/jobs/:id/generate", h.Story.GenerateStage)
				}
			}
		}

		// Tasks
		if h.Task != nil {
			api.GET("/tasks", h.Task.ListTasks)
			api.GET("/tasks/:id", h.Task.GetTask)
		}

		// AIGC image generation & assets (v2 §5.1: generate 走 AI 配额)
		if h.AIGC != nil {
			if h.RateLimiter != nil {
				api.POST("/aigc/generate", h.RateLimiter.Scope(middleware.ScopeAI), h.AIGC.GenerateImage)
			} else {
				api.POST("/aigc/generate", h.AIGC.GenerateImage)
			}
			api.GET("/aigc/tasks/:id", h.AIGC.GetTaskStatus)
			api.GET("/aigc/records", h.AIGC.ListAIGCRecords)
			api.GET("/aigc/assets", h.AIGC.ListAssets)
			api.GET("/aigc/assets/:id", h.AIGC.GetAsset)
			api.DELETE("/aigc/assets/:id", h.AIGC.DeleteAsset)
		}

		// Knowledge Graph
		if h.Knowledge != nil {
			api.POST("/knowledge/extract", h.Knowledge.Extract)
			api.GET("/knowledge/graph/:novel_id", h.Knowledge.GetGraph)
			api.POST("/knowledge/check", h.Knowledge.CheckConsistency)
		}

		// Format conversion
		if h.Format != nil {
			api.POST("/format/convert", h.Format.Convert)
			api.POST("/format/preview", h.Format.Preview)
			api.GET("/format/list", h.Format.Formats)
		}

		// Export
		if h.Export != nil {
			api.POST("/export/chapter/:id", h.Export.ExportChapter)
			api.POST("/export/novel/:id", h.Export.ExportNovel)
		}

		// Novel documents: outline / memory / rhythm (nested under novel)
		if h.Doc != nil {
			api.GET("/novels/:id/outline", h.Doc.GetOutline)
			api.PUT("/novels/:id/outline", h.Doc.UpdateOutline)
			api.GET("/novels/:id/memory", h.Doc.GetMemory)
			api.PUT("/novels/:id/memory", h.Doc.UpdateMemory)
			api.GET("/novels/:id/rhythm", h.Doc.GetRhythm)
		}

		// Character portraits (nested under novel)
		if h.Portrait != nil {
			api.POST("/novels/:id/portraits", h.Portrait.UploadNovelPortrait)
		}

		// Unified image store (task #57)
		if h.Image != nil {
			api.POST("/images", h.Image.Upload)
			api.GET("/images", h.Image.List)
			// Static segment registered BEFORE the wildcard :id route.
			api.POST("/images/batch-delete", h.Image.BatchDelete)
			api.DELETE("/images/:id", h.Image.Delete)
		}

		// Self-media contents & topics
		if h.Media != nil {
			// Static segment registered BEFORE the wildcard :id route.
			api.GET("/media/memory", h.Media.GetMediaMemory)
			api.PUT("/media/memory", h.Media.UpdateMediaMemory)
			if h.Portrait != nil {
				api.POST("/media/portraits", h.Portrait.UploadMediaPortrait)
			}

			api.GET("/media/contents", h.Media.ListContents)
			api.POST("/media/contents", h.Media.CreateContent)
			// Static segment registered BEFORE the wildcard :id route.
			api.PUT("/media/contents/order", h.Media.ReorderContents)
			api.PUT("/media/contents/:id", h.Media.UpdateContent)
			api.DELETE("/media/contents/:id", h.Media.DeleteContent)
			api.GET("/media/topics", h.Media.ListTopics)
			api.POST("/media/topics", h.Media.SaveTopics)
		}

		// .inkbloom data export/import (M5, task #47). Export is a read
		// (streamed zip); import is a write and stays under the
		// RequireWritable gate like every other /api/v1 mutation.
		if h.Sync != nil {
			api.GET("/sync/export", h.Sync.Export)
			api.POST("/sync/import", h.Sync.Import)
		}

		// User feedback (M6, task #51): write endpoint but exempt from the
		// RequireWritable gate (see writableExemptPrefixes).
		if h.Feedback != nil {
			api.POST("/feedback", h.Feedback.Create)
		}
	}

	return &HTTPServer{
		engine: engine,
		logger: logger,
	}
}

// isImmutableAsset reports whether the served path is a content-addressed
// gallery file (safe to cache forever): anything under a gallery/ directory
// or named {hexhash}.{ext}.
func isImmutableAsset(rel, name string) bool {
	if strings.Contains(rel, "/gallery/") {
		return true
	}
	base := name
	if i := strings.LastIndexByte(base, '.'); i > 0 {
		base = base[:i]
	}
	if len(base) < 12 {
		return false
	}
	for _, r := range base {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			return false
		}
	}
	return true
}

// Start begins listening on the given address.
func (s *HTTPServer) Start(addr string) error {
	s.server = &http.Server{
		Addr:    addr,
		Handler: s.engine,
	}
	return s.server.ListenAndServe()
}

// Shutdown gracefully shuts down the HTTP server.
func (s *HTTPServer) Shutdown(ctx context.Context) error {
	if s.server == nil {
		return nil
	}
	return s.server.Shutdown(ctx)
}

// assetRequestAllowed reports whether an asset request is authorized for
// filepath (the /assets/files wildcard value, with its leading slash).
// It accepts a valid signed URL (uid/sig/exp) or a valid Bearer access token,
// so private media/memo/draft assets are no longer world-readable (C11).
func assetRequestAllowed(c *gin.Context, tokens *authtoken.Manager, filepath string) bool {
	uid, sig, exp := signedurl.ParseQuery(c.Request.URL.Query())
	if sig != "" {
		return signedurl.Verify(uid, "/assets/files"+filepath, sig, exp)
	}
	if tokens == nil {
		return false
	}
	auth := c.GetHeader("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return false
	}
	_, err := tokens.Parse(strings.TrimPrefix(auth, "Bearer "))
	return err == nil
}
