package middleware

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

// cachedResponse stores the cached HTTP response body and status.
type cachedResponse struct {
	StatusCode int    `json:"status_code"`
	Body       string `json:"body"`
}

// responseWriter wraps gin.ResponseWriter to capture the response body.
type responseWriter struct {
	gin.ResponseWriter
	body *bytes.Buffer
}

func (w *responseWriter) Write(b []byte) (int, error) {
	w.body.Write(b)
	return w.ResponseWriter.Write(b)
}

// CacheMiddleware returns a Gin middleware that caches GET responses using Redis.
// Only 200 responses are cached.
func CacheMiddleware(rdb *redis.Client, logger *zap.Logger, ttl time.Duration) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Only cache GET requests
		if c.Request.Method != http.MethodGet {
			c.Next()
			return
		}

		key := "ink:http:" + c.Request.URL.Path
		ctx := c.Request.Context()

		// Try cache
		cached, err := rdb.Get(ctx, key).Result()
		if err == nil {
			var resp cachedResponse
			if unmarshalErr := json.Unmarshal([]byte(cached), &resp); unmarshalErr == nil {
				c.Data(resp.StatusCode, "application/json; charset=utf-8", []byte(resp.Body))
				c.Abort()
				return
			} else {
				logger.Warn("cache middleware unmarshal failed", zap.String("key", key), zap.Error(unmarshalErr))
			}
		} else if err != redis.Nil {
			logger.Warn("cache middleware get failed", zap.String("key", key), zap.Error(err))
		}

		// Capture response
		buf := &bytes.Buffer{}
		writer := &responseWriter{
			ResponseWriter: c.Writer,
			body:           buf,
		}
		c.Writer = writer

		c.Next()

		// Only cache 200 responses
		if c.Writer.Status() == http.StatusOK && buf.Len() > 0 {
			resp := cachedResponse{
				StatusCode: http.StatusOK,
				Body:       buf.String(),
			}
			data, marshalErr := json.Marshal(resp)
			if marshalErr != nil {
				return
			}
			go func() {
				bgCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				defer cancel()
				if setErr := rdb.Set(bgCtx, key, data, ttl).Err(); setErr != nil {
					logger.Warn("cache middleware set failed", zap.String("key", key), zap.Error(setErr))
				}
			}()
		}
	}
}

// InvalidateCache returns a Gin middleware that deletes the cache for the current path.
// Useful for POST/PUT/DELETE routes that should invalidate related GET caches.
func InvalidateCache(rdb *redis.Client, logger *zap.Logger, paths ...string) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()

		if c.Writer.Status() >= 400 {
			return
		}

		keys := make([]string, 0, len(paths))
		for _, p := range paths {
			keys = append(keys, "ink:http:"+p)
		}
		if len(keys) > 0 {
			go func() {
				bgCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				defer cancel()
				if err := rdb.Del(bgCtx, keys...).Err(); err != nil {
					logger.Warn("cache invalidation failed", zap.Strings("keys", keys), zap.Error(err))
				}
			}()
		}
	}
}
