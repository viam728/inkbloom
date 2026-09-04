package middleware

import (
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.uber.org/zap"
)

// redactedQueryParams are query parameter names whose values never belong in
// logs: access tokens ride in the query string on /ws?token=..., and
// signature/OTP fields would otherwise leak alongside them (F1-5).
var redactedQueryParams = map[string]struct{}{
	"token":         {},
	"access_token":  {},
	"refresh_token": {},
	"password":      {},
	"secret":        {},
	"sig":           {},
	"signature":     {},
	"code":          {},
}

// redactQuery masks the values of sensitive query parameters while keeping
// their presence and every non-sensitive pair visible for debugging.
func redactQuery(rawQuery string) string {
	if rawQuery == "" {
		return ""
	}
	values, err := url.ParseQuery(rawQuery)
	if err != nil {
		return "[unparsed]"
	}
	out := make([]string, 0, len(values))
	for key, vs := range values {
		if _, sensitive := redactedQueryParams[strings.ToLower(key)]; sensitive {
			out = append(out, key+"=***")
			continue
		}
		for _, v := range vs {
			out = append(out, key+"="+v)
		}
	}
	return strings.Join(out, "&")
}

// Logger returns a Zap-based structured logging middleware.
// It logs method, path, status, latency, client_ip, and request_id.
func Logger(logger *zap.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		path := c.Request.URL.Path
		// Sensitive query values (WS JWT tokens, asset signatures) are masked
		// before anything reaches the log pipeline.
		query := redactQuery(c.Request.URL.RawQuery)

		// Generate or propagate request ID
		requestID := c.GetHeader("X-Request-ID")
		if requestID == "" {
			requestID = uuid.New().String()
		}
		c.Set("request_id", requestID)
		c.Header("X-Request-ID", requestID)

		// Process request
		c.Next()

		latency := time.Since(start)
		status := c.Writer.Status()

		fields := []zap.Field{
			zap.String("method", c.Request.Method),
			zap.String("path", path),
			zap.String("query", query),
			zap.Int("status", status),
			zap.Duration("latency", latency),
			zap.String("client_ip", c.ClientIP()),
			zap.String("request_id", requestID),
			zap.Int("body_size", c.Writer.Size()),
		}

		if status >= 500 {
			logger.Error("server error", fields...)
		} else if status >= 400 {
			logger.Warn("client error", fields...)
		} else {
			logger.Info("request", fields...)
		}
	}
}
