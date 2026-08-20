package dlock

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
)

// lockReleaseScript is a Lua script that atomically verifies the lock holder
// and releases the lock only if the token matches.
var lockReleaseScript = redis.NewScript(`
	if redis.call("GET", KEYS[1]) == ARGV[1] then
		return redis.call("DEL", KEYS[1])
	else
		return 0
	end
`)

// lockRenewScript is a Lua script that atomically verifies the lock holder
// and renews the TTL only if the token matches.
var lockRenewScript = redis.NewScript(`
	if redis.call("GET", KEYS[1]) == ARGV[1] then
		return redis.call("PEXPIRE", KEYS[1], ARGV[2])
	else
		return 0
	end
`)

// LockAcquirer is the lock capability consumed by the task engine. Both
// DistributedLock (cloud, Redis-backed) and LocalLock (desktop embedded
// mode, in-process) satisfy it (tech plan v2 §3.3).
type LockAcquirer interface {
	Acquire(ctx context.Context, key string, ttl time.Duration) (*Lock, error)
}

// DistributedLock provides distributed locking via Redis.
type DistributedLock struct {
	redis  *redis.Client
	logger *zap.Logger
}

// NewDistributedLock creates a new DistributedLock.
func NewDistributedLock(rdb *redis.Client, logger *zap.Logger) *DistributedLock {
	return &DistributedLock{
		redis:  rdb,
		logger: logger,
	}
}

// Lock represents an acquired distributed lock.
type Lock struct {
	key     string
	token   string // UUID holder identifier
	redis   *redis.Client
	stopDog chan struct{}
	logger  *zap.Logger

	// local-mode fields (tech plan v2 §3.3): when local is non-nil the lock
	// came from LocalLock and Release degenerates to an in-process delete.
	local    *LocalLock
	localKey string
}

// Acquire tries to acquire a distributed lock with the given key and TTL.
// It starts a watchdog goroutine that renews the lock every TTL/3.
func (l *DistributedLock) Acquire(ctx context.Context, key string, ttl time.Duration) (*Lock, error) {
	token := uuid.New().String()
	lockKey := "dlock:" + key

	// SETNX with TTL
	acquired, err := l.redis.SetNX(ctx, lockKey, token, ttl).Result()
	if err != nil {
		return nil, fmt.Errorf("redis SETNX: %w", err)
	}
	if !acquired {
		return nil, fmt.Errorf("lock %q already held", key)
	}

	lock := &Lock{
		key:     lockKey,
		token:   token,
		redis:   l.redis,
		stopDog: make(chan struct{}),
		logger:  l.logger,
	}

	// Start watchdog goroutine to renew the lock
	go lock.watchdog(ttl)

	return lock, nil
}

// Release atomically releases the lock if the caller is still the holder.
func (lk *Lock) Release(ctx context.Context) error {
	// In-process lock (local mode): no watchdog, no Redis round-trip.
	if lk.local != nil {
		lk.local.release(lk.localKey)
		return nil
	}

	// Stop the watchdog first
	close(lk.stopDog)

	result, err := lockReleaseScript.Run(ctx, lk.redis, []string{lk.key}, lk.token).Int64()
	if err != nil {
		return fmt.Errorf("redis release lock: %w", err)
	}
	if result == 0 {
		return fmt.Errorf("lock %q not held by this token", lk.key)
	}
	return nil
}

// watchdog periodically renews the lock TTL until stopped.
func (lk *Lock) watchdog(ttl time.Duration) {
	renewInterval := ttl / 3
	ticker := time.NewTicker(renewInterval)
	defer ticker.Stop()

	for {
		select {
		case <-lk.stopDog:
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			result, err := lockRenewScript.Run(ctx, lk.redis, []string{lk.key}, lk.token, int64(ttl/time.Millisecond)).Int64()
			cancel()
			if err != nil || result == 0 {
				lk.logger.Warn("lock watchdog: failed to renew lock",
					zap.String("key", lk.key),
					zap.Error(err),
				)
				return
			}
		}
	}
}
