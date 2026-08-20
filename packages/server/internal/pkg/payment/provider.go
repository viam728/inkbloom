// Package payment abstracts payment channels behind a provider interface.
// Only the sandbox channel is implemented (no merchant qualification yet);
// alipay/wechat are placeholders returning ErrChannelUnavailable.
package payment

import (
	"context"
	"errors"
)

// ErrChannelUnavailable is returned by providers that are not wired up yet.
var ErrChannelUnavailable = errors.New("payment channel not available")

// Provider is a payment channel capable of prepaying an order.
type Provider interface {
	// Channel returns the channel name (sandbox / alipay / wechat).
	Channel() string
	// Prepay initiates the payment on the external channel for the given
	// order. The sandbox provider succeeds immediately (simulated payment);
	// real channels will return a pay URL / prepay id later.
	Prepay(ctx context.Context, outTradeNo string, amountCents int, subject string) error
}

// SandboxProvider is the development channel: every order pays instantly.
type SandboxProvider struct{}

// NewSandboxProvider creates a SandboxProvider.
func NewSandboxProvider() *SandboxProvider { return &SandboxProvider{} }

// Channel implements Provider.
func (p *SandboxProvider) Channel() string { return "sandbox" }

// Prepay simulates an instantly successful payment.
func (p *SandboxProvider) Prepay(_ context.Context, _ string, _ int, _ string) error {
	return nil
}

// AlipayProvider is the placeholder for the Alipay channel.
type AlipayProvider struct{}

// NewAlipayProvider creates an AlipayProvider.
func NewAlipayProvider() *AlipayProvider { return &AlipayProvider{} }

// Channel implements Provider.
func (p *AlipayProvider) Channel() string { return "alipay" }

// Prepay is not implemented: merchant qualification is not in place yet.
func (p *AlipayProvider) Prepay(_ context.Context, _ string, _ int, _ string) error {
	// TODO: integrate Alipay open platform (app pay / web pay) once the
	// merchant account is approved.
	return ErrChannelUnavailable
}

// WechatProvider is the placeholder for the WeChat Pay channel.
type WechatProvider struct{}

// NewWechatProvider creates a WechatProvider.
func NewWechatProvider() *WechatProvider { return &WechatProvider{} }

// Channel implements Provider.
func (p *WechatProvider) Channel() string { return "wechat" }

// Prepay is not implemented: merchant qualification is not in place yet.
func (p *WechatProvider) Prepay(_ context.Context, _ string, _ int, _ string) error {
	// TODO: integrate WeChat Pay v3 API once the merchant account is approved.
	return ErrChannelUnavailable
}
