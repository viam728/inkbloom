package middleware

import (
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Prometheus metrics (tech plan v2 §8.1). Registered once via promauto; the
// /metrics endpoint is wired in server/http.go (cloud mode only).
var (
	httpRequestsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "inkbloom",
			Name:      "http_requests_total",
			Help:      "Total HTTP requests by route, method and status.",
		},
		[]string{"route", "method", "status"},
	)
	httpRequestDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Namespace: "inkbloom",
			Name:      "http_request_duration_seconds",
			Help:      "HTTP request latency by route.",
			Buckets:   prometheus.DefBuckets,
		},
		[]string{"route"},
	)
)

// Metrics returns a Gin middleware recording request count + latency.
// The route template (c.FullPath, e.g. /api/v1/novels/:id) is used instead
// of the raw path to keep cardinality bounded.
func Metrics() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()

		route := c.FullPath()
		if route == "" {
			route = "unmatched"
		}
		status := strconv.Itoa(c.Writer.Status())
		httpRequestsTotal.WithLabelValues(route, c.Request.Method, status).Inc()
		httpRequestDuration.WithLabelValues(route).Observe(time.Since(start).Seconds())
	}
}

// ── Task-engine / billing metrics (called from service code) ────────────────

var (
	taskProcessedTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "inkbloom",
			Name:      "task_processed_total",
			Help:      "Total task-engine executions by type and outcome.",
		},
		[]string{"type", "status"},
	)
	tokenConsumedTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Namespace: "inkbloom",
			Name:      "token_consumed_total",
			Help:      "Total token units consumed by endpoint.",
		},
		[]string{"endpoint"},
	)
)

// ObserveTask records one task-engine execution outcome.
func ObserveTask(taskType, status string) {
	taskProcessedTotal.WithLabelValues(taskType, status).Inc()
}

// ObserveTokenConsume records a token deduction for an endpoint.
func ObserveTokenConsume(endpoint string, units int64) {
	tokenConsumedTotal.WithLabelValues(endpoint).Add(float64(units))
}
