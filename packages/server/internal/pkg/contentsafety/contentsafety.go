// Package contentsafety implements the AIGC content-safety gateway
// (tech plan v2 §9.1). The default provider is a no-op (disabled); the
// Aliyun provider is wired once the content-safety service is provisioned
// (access key + endpoint via env). Every AI text/image entry point calls
// CheckText/CheckImage through this package so enabling the gateway is a
// config flip, not a code change.
package contentsafety

import (
	"context"
	"errors"
)

// ErrContentRejected is returned when the gateway flags content as a
// violation. Handlers map it to a user-facing compliance message.
var ErrContentRejected = errors.New("内容未通过安全审核")

// Result is the outcome of one content check.
type Result struct {
	// Pass reports whether the content may proceed.
	Pass bool
	// Labels carries the violation labels (e.g. "porn", "politics") for
	// the audit record; empty when Pass is true.
	Labels []string
}

// Checker is the narrow capability the AI/AIGC handlers need.
type Checker interface {
	// CheckText validates user-supplied or model-generated text.
	CheckText(ctx context.Context, text string) (Result, error)
	// CheckImage validates a generated image by its accessible URL/path.
	CheckImage(ctx context.Context, imageRef string) (Result, error)
}

// NoopChecker passes everything (gateway disabled). A WARN is logged once
// at startup by main when the gateway is off in cloud mode.
type NoopChecker struct{}

// NewNoopChecker creates the disabled-gateway checker.
func NewNoopChecker() *NoopChecker { return &NoopChecker{} }

// CheckText implements Checker.
func (n *NoopChecker) CheckText(_ context.Context, _ string) (Result, error) {
	return Result{Pass: true}, nil
}

// CheckImage implements Checker.
func (n *NoopChecker) CheckImage(_ context.Context, _ string) (Result, error) {
	return Result{Pass: true}, nil
}
