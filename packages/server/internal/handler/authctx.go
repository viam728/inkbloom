package handler

import "github.com/gin-gonic/gin"

// GetUserID extracts the authenticated numeric user id injected by the
// AuthJWT middleware ("user_id", int64). All business handlers must pass
// this value down to the service/repository layer so every query is scoped
// to the owning user (M1 isolation). Routes under /api/v1 are guaranteed to
// have run the auth middleware; a missing value degrades to 0 which matches
// no real user row.
func GetUserID(c *gin.Context) int64 {
	if v, ok := c.Get("user_id"); ok {
		if uid, ok := v.(int64); ok {
			return uid
		}
	}
	return 0
}
