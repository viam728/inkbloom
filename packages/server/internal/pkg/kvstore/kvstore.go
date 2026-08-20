package kvstore

import (
	"context"
	"errors"
	"sync"
	"time"
)

// ErrNotFound is returned by Get when the key does not exist (or expired).
// It plays the role redis.Nil plays for the Redis-backed implementation.
var ErrNotFound = errors.New("kvstore: key not found")

// Store is the narrow key-value surface the server actually needs from
// Redis: SMS verification codes, revocable refresh-token jtis and the
// cache-aside layer. Cloud mode is backed by Redis (see RedisStore); the
// local embedded mode (task #37, M2-a) is backed by MemStore so the whole
// auth/cache chain keeps working without any external service.
type Store interface {
	// Get returns the value for key or ErrNotFound.
	Get(ctx context.Context, key string) (string, error)
	// Set stores value under key with the given TTL (0 = no expiry).
	Set(ctx context.Context, key, value string, ttl time.Duration) error
	// SetNX stores value only when key does not exist yet. It reports
	// whether the write happened (false = key already present).
	SetNX(ctx context.Context, key, value string, ttl time.Duration) (bool, error)
	// Del removes keys and reports how many existed.
	Del(ctx context.Context, keys ...string) (int64, error)
	// KeysWithPrefix lists all live keys carrying the given prefix
	// (replaces the Redis SCAN iterator used for session revocation).
	KeysWithPrefix(ctx context.Context, prefix string) ([]string, error)
}

// ── In-memory implementation ───────────────────────────────────────────────

type memEntry struct {
	value     string
	expiresAt time.Time // zero value = never expires
}

func (e memEntry) expired(now time.Time) bool {
	return !e.expiresAt.IsZero() && now.After(e.expiresAt)
}

// MemStore is a process-local Store: a mutex-guarded map with lazy TTL
// eviction. Suitable for the single-user embedded desktop mode; it is NOT a
// Redis replacement for multi-instance cloud deployments.
type MemStore struct {
	mu    sync.Mutex
	items map[string]memEntry
}

// NewMemStore creates an empty MemStore.
func NewMemStore() *MemStore {
	return &MemStore{items: make(map[string]memEntry)}
}

func (m *MemStore) Get(_ context.Context, key string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.items[key]
	if !ok || e.expired(time.Now()) {
		delete(m.items, key)
		return "", ErrNotFound
	}
	return e.value, nil
}

func (m *MemStore) Set(_ context.Context, key, value string, ttl time.Duration) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.items[key] = memEntry{value: value, expiresAt: expiry(ttl)}
	return nil
}

func (m *MemStore) SetNX(_ context.Context, key, value string, ttl time.Duration) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	if e, ok := m.items[key]; ok && !e.expired(now) {
		return false, nil
	}
	m.items[key] = memEntry{value: value, expiresAt: expiry(ttl)}
	return true, nil
}

func (m *MemStore) Del(_ context.Context, keys ...string) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	var deleted int64
	for _, key := range keys {
		if e, ok := m.items[key]; ok && !e.expired(now) {
			deleted++
		}
		delete(m.items, key)
	}
	return deleted, nil
}

func (m *MemStore) KeysWithPrefix(_ context.Context, prefix string) ([]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	var keys []string
	for key, e := range m.items {
		if e.expired(now) {
			delete(m.items, key)
			continue
		}
		if len(key) >= len(prefix) && key[:len(prefix)] == prefix {
			keys = append(keys, key)
		}
	}
	return keys, nil
}

func expiry(ttl time.Duration) time.Time {
	if ttl <= 0 {
		return time.Time{}
	}
	return time.Now().Add(ttl)
}
