package service

import (
	"context"
	"sync"
	"time"

	"github.com/inkbloom/server/internal/repository"
)

// userGuardTTL bounds how long a ban/role change can stay invisible to the
// AuthJWT middleware (task #49, M5: lightweight per-request re-check).
const userGuardTTL = 60 * time.Second

type userGuardEntry struct {
	status    int16
	role      int16
	fetchedAt time.Time
}

// UserGuard resolves the persisted account state (status + role) for the
// AuthJWT middleware with a short-lived in-memory cache, so the per-request
// re-check costs at most one user row lookup per minute per user.
type UserGuard struct {
	users repository.UserRepository

	mu    sync.Mutex
	cache map[int64]userGuardEntry
}

// NewUserGuard creates a UserGuard backed by the user repository.
func NewUserGuard(users repository.UserRepository) *UserGuard {
	return &UserGuard{users: users, cache: make(map[int64]userGuardEntry)}
}

// State returns the user's persisted (status, role). It satisfies
// middleware.UserStateChecker. Unknown users yield status=3 (cancelled) so
// a deleted account can never pass the gate.
func (g *UserGuard) State(ctx context.Context, uid int64) (int16, int16, error) {
	now := time.Now()

	g.mu.Lock()
	if entry, ok := g.cache[uid]; ok && now.Sub(entry.fetchedAt) < userGuardTTL {
		g.mu.Unlock()
		return entry.status, entry.role, nil
	}
	g.mu.Unlock()

	user, err := g.users.GetByID(ctx, uid)
	if err != nil {
		return 0, 0, err
	}
	var entry userGuardEntry
	if user == nil {
		entry = userGuardEntry{status: 3, fetchedAt: now} // cancelled: reject
	} else {
		entry = userGuardEntry{status: user.Status, role: user.Role, fetchedAt: now}
	}

	g.mu.Lock()
	// Opportunistic eviction: drop stale entries while the lock is held.
	if len(g.cache) > 1024 {
		for id, e := range g.cache {
			if now.Sub(e.fetchedAt) >= userGuardTTL {
				delete(g.cache, id)
			}
		}
	}
	g.cache[uid] = entry
	g.mu.Unlock()

	return entry.status, entry.role, nil
}

// Invalidate drops the cached entry for uid (call after ban/unban or role
// changes so the next request sees the fresh state).
func (g *UserGuard) Invalidate(uid int64) {
	g.mu.Lock()
	delete(g.cache, uid)
	g.mu.Unlock()
}
