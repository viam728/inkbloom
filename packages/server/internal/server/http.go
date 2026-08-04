package server

import (
	"context"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/config"
	"github.com/inkbloom/server/internal/handler"
	"github.com/inkbloom/server/internal/middleware"
	"github.com/inkbloom/server/internal/pkg/storage"
	"go.uber.org/zap"
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
	WSHub     *WSHub
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

	// Middleware chain: Recovery → CORS → Logger
	engine.Use(middleware.Recovery(logger))
	engine.Use(middleware.CORS())
	engine.Use(middleware.Logger(logger))

	// Static file serving for generated assets
	fs := storage.NewFileStorage()
	engine.StaticFS("/assets/files", http.Dir(fs.NovelAssetDir(0)))

	// Health endpoint (no auth)
	healthHandler := handler.NewHealthHandler()
	engine.GET("/health", healthHandler.Health)

	// WebSocket endpoint (auth via query param)
	if h.WSHub != nil {
		engine.GET("/ws", h.WSHub.HandleConnection)
	}

	// Authenticated API v1 routes
	api := engine.Group("/api/v1")
	api.Use(middleware.Auth(cfg.Auth.Token))
	{
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

		// Volumes (nested under novel)
		api.GET("/novels/:id/volumes", h.Volume.ListVolumes)

		// Volumes
		api.POST("/volumes", h.Volume.CreateVolume)
		api.PUT("/volumes/:id", h.Volume.UpdateVolume)
		api.DELETE("/volumes/:id", h.Volume.DeleteVolume)

		// AI
		if h.AI != nil {
			api.POST("/ai/chat", h.AI.Chat)
			api.POST("/ai/inline", h.AI.Inline)
			api.POST("/ai/rewrite", h.AI.Rewrite)
			api.POST("/aigc/prompt", h.AI.GenerateImagePrompt)
			api.POST("/ai/candidates", h.AI.Candidates)
			api.POST("/ai/review", h.AI.Review)
			api.POST("/ai/inspiration", h.AI.Inspiration)
			api.POST("/ai/analyze-story", h.AI.AnalyzeStory)
			api.POST("/ai/analyze-media", h.AI.AnalyzeMedia)
			api.POST("/ai/expand-outline", h.AI.ExpandOutline)
			api.POST("/ai/generate-titles", h.AI.GenerateTitles)
			api.POST("/ai/adapt-content", h.AI.AdaptContent)
			api.POST("/prompt/build", h.AI.PromptBuild)
		}

		// Tasks
		if h.Task != nil {
			api.GET("/tasks", h.Task.ListTasks)
			api.GET("/tasks/:id", h.Task.GetTask)
		}

		// AIGC image generation & assets
		if h.AIGC != nil {
			api.POST("/aigc/generate", h.AIGC.GenerateImage)
			api.GET("/aigc/tasks/:id", h.AIGC.GetTaskStatus)
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

		// Self-media contents & topics
		if h.Media != nil {
			api.GET("/media/contents", h.Media.ListContents)
			api.POST("/media/contents", h.Media.CreateContent)
			// Static segment registered BEFORE the wildcard :id route.
			api.PUT("/media/contents/order", h.Media.ReorderContents)
			api.PUT("/media/contents/:id", h.Media.UpdateContent)
			api.DELETE("/media/contents/:id", h.Media.DeleteContent)
			api.GET("/media/topics", h.Media.ListTopics)
			api.POST("/media/topics", h.Media.SaveTopics)
		}
	}

	return &HTTPServer{
		engine: engine,
		logger: logger,
	}
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
