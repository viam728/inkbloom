package dlock

import (
	"context"
	"testing"
	"time"
)

// LocalLock must satisfy the LockAcquirer interface used by the task engine.
var _ LockAcquirer = (*LocalLock)(nil)

func TestLocalLock_AcquireRelease(t *testing.T) {
	l := NewLocalLock()
	ctx := context.Background()

	lock, err := l.Acquire(ctx, "task:abc", 30*time.Second)
	if err != nil {
		t.Fatalf("first acquire should succeed: %v", err)
	}

	// Second acquire on the same key must fail while held.
	if _, err := l.Acquire(ctx, "task:abc", 30*time.Second); err == nil {
		t.Fatal("second acquire on held key should fail")
	}

	if err := lock.Release(ctx); err != nil {
		t.Fatalf("release should succeed: %v", err)
	}

	// After release the key is acquirable again.
	lock2, err := l.Acquire(ctx, "task:abc", 30*time.Second)
	if err != nil {
		t.Fatalf("acquire after release should succeed: %v", err)
	}
	_ = lock2.Release(ctx)
}

func TestLocalLock_IndependentKeys(t *testing.T) {
	l := NewLocalLock()
	ctx := context.Background()

	a, err := l.Acquire(ctx, "task:a", time.Second)
	if err != nil {
		t.Fatalf("acquire a: %v", err)
	}
	defer a.Release(ctx)

	// A different key is not blocked.
	b, err := l.Acquire(ctx, "task:b", time.Second)
	if err != nil {
		t.Fatalf("acquire b: %v", err)
	}
	defer b.Release(ctx)
}
