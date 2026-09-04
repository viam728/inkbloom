// Aliyun SMS provider (F4-2): dysmsapi 2017-05-25 SendSms via the POP
// signature (HMAC-SHA1) — pure net/http, no SDK dependency. Code-only per
// spec F4; manual checklist in docs/specs (F4 file).
package sms

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"go.uber.org/zap"
)

const aliyunSMSEndpoint = "https://dysmsapi.aliyuncs.com"

// AliyunConfig carries the dysmsapi credentials (F4-1).
type AliyunConfig struct {
	AccessKeyID     string
	AccessKeySecret string
	SignName        string
	TemplateCode    string
}

// AliyunProvider implements Provider against the Aliyun SMS gateway.
type AliyunProvider struct {
	cfg    AliyunConfig
	client *http.Client
	logger *zap.Logger
}

// NewAliyunProvider creates an AliyunProvider.
func NewAliyunProvider(cfg AliyunConfig, logger *zap.Logger) *AliyunProvider {
	return &AliyunProvider{cfg: cfg, client: &http.Client{Timeout: 10 * time.Second}, logger: logger}
}

// Send delivers the verification code through the Aliyun SMS channel.
func (p *AliyunProvider) Send(ctx context.Context, phone, code string) error {
	params := map[string]string{
		"AccessKeyId":        p.cfg.AccessKeyID,
		"Action":             "SendSms",
		"Format":             "JSON",
		"PhoneNumbers":       phone,
		"RegionId":           "cn-hangzhou",
		"SignName":           p.cfg.SignName,
		"SignatureMethod":    "HMAC-SHA1",
		"SignatureNonce":     fmt.Sprintf("%d", time.Now().UnixNano()),
		"SignatureVersion":   "1.0",
		"TemplateCode":       p.cfg.TemplateCode,
		"TemplateParam":      fmt.Sprintf(`{"code":%q}`, code),
		"Timestamp":          time.Now().UTC().Format("2006-01-02T15:04:05Z"),
		"Version":            "2017-05-25",
	}

	// POP v1 canonicalization: percent-encode sorted k=v pairs, then sign
	// the "GET&%2F&<encoded query>" string with HMAC-SHA1(secret + "&").
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	pairs := make([]string, 0, len(keys))
	for _, k := range keys {
		pairs = append(pairs, popEncode(k)+"="+popEncode(params[k]))
	}
	canonicalQuery := strings.Join(pairs, "&")
	stringToSign := "GET&%2F&" + popEncode(canonicalQuery)

	mac := hmac.New(sha1.New, []byte(p.cfg.AccessKeySecret+"&"))
	mac.Write([]byte(stringToSign))
	params["Signature"] = base64.StdEncoding.EncodeToString(mac.Sum(nil))

	form := url.Values{}
	for k, v := range params {
		form.Set(k, v)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, aliyunSMSEndpoint+"?"+form.Encode(), nil)
	if err != nil {
		return fmt.Errorf("aliyun sms: build request: %w", err)
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return fmt.Errorf("aliyun sms: call gateway: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("aliyun sms: read response: %w", err)
	}
	var parsed struct {
		Code    string `json:"Code"`
		Message string `json:"Message"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return fmt.Errorf("aliyun sms: decode response: %w", err)
	}
	if parsed.Code != "OK" {
		return fmt.Errorf("aliyun sms: send failed (code=%s): %s", parsed.Code, parsed.Message)
	}
	p.logger.Info("aliyun sms sent", zap.String("phone", phone))
	return nil
}

// popEncode implements the Aliyun POP percent-encoding (RFC3986 + "*").
func popEncode(s string) string {
	encoded := url.QueryEscape(s)
	encoded = strings.ReplaceAll(encoded, "+", "%20")
	encoded = strings.ReplaceAll(encoded, "*", "%2A")
	encoded = strings.ReplaceAll(encoded, "%7E", "~")
	return encoded
}
