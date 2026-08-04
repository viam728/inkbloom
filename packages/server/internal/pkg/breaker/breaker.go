package breaker

import (
	"context"
	"errors"
	"sync"
	"time"
)

// State represents the current state of the circuit breaker.
type State int

const (
	Closed   State = iota // normal operation
	Open                  // circuit open, failing fast
	HalfOpen              // testing with single probe request
)

// String returns the string representation of the state.
func (s State) String() string {
	switch s {
	case Closed:
		return "closed"
	case Open:
		return "open"
	case HalfOpen:
		return "half-open"
	default:
		return "unknown"
	}
}

// ErrCircuitOpen is returned when the circuit breaker is in the Open state.
var ErrCircuitOpen = errors.New("circuit breaker: circuit is open")

// Breaker implements a sliding-window circuit breaker.
type Breaker struct {
	name      string
	state     State
	failures  int
	successes int
	threshold int           // failure rate threshold (percentage, e.g. 50)
	window    int           // sliding window size (number of requests)
	timeout   time.Duration // how long to stay Open before transitioning to HalfOpen
	openedAt  time.Time
	mu        sync.Mutex
}

// NewBreaker creates a new circuit breaker.
//   - name: identifier for logging
//   - threshold: failure percentage (0-100) that trips the breaker
//   - window: number of requests in the sliding window
//   - timeout: duration to wait in Open state before allowing a probe
func NewBreaker(name string, threshold int, window int, timeout time.Duration) *Breaker {
	return &Breaker{
		name:      name,
		state:     Closed,
		threshold: threshold,
		window:    window,
		timeout:   timeout,
	}
}

// Execute runs the given function through the circuit breaker.
// In Open state it returns ErrCircuitOpen immediately.
// In HalfOpen state it allows one probe request.
func (b *Breaker) Execute(ctx context.Context, fn func() error) error {
	if err := b.beforeRequest(); err != nil {
		return err
	}

	err := fn()

	b.afterRequest(err)
	return err
}

// State returns the current state of the breaker.
func (b *Breaker) GetState() State {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.state
}

// beforeRequest checks whether the request is allowed.
func (b *Breaker) beforeRequest() error {
	b.mu.Lock()
	defer b.mu.Unlock()

	switch b.state {
	case Closed:
		return nil
	case Open:
		if time.Since(b.openedAt) >= b.timeout {
			b.state = HalfOpen
			return nil
		}
		return ErrCircuitOpen
	case HalfOpen:
		// Only one probe request at a time in half-open state
		return ErrCircuitOpen
	default:
		return nil
	}
}

// afterRequest records the result and transitions states if needed.
func (b *Breaker) afterRequest(err error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if err != nil {
		b.failures++
	} else {
		b.successes++
	}

	switch b.state {
	case HalfOpen:
		if err != nil {
			// Probe failed → back to Open
			b.state = Open
			b.openedAt = time.Now()
			b.resetCounters()
		} else {
			// Probe succeeded → Closed
			b.state = Closed
			b.resetCounters()
		}
	case Closed:
		total := b.failures + b.successes
		if total >= b.window {
			failRate := (b.failures * 100) / total
			if failRate >= b.threshold {
				b.state = Open
				b.openedAt = time.Now()
			}
			b.resetCounters()
		}
	}
}

// resetCounters resets failure and success counters.
func (b *Breaker) resetCounters() {
	b.failures = 0
	b.successes = 0
}
