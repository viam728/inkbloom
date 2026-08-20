// Package ratelimit implements the site-wide sliding-window rate limiter
// (tech plan v2 §5.1). Cloud mode is backed by Redis (atomic Lua script);
// the local embedded mode falls back to a process-local in-memory window so
// the desktop shell gets the same 429 contract without any external service.
package ratelimit

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// Decision is the outcome of one Allow check.
type Decision struct {
	// Allowed reports whether the request may proceed.
	Allowed bool
	// Limit is the configured ceiling for the window.
	Limit int64
	// Used is the consumption after this check (including the current hit).
	Used int64
	// RetryAfter is the suggested wait before retrying (seconds). Only
	// meaningful when Allowed is false.
	RetryAfter int64
}

// Limiter is the narrow capability the HTTP middleware needs.
type Limiter interface {
	// Allow consumes one unit of quota for key within the window.
	Allow(ctx context.Context, key string, limit int64, window time.Duration) (Decision, error)
}

// ── Redis sliding window (cloud) ─────────────────────────────────────────────

// slidingWindowScript atomically trims the window, counts, and appends.
// KEYS[1] = window key (sorted set of member=timestamp score=timestamp)
// ARGV: now_ms, window_ms, limit
// Returns: {allowed(0/1), used, oldest_ms}
var slidingWindowScript = redis.NewScript(`
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call("ZREMRANGEBYSCORE", key, 0, now - window)
local used = redis.call("ZCARD", key)
if used < limit then
	redis.call("ZADD", key, now, now .. ":" .. math.random(1000000))
	redis.call("PEXPIRE", key, window)
	return {1, used + 1, 0}
end
local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
local oldestScore = 0
if oldest[2] then
	oldestScore = tonumber(oldest[2])
end
return {0, used, oldestScore}
`)

// RedisLimiter implements Limiter on top of Redis sorted sets.
type RedisLimiter struct {
	rdb *redis.Client
}

// NewRedisLimiter creates a Redis-backed sliding-window limiter.
func NewRedisLimiter(rdb *redis.Client) *RedisLimiter {
	return &RedisLimiter{rdb: rdb}
}

// Allow implements Limiter.
func (l *RedisLimiter) Allow(ctx context.Context, key string, limit int64, window time.Duration) (Decision, error) {
	now := time.Now()
	res, err := slidingWindowScript.Run(ctx, l.rdb, []string{key},
		now.UnixMilli(), window.Milliseconds(), limit).Int64Slice()
	if err != nil {
		return Decision{}, fmt.Errorf("ratelimit script: %w", err)
	}
	if len(res) < 3 {
		return Decision{}, fmt.Errorf("ratelimit script: unexpected result %v", res)
	}
	if res[0] == 1 {
		return Decision{Allowed: true, Limit: limit, Used: res[1]}, nil
	}
	// res[2] = oldest hit in the window; retry once it slides out.
	retryAfter := int64(0)
	if res[2] > 0 {
		waitMs := res[2] + window.Milliseconds() - now.UnixMilli()
		if waitMs > 0 {
			retryAfter = (waitMs + 999) / 1000
		}
	}
	return Decision{Allowed: false, Limit: limit, Used: res[1], RetryAfter: retryAfter}, nil
}

// ── In-memory sliding window (local embedded mode) ───────────────────────────

type memWindow struct {
	hits []int64 // ascending hit timestamps (ms)
}

// MemLimiter is the process-local Limiter for the desktop embedded mode.
type MemLimiter struct {
	mu      sync.Mutex
	windows map[string]*memWindow
}

// NewMemLimiter creates an empty in-memory limiter.
func NewMemLimiter() *MemLimiter {
	return &MemLimiter{windows: make(map[string]*memWindow)}
}

// Allow implements Limiter.
func (l *MemLimiter) Allow(_ context.Context, key string, limit int64, window time.Duration) (Decision, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now().UnixMilli()
	windowMs := window.Milliseconds()
	cutoff := now - windowMs

	w, ok := l.windows[key]
	if !ok {
		w = &memWindow{}
		l.windows[key] = w
	}
	// Trim expired hits (ascending order: find first index >= cutoff).
	keep := 0
	for keep < len(w.hits) && w.hits[keep] <= cutoff {
		keep++
	}
	w.hits = append([]int64(nil), w.hits[keep:]...)

	used := int64(len(w.hits))
	if used < limit {
		w.hits = append(w.hits, now)
		return Decision{Allowed: true, Limit: limit, Used: used + 1}, nil
	}
	retryAfter := int64(0)
	if len(w.hits) > 0 {
		waitMs := w.hits[0] + windowMs - now
		if waitMs > 0 {
			retryAfter = (waitMs + 999) / 1000
		}
	}
	return Decision{Allowed: false, Limit: limit, Used: used, RetryAfter: retryAfter}, nil
}
