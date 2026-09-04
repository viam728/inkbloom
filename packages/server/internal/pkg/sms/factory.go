// Provider factory (F4-2): selects the SMS channel from configuration.
// Unconfigured/unknown credentials fail fast here rather than at first send.
package sms

import (
	"fmt"

	"go.uber.org/zap"
)

// AliyunSMSConfig / TencentSMSConfig mirror the config file sections; the
// Config type in internal/config maps them (F4-1).
type AliyunSMSConfig struct {
	AccessKeyID     string
	AccessKeySecret string
	SignName        string
	TemplateCode    string
}

type TencentSMSConfig struct {
	SecretID   string
	SecretKey  string
	SDKAppID   string
	SignName   string
	TemplateID string
}

// FactoryConfig is the normalized SMS configuration (provider + credentials).
type FactoryConfig struct {
	Provider string // dev (default) | aliyun | tencent
	Aliyun   AliyunSMSConfig
	Tencent  TencentSMSConfig
}

// New builds the configured Provider. The dev provider never transmits and
// never logs the code (F1-1 / P0-2).
func New(cfg FactoryConfig, logger *zap.Logger) (Provider, error) {
	switch cfg.Provider {
	case "", "dev":
		return NewDevProvider(logger), nil
	case "aliyun":
		if cfg.Aliyun.AccessKeyID == "" || cfg.Aliyun.AccessKeySecret == "" ||
			cfg.Aliyun.SignName == "" || cfg.Aliyun.TemplateCode == "" {
			return nil, fmt.Errorf("sms: provider=aliyun but credentials are incomplete")
		}
		return NewAliyunProvider(AliyunConfig(cfg.Aliyun), logger), nil
	case "tencent":
		if cfg.Tencent.SecretID == "" || cfg.Tencent.SecretKey == "" ||
			cfg.Tencent.SDKAppID == "" || cfg.Tencent.SignName == "" || cfg.Tencent.TemplateID == "" {
			return nil, fmt.Errorf("sms: provider=tencent but credentials are incomplete")
		}
		return NewTencentProvider(TencentConfig(cfg.Tencent), logger), nil
	default:
		return nil, fmt.Errorf("sms: unknown provider %q (want dev|aliyun|tencent)", cfg.Provider)
	}
}
