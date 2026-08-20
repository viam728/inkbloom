package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/pkg/authtoken"
)

// UserStateChecker resolves the caller's persisted account state. Implemented
// by service.UserGuard (60s-cached user row lookup, task #49).
type UserStateChecker func(ctx context.Context, uid int64) (status int16, role int16, err error)

// AuthJWT returns a Gin middleware that validates Bearer access tokens
// (JWT, typ=access) and injects the numeric user id as "user_id" (int64)
// into the request context.
//
// Task #49 (M5): when state is non-nil, the persisted account state is
// re-checked on every request (cached by the implementation): a disabled
// account is rejected with 403, and the account role is injected as
// "user_role" (int16) for the RequireAdmin middleware.
//
// Transitional backdoor: when legacyEnabled is true, a request bearing the
// old static token passes as user id 0 (rollback switch, defaults to off).
func AuthJWT(tokens *authtoken.Manager, legacyEnabled bool, legacyToken string, state UserStateChecker) gin.HandlerFunc {
	return authJWT(tokens, legacyEnabled, legacyToken, state, false)
}

// AuthJWTWithLocalAnon extends AuthJWT with the desktop embedded-mode
// anonymous pass (tech plan v2 §3.4): when localAnon is true, requests
// WITHOUT an Authorization header are admitted as the anonymous local user
// (user_id=0) instead of being rejected. Requests that DO carry a header
// are validated normally, so a logged-in cloud session keeps working.
// Safe because local mode binds 127.0.0.1 only; cloud mode must never
// enable this.
func AuthJWTWithLocalAnon(tokens *authtoken.Manager, legacyEnabled bool, legacyToken string, state UserStateChecker, localAnon bool) gin.HandlerFunc {
	return authJWT(tokens, legacyEnabled, legacyToken, state, localAnon)
}

func authJWT(tokens *authtoken.Manager, legacyEnabled bool, legacyToken string, state UserStateChecker, localAnon bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		if authHeader == "" {
			if localAnon {
				// Desktop offline creation: no cloud session required.
				c.Set("user_id", int64(0))
				c.Next()
				return
			}
			abortUnauthorized(c, "missing authorization header")
			return
		}

		parts := strings.SplitN(authHeader, " ", 2)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			abortUnauthorized(c, "invalid authorization format")
			return
		}
		token := strings.TrimSpace(parts[1])

		// Legacy static-token backdoor (auth.legacy_token=true).
		if legacyEnabled && legacyToken != "" && token == legacyToken {
			c.Set("user_id", int64(0))
			c.Next()
			return
		}

		claims, err := tokens.ParseTyped(token, authtoken.TypeAccess)
		if err != nil {
			abortUnauthorized(c, "invalid or expired access token")
			return
		}

		uid, err := claims.UID()
		if err != nil {
			abortUnauthorized(c, "invalid token subject")
			return
		}

		if state != nil {
			// Checker errors fail open: a lookup hiccup must not lock out
			// every authenticated request.
			if status, role, err := state(c.Request.Context(), uid); err == nil {
				if status != 0 { // model.UserStatusActive
					c.AbortWithStatusJSON(http.StatusForbidden, dto.APIResponse{
						Code:    403,
						Message: "账号已被禁用",
					})
					return
				}
				c.Set("user_role", role)
			}
		}

		c.Set("user_id", uid)
		c.Next()
	}
}

func abortUnauthorized(c *gin.Context, message string) {
	c.AbortWithStatusJSON(http.StatusUnauthorized, dto.APIResponse{
		Code:    401,
		Message: message,
	})
}
