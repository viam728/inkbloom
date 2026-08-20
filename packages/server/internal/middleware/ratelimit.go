package middleware

import (
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/pkg/ratelimit"
	"go.uber.org/zap"
)

// Rate-limit scopes (tech plan v2 §5.1). Each scope maps to a key pattern
// and a quota; the frozen 429 response carries the scope so the frontend can
// render a targeted hint.
const (
	// ScopeAnon covers unauthenticated endpoints (auth flows, public flags).
	ScopeAnon = "anon_ip"
	// ScopeAPI covers authenticated regular business endpoints.
	ScopeAPI = "user_api"
	// ScopeAI covers LLM-backed endpoints (text + image generation).
	ScopeAI = "user_ai"
	// ScopeSMS covers the verification-code endpoint (per phone + per IP).
	ScopeSMS = "sms"
)

// Quota is one rate-limit rule: limit hits per window.
type Quota struct {
	Limit  int64
	Window time.Duration
}

// RateLimiter bundles the limiter backend with per-scope quotas.
type RateLimiter struct {
	lim    ratelimit.Limiter
	logger *zap.Logger
	quotas map[string]Quota
}

// NewRateLimiter wires the limiter with the plan-doc quotas (v2 §5.1):
//
//	anon IP:   5 req/s  (+ daily cap handled by the same window at route level)
//	user API:  20 req/s
//	user AI:   1 req/s
//	sms phone: 1 req/60s
func NewRateLimiter(lim ratelimit.Limiter, logger *zap.Logger) *RateLimiter {
	return &RateLimiter{
		lim:    lim,
		logger: logger,
		quotas: map[string]Quota{
			ScopeAnon: {Limit: 5, Window: time.Second},
			ScopeAPI:  {Limit: 20, Window: time.Second},
			ScopeAI:   {Limit: 1, Window: time.Second},
			ScopeSMS:  {Limit: 1, Window: 60 * time.Second},
		},
	}
}

// Scope returns a Gin middleware enforcing the named quota. The rate-limit
// key is derived from the caller identity: authenticated requests key on
// user_id (except the SMS scope, which keys on the submitted phone number),
// anonymous requests key on client IP.
//
// Limiter errors fail open: a Redis hiccup must not brick the product.
func (rl *RateLimiter) Scope(scope string) gin.HandlerFunc {
	quota, ok := rl.quotas[scope]
	if !ok {
		// Programming error surface at startup wiring time; degrade to pass.
		return func(c *gin.Context) { c.Next() }
	}
	return func(c *gin.Context) {
		key := rl.keyFor(c, scope)
		if key == "" {
			c.Next()
			return
		}
		decision, err := rl.lim.Allow(c.Request.Context(), key, quota.Limit, quota.Window)
		if err != nil {
			rl.logger.Warn("rate limiter error, failing open",
				zap.String("scope", scope), zap.String("key", key), zap.Error(err))
			c.Next()
			return
		}
		if decision.Allowed {
			c.Next()
			return
		}

		retryAfter := decision.RetryAfter
		if retryAfter <= 0 {
			retryAfter = int64(quota.Window / time.Second)
			if retryAfter <= 0 {
				retryAfter = 1
			}
		}
		c.Header("Retry-After", fmt.Sprintf("%d", retryAfter))
		c.AbortWithStatusJSON(http.StatusTooManyRequests, dto.APIResponse{
			Code:    429,
			Message: "请求过于频繁，请稍后再试",
			Data: gin.H{
				"scope":       scope,
				"retry_after": retryAfter,
				"limit":       decision.Limit,
				"used":        decision.Used,
			},
		})
	}
}

// keyFor derives the rate-limit key for the request under the given scope.
func (rl *RateLimiter) keyFor(c *gin.Context, scope string) string {
	switch scope {
	case ScopeSMS:
		// Per-phone limit: the submitted phone number is the natural key.
		// Fall back to the client IP when the body carries no phone.
		var body struct {
			Phone string `json:"phone"`
		}
		// ShouldBindJSON would consume the body; use a raw peek instead.
		if raw, err := c.GetRawData(); err == nil && len(raw) > 0 {
			// Re-arm the body for downstream handlers.
			c.Request.Body = newReadCloser(raw)
			_ = jsonUnmarshal(raw, &body)
		}
		if body.Phone != "" {
			return "rl:sms:" + body.Phone
		}
		return "rl:sms:ip:" + c.ClientIP()
	case ScopeAnon:
		return "rl:ip:" + c.ClientIP() + ":" + c.FullPath()
	case ScopeAI:
		if uid, ok := c.Get("user_id"); ok {
			if id, ok := uid.(int64); ok {
				return fmt.Sprintf("rl:ai:%d", id)
			}
		}
		return "rl:ai:ip:" + c.ClientIP()
	default: // ScopeAPI
		if uid, ok := c.Get("user_id"); ok {
			if id, ok := uid.(int64); ok {
				return fmt.Sprintf("rl:uid:%d", id)
			}
		}
		return "rl:uid:ip:" + c.ClientIP()
	}
}
