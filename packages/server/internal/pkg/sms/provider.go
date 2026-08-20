// Package sms abstracts the SMS delivery channel behind a provider interface.
package sms

import (
	"context"
	"errors"

	"go.uber.org/zap"
)

// Provider delivers a verification code to a phone number.
type Provider interface {
	Send(ctx context.Context, phone, code string) error
}

// DevProvider is the development provider: it prints the code to the log
// instead of sending a real SMS (no SMS channel is wired up yet).
type DevProvider struct {
	logger *zap.Logger
}

// NewDevProvider creates a DevProvider.
func NewDevProvider(logger *zap.Logger) *DevProvider {
	return &DevProvider{logger: logger}
}

// Send logs the verification code at Info level.
func (p *DevProvider) Send(_ context.Context, phone, code string) error {
	p.logger.Info("sms verification code issued (dev provider, no real SMS sent)",
		zap.String("phone", phone),
		zap.String("code", code))
	return nil
}

// ProdProvider is the placeholder for the real SMS channel.
type ProdProvider struct{}

// NewProdProvider creates a ProdProvider.
func NewProdProvider() *ProdProvider { return &ProdProvider{} }

// Send is not implemented yet.
func (p *ProdProvider) Send(_ context.Context, _, _ string) error {
	// TODO: integrate a real SMS channel (e.g. Aliyun/Tencent Cloud SMS)
	// before enabling production sign-up flows.
	return errors.New("production sms provider not implemented")
}
