package contentsafety

import (
	"context"

	"go.uber.org/zap"
	"gorm.io/gorm"
)

// Violation records one rejected content-safety check (tech plan v2 §9.1,
// migration 021). Append-only audit trail for the back-office review queue.
type Violation struct {
	ID        int64  `gorm:"primaryKey;autoIncrement"`
	UserID    int64  `gorm:"index"`
	Kind      string `gorm:"type:varchar(20);not null"` // text | image
	Content   string `gorm:"type:text"`                 // prompt text or image ref (truncated)
	Labels    string `gorm:"type:varchar(500)"`         // comma-joined violation labels
	Endpoint  string `gorm:"type:varchar(100)"`         // API endpoint that triggered the check
	CreatedAt int64  `gorm:"autoCreateTime"`
}

// TableName specifies the table name for Violation.
func (Violation) TableName() string { return "content_violations" }

// RecordingChecker wraps a Checker and persists every rejection to the
// content_violations audit table. Checker errors fail open (a moderation
// outage must not brick AI features) but are logged.
type RecordingChecker struct {
	inner  Checker
	db     *gorm.DB
	logger *zap.Logger
}

// NewRecordingChecker wraps inner with violation recording.
func NewRecordingChecker(inner Checker, db *gorm.DB, logger *zap.Logger) *RecordingChecker {
	return &RecordingChecker{inner: inner, db: db, logger: logger}
}

// CheckText implements Checker.
func (r *RecordingChecker) CheckText(ctx context.Context, text string) (Result, error) {
	return r.check(ctx, "text", text, func() (Result, error) { return r.inner.CheckText(ctx, text) })
}

// CheckImage implements Checker.
func (r *RecordingChecker) CheckImage(ctx context.Context, imageRef string) (Result, error) {
	return r.check(ctx, "image", imageRef, func() (Result, error) { return r.inner.CheckImage(ctx, imageRef) })
}

func (r *RecordingChecker) check(ctx context.Context, kind, content string, fn func() (Result, error)) (Result, error) {
	res, err := fn()
	if err != nil {
		r.logger.Warn("content safety check failed, failing open", zap.String("kind", kind), zap.Error(err))
		return Result{Pass: true}, nil
	}
	if !res.Pass {
		r.record(ctx, kind, content, res.Labels)
	}
	return res, nil
}

// record persists one rejection. Best-effort: a DB hiccup must not flip
// the moderation decision.
func (r *RecordingChecker) record(ctx context.Context, kind, content string, labels []string) {
	if r.db == nil {
		return
	}
	const maxContent = 500
	if len(content) > maxContent {
		content = content[:maxContent] + "…"
	}
	v := Violation{
		Kind:     kind,
		Content:  content,
		Labels:   joinLabels(labels),
		Endpoint: endpointFromContext(ctx),
	}
	if err := r.db.WithContext(ctx).Create(&v).Error; err != nil {
		r.logger.Warn("failed to record content violation", zap.Error(err))
	}
}

func joinLabels(labels []string) string {
	out := ""
	for i, l := range labels {
		if i > 0 {
			out += ","
		}
		out += l
	}
	return out
}

// endpointFromContext extracts the API endpoint stashed by the caller
// (handlers set it via WithEndpoint before invoking the checker).
func endpointFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(endpointKey{}).(string); ok {
		return v
	}
	return ""
}

type endpointKey struct{}

// WithEndpoint attaches the calling endpoint to the context so the audit
// record carries it.
func WithEndpoint(ctx context.Context, endpoint string) context.Context {
	return context.WithValue(ctx, endpointKey{}, endpoint)
}
