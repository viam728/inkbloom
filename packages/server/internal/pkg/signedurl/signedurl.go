// Package signedurl signs asset URLs served by the public static file route
// /assets/files/* with a short-lived HMAC token, so private media/memo/draft
// assets can be authenticated without an Authorization header (an <img> tag
// cannot attach one). A signed URL is a capability that binds the requesting
// user, the exact path, and a non-reusable expiry window.
package signedurl

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// DefaultTTL is how long a signed asset URL stays valid. Long enough that
// editor-embedded image URLs (stored inside chapter prose) keep rendering
// across a session, short enough to bound the exposure of a leaked URL.
const DefaultTTL = 24 * time.Hour

// secret is the shared signing key, set once at startup from the finalized
// JWT secret so signatures cannot be forged by clients.
var secret []byte

// SetSecret installs the signing key. Call exactly once at startup after the
// JWT secret has been finalized (see cmd/server main.ensureJWTSecret).
func SetSecret(s string) { secret = []byte(s) }

// signature computes the HMAC-SHA256 of (userID, path, expiry).
func signature(userID int64, path string, exp int64) string {
	mac := hmac.New(sha256.New, secret)
	fmt.Fprintf(mac, "%d:%s:%d", userID, path, exp)
	return hex.EncodeToString(mac.Sum(nil))
}

// Sign returns the signature and expiry timestamp for a path bound to userID.
func Sign(userID int64, path string, ttl time.Duration) (string, int64) {
	exp := time.Now().Add(ttl).Unix()
	return signature(userID, path, exp), exp
}

// Verify reports whether sig is a valid signature for path bound to userID and
// not yet expired. An empty secret or an expired signature always fails.
func Verify(userID int64, path string, sig string, exp int64) bool {
	if len(secret) == 0 || sig == "" || exp < time.Now().Unix() {
		return false
	}
	expected := signature(userID, path, exp)
	return hmac.Equal([]byte(expected), []byte(sig))
}

// SignURL appends uid/sig/exp query parameters to an absolute asset path that
// starts with /assets/files. The signature binds the path WITHOUT the query
// string (the static route verifies against c.Param("filepath")).
func SignURL(userID int64, path string) string {
	sig, exp := Sign(userID, path, DefaultTTL)
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	return fmt.Sprintf("%s%suid=%d&sig=%s&exp=%d", path, sep, userID, sig, exp)
}

// ParseQuery extracts uid/sig/exp from a request query. All three are returned
// zero when absent.
func ParseQuery(raw map[string][]string) (userID int64, sig string, exp int64) {
	if v := raw["uid"]; len(v) > 0 {
		userID, _ = strconv.ParseInt(v[0], 10, 64)
	}
	if v := raw["sig"]; len(v) > 0 {
		sig = v[0]
	}
	if v := raw["exp"]; len(v) > 0 {
		exp, _ = strconv.ParseInt(v[0], 10, 64)
	}
	return userID, sig, exp
}
