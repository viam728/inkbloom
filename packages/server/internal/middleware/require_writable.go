package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
)

// WritabilityChecker reports whether a user is currently read-only
// (subscription expired → grace/dormant). Implemented by
// SubscriptionService.ReadOnly.
type WritabilityChecker func(ctx context.Context, userID int64) (readOnly bool, err error)

// writableExemptPrefixes bypass the read-only gate: auth flows, the billing
// endpoints themselves (query/renew/logout must keep working while expired).
var writableExemptPrefixes = []string{
	"/api/v1/auth",
	"/api/v1/subscription",
	"/api/v1/payment",
	// Token billing endpoints stay reachable while the subscription is
	// read-only: AI entitlements depend on the token balance, not on the
	// subscription state (task #43, M4).
	"/api/v1/token",
	// Back-office endpoints are exempt: operators must keep managing
	// accounts even when their own subscription is read-only (task #49).
	"/api/v1/admin",
	// Feedback submission stays reachable while read-only: it is a write
	// that carries no creative content (task #51, M6).
	"/api/v1/feedback",
	// Reading progress & follows stay reachable while read-only: a reader
	// whose own subscription has lapsed must still be able to bookmark
	// progress on someone else's public work (plan A18). The publish
	// endpoints are NOT exempt — publishing is creative authoring.
	"/api/v1/read",
}

// RequireWritable rejects write-method (POST/PUT/DELETE/PATCH) business
// requests with 402 when the caller's subscription is in grace/dormant
// (task #39, M3). GET/HEAD/OPTIONS always pass; exempt prefixes always pass.
// Checker errors fail open: billing trouble must not brick core features.
func RequireWritable(checker WritabilityChecker) gin.HandlerFunc {
	return func(c *gin.Context) {
		switch c.Request.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			c.Next()
			return
		}

		path := c.Request.URL.Path
		for _, prefix := range writableExemptPrefixes {
			if strings.HasPrefix(path, prefix) {
				c.Next()
				return
			}
		}

		if checker == nil {
			c.Next()
			return
		}
		uidVal, exists := c.Get("user_id")
		if !exists {
			c.Next() // upstream auth decides; nothing to check
			return
		}
		uid, _ := uidVal.(int64)
		if uid == 0 {
			c.Next() // legacy static-token backdoor keeps old behavior
			return
		}

		readOnly, err := checker(c.Request.Context(), uid)
		if err != nil || !readOnly {
			c.Next()
			return
		}

		c.AbortWithStatusJSON(http.StatusPaymentRequired, dto.APIResponse{
			Code:    402,
			Message: "订阅已到期，请续费后继续创作",
		})
	}
}
