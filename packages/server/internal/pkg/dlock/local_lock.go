package dlock

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// LocalLock is the single-process stand-in for DistributedLock (tech plan v2
// §3.3). The embedded desktop mode has exactly one server process, so the
// Redis-backed lock degenerates to an in-process keyed mutex. It satisfies
// the same Acquire/Release usage pattern, keeping TaskEngine code free of
// mode branches.
type LocalLock struct {
	mu   sync.Mutex
	held map[string]struct{}
}

// NewLocalLock creates an in-process lock registry.
func NewLocalLock() *LocalLock {
	return &LocalLock{held: make(map[string]struct{})}
}

// Acquire takes the named lock or reports it as already held. The TTL is
// accepted for interface parity; a single-process lock needs no expiry
// (the holder cannot crash without the whole process dying).
func (l *LocalLock) Acquire(_ context.Context, key string, _ time.Duration) (*Lock, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.held[key]; ok {
		return nil, fmt.Errorf("lock %q already held", key)
	}
	l.held[key] = struct{}{}
	return &Lock{localKey: key, local: l}, nil
}

// release removes the key from the held set (called by Lock.Release).
func (l *LocalLock) release(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.held, key)
}
