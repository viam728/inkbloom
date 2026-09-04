package middleware

import (
	"net/http"
	"runtime/debug"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"go.uber.org/zap"
)

// Recovery returns a middleware that recovers from panics,
// logs the stack trace, and returns a 500 error. The response body follows
// the global dto.APIResponse contract so the frontend's unified parser can
// read code/message instead of falling back to a blank screen.
func Recovery(logger *zap.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			if r := recover(); r != nil {
				stack := string(debug.Stack())
				logger.Error("panic recovered",
					zap.Any("error", r),
					zap.String("stack", stack),
					zap.String("path", c.Request.URL.Path),
					zap.String("method", c.Request.Method),
				)
				c.AbortWithStatusJSON(http.StatusInternalServerError, dto.APIResponse{
					Code:    500,
					Message: "internal server error",
				})
			}
		}()
		c.Next()
	}
}
