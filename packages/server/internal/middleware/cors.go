package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// DefaultDevOrigins keeps the Vite dev server working out of the box.
// Production deployments must set server.cors_origins (or
// INKBLOOM_SERVER_CORS_ORIGINS, comma-separated) to their real domains —
// tech plan v2 §4.2. Exported so the WebSocket hub can reuse the exact same
// fallback list (see internal/server/websocket.go) instead of duplicating it.
var DefaultDevOrigins = []string{
	"http://localhost:5173",
	"http://localhost:3000",
	"http://127.0.0.1:5173",
	"http://127.0.0.1:3000",
	"http://127.0.0.1:18080", // desktop embedded server (self-hosted SPA)
}

// CORS returns a CORS middleware. allowedOrigins comes from configuration;
// when empty the dev defaults above are used. Non-matching origins receive
// no Access-Control-Allow-Origin header (deny-all by default).
func CORS(allowedOrigins []string) gin.HandlerFunc {
	if len(allowedOrigins) == 0 {
		allowedOrigins = DefaultDevOrigins
	}
	allowed := make(map[string]struct{}, len(allowedOrigins))
	for _, o := range allowedOrigins {
		o = strings.TrimSpace(o)
		if o != "" {
			allowed[o] = struct{}{}
		}
	}

	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")

		if _, ok := allowed[origin]; ok {
			c.Header("Access-Control-Allow-Origin", origin)
		}

		c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Origin, Content-Type, Accept, Authorization, X-Request-ID")
		c.Header("Access-Control-Expose-Headers", "Content-Length, X-Request-ID")
		c.Header("Access-Control-Allow-Credentials", "true")
		c.Header("Access-Control-Max-Age", "86400")

		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}

		c.Next()
	}
}
