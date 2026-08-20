package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
)

// RequireAdmin returns a Gin middleware that admits only back-office
// accounts (role >= 1, injected as "user_role" by AuthJWT). Requests
// without a role (e.g. the legacy static-token backdoor) are rejected —
// back-office access always requires a real account (task #49, M5).
func RequireAdmin() gin.HandlerFunc {
	return func(c *gin.Context) {
		roleVal, exists := c.Get("user_role")
		if !exists {
			abortForbidden(c, "admin access required")
			return
		}
		role, _ := roleVal.(int16)
		if role < 1 { // model.RoleOperator
			abortForbidden(c, "admin access required")
			return
		}
		c.Next()
	}
}

func abortForbidden(c *gin.Context, message string) {
	c.AbortWithStatusJSON(http.StatusForbidden, dto.APIResponse{
		Code:    403,
		Message: message,
	})
}
