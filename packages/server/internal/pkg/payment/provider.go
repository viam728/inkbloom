// Package payment abstracts payment channels behind a provider interface.
//
// F4-3: the Provider contract now covers the full channel round-trip —
// Prepay returns the pay artefact (QR code / redirect URL) and VerifyNotify
// authenticates channel callbacks. Sandbox remains local-mode only.
package payment

import (
	"context"
	"errors"
	"net/http"
)

// ErrChannelUnavailable is returned by providers that are not wired up yet.
var ErrChannelUnavailable = errors.New("payment channel not available")

// ErrNotifyVerification is returned when a channel callback fails signature
// verification. Handlers must answer 401 and never reveal the reason.
var ErrNotifyVerification = errors.New("payment notify verification failed")

// PrepayResult carries the artefact a client needs to complete a payment.
// Exactly one of CodeURL / PayURL is normally populated depending on the
// channel flow (native QR vs page redirect).
type PrepayResult struct {
	Channel string            `json:"channel"`
	CodeURL string            `json:"code_url,omitempty"` // QR content (wechat native / alipay precreate)
	PayURL  string            `json:"pay_url,omitempty"`  // Redirect target (alipay page pay)
	Params  map[string]string `json:"params,omitempty"`   // Extra client-facing parameters
}

// Provider is a payment channel capable of prepaying an order and verifying
// its asynchronous notifications.
type Provider interface {
	// Channel returns the channel name (sandbox / alipay / wechat).
	Channel() string
	// Prepay initiates the payment on the external channel for the given
	// merchant order number. The sandbox provider succeeds immediately
	// (simulated payment); real channels return a pay URL / QR code.
	Prepay(ctx context.Context, outTradeNo string, amountCents int, subject string) (*PrepayResult, error)
	// VerifyNotify authenticates a channel callback request and returns the
	// merchant order number plus the channel trade number. Implementations
	// must treat any signature/format problem as ErrNotifyVerification.
	VerifyNotify(r *http.Request) (outTradeNo string, channelTradeNo string, err error)
}

// SandboxProvider is the development channel: every order pays instantly.
type SandboxProvider struct{}

// NewSandboxProvider creates a SandboxProvider.
func NewSandboxProvider() *SandboxProvider { return &SandboxProvider{} }

// Channel implements Provider.
func (p *SandboxProvider) Channel() string { return "sandbox" }

// Prepay simulates an instantly successful payment.
func (p *SandboxProvider) Prepay(_ context.Context, _ string, _ int, _ string) (*PrepayResult, error) {
	return &PrepayResult{Channel: "sandbox"}, nil
}

// VerifyNotify accepts the local-mode callback unverified. Production wiring
// must never register the sandbox notify route (F4-6).
func (p *SandboxProvider) VerifyNotify(r *http.Request) (string, string, error) {
	out := r.FormValue("out_trade_no")
	if out == "" {
		return "", "", ErrNotifyVerification
	}
	return out, "SANDBOX-" + out, nil
}
