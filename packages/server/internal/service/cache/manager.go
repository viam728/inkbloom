package cache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

// ErrNullCached is returned when a null value is cached (anti-penetration).
var ErrNullCached = errors.New("null value cached")

// CacheManager provides Cache-Aside pattern operations backed by Redis.
type CacheManager struct {
	redis  *redis.Client
	logger *zap.Logger
}

// NewCacheManager creates a new CacheManager.
func NewCacheManager(rdb *redis.Client, logger *zap.Logger) *CacheManager {
	return &CacheManager{redis: rdb, logger: logger}
}

// Get retrieves a value from cache. On miss, it calls loader to load the value
// and caches it with the given TTL.
func (m *CacheManager) Get(ctx context.Context, key string, dest interface{}, ttl time.Duration, loader func() (interface{}, error)) error {
	// Try cache first
	cached, err := m.redis.Get(ctx, key).Result()
	if err == nil {
		if err := json.Unmarshal([]byte(cached), dest); err == nil {
			return nil
		}
		m.logger.Warn("cache unmarshal failed, reloading", zap.String("key", key), zap.Error(err))
	} else if !errors.Is(err, redis.Nil) {
		m.logger.Warn("cache get failed", zap.String("key", key), zap.Error(err))
	}

	// Cache miss — load from source
	val, err := loader()
	if err != nil {
		return err
	}

	// Write to cache (best-effort)
	m.setAsync(ctx, key, val, ttl)

	// Decode into dest
	data, err := json.Marshal(val)
	if err != nil {
		return fmt.Errorf("cache marshal loaded value: %w", err)
	}
	return json.Unmarshal(data, dest)
}

// GetWithNullCache is like Get but also caches null/empty results with a short TTL
// to prevent cache penetration.
func (m *CacheManager) GetWithNullCache(ctx context.Context, key string, dest interface{}, ttl time.Duration, loader func() (interface{}, error)) error {
	// Try cache first
	cached, err := m.redis.Get(ctx, key).Result()
	if err == nil {
		if cached == NullValue {
			return ErrNullCached
		}
		if err := json.Unmarshal([]byte(cached), dest); err == nil {
			return nil
		}
		m.logger.Warn("cache unmarshal failed, reloading", zap.String("key", key), zap.Error(err))
	} else if !errors.Is(err, redis.Nil) {
		m.logger.Warn("cache get failed", zap.String("key", key), zap.Error(err))
	}

	// Cache miss — load from source
	val, err := loader()
	if err != nil {
		return err
	}

	// If val is nil, cache the null sentinel
	if val == nil {
		m.setAsync(ctx, key, NullValue, NullTTL)
		return ErrNullCached
	}

	// Write to cache (best-effort)
	m.setAsync(ctx, key, val, ttl)

	// Decode into dest
	data, err := json.Marshal(val)
	if err != nil {
		return fmt.Errorf("cache marshal loaded value: %w", err)
	}
	return json.Unmarshal(data, dest)
}

// Set writes a value to the cache with the specified TTL.
func (m *CacheManager) Set(ctx context.Context, key string, value interface{}, ttl time.Duration) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("cache marshal: %w", err)
	}
	if err := m.redis.Set(ctx, key, data, ttl).Err(); err != nil {
		return fmt.Errorf("cache set %s: %w", key, err)
	}
	return nil
}

// Delete removes one or more keys from the cache.
func (m *CacheManager) Delete(ctx context.Context, keys ...string) error {
	if len(keys) == 0 {
		return nil
	}
	if err := m.redis.Del(ctx, keys...).Err(); err != nil {
		return fmt.Errorf("cache delete: %w", err)
	}
	return nil
}

// setAsync writes to cache in a background goroutine (best-effort, non-blocking).
func (m *CacheManager) setAsync(ctx context.Context, key string, value interface{}, ttl time.Duration) {
	data, err := json.Marshal(value)
	if err != nil {
		m.logger.Warn("cache marshal failed", zap.String("key", key), zap.Error(err))
		return
	}
	// Use a background context so the set isn't cancelled by the caller's context
	go func() {
		bgCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := m.redis.Set(bgCtx, key, data, ttl).Err(); err != nil {
			m.logger.Warn("cache set failed", zap.String("key", key), zap.Error(err))
		}
	}()
}
