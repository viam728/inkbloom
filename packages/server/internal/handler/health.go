package handler

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// HealthHandler handles health check requests.
// Deps holds optional dependency probes (cloud mode): each entry runs a
// fast liveness check; any failure flips the response to 503 (v2 §8.1).
type HealthHandler struct {
	Deps map[string]func(ctx context.Context) error
}

// NewHealthHandler creates a new HealthHandler.
func NewHealthHandler() *HealthHandler {
	return &HealthHandler{}
}

// Health responds with the service health status. With no dependency probes
// it is the lightweight liveness signal; with probes it reports per-
// dependency status and 503 on any failure.
func (h *HealthHandler) Health(c *gin.Context) {
	out := gin.H{
		"status":    "ok",
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	}
	if len(h.Deps) > 0 {
		deps := gin.H{}
		healthy := true
		for name, probe := range h.Deps {
			ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
			err := probe(ctx)
			cancel()
			if err != nil {
				deps[name] = "down: " + err.Error()
				healthy = false
			} else {
				deps[name] = "ok"
			}
		}
		out["deps"] = deps
		if !healthy {
			out["status"] = "degraded"
			c.JSON(http.StatusServiceUnavailable, out)
			return
		}
	}
	c.JSON(http.StatusOK, out)
}

// NewHealthHandlerWithDB builds a HealthHandler probing the database.
func NewHealthHandlerWithDB(db *gorm.DB) *HealthHandler {
	return &HealthHandler{Deps: map[string]func(ctx context.Context) error{
		"database": func(ctx context.Context) error {
			sqlDB, err := db.DB()
			if err != nil {
				return err
			}
			return sqlDB.PingContext(ctx)
		},
	}}
}
