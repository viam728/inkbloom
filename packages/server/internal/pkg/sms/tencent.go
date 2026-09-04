// Tencent Cloud SMS provider (F4-2): sms.tencentcloudapi.com SendSms via the
// TC3-HMAC-SHA256 signature — pure net/http, no SDK dependency. Code-only
// per spec F4; manual checklist in docs/specs (F4 file).
package sms

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"go.uber.org/zap"
)

const tencentSMSHost = "sms.tencentcloudapi.com"

// TencentConfig carries the TC3 credentials (F4-1).
type TencentConfig struct {
	SecretID    string
	SecretKey   string
	SDKAppID    string
	SignName    string
	TemplateID  string
}

// TencentProvider implements Provider against the Tencent Cloud SMS API.
type TencentProvider struct {
	cfg    TencentConfig
	client *http.Client
	logger *zap.Logger
}

// NewTencentProvider creates a TencentProvider.
func NewTencentProvider(cfg TencentConfig, logger *zap.Logger) *TencentProvider {
	return &TencentProvider{cfg: cfg, client: &http.Client{Timeout: 10 * time.Second}, logger: logger}
}

// Send delivers the verification code through the Tencent Cloud channel.
func (p *TencentProvider) Send(ctx context.Context, phone, code string) error {
	payload := fmt.Sprintf(
		`{"PhoneNumberSet":["+86%s"],"SmsSdkAppId":%q,"SignName":%q,"TemplateId":%q,"TemplateParamSet":[%q]}`,
		phone, p.cfg.SDKAppID, p.cfg.SignName, p.cfg.TemplateID, code,
	)
	now := time.Now().UTC()
	date := now.Format("2006-01-02")
	timestamp := fmt.Sprintf("%d", now.Unix())

	// TC3 canonical request: POST / (empty query) + content-type/host headers.
	canonicalRequest := fmt.Sprintf("POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:%s\n\ncontent-type;host\n%s",
		tencentSMSHost, sha256Hex([]byte(payload)))
	stringToSign := fmt.Sprintf("TC3-HMAC-SHA256\n%s\n%s/%s/tc3_request\n%s",
		timestamp, date, "sms", sha256Hex([]byte(canonicalRequest)))

	kDate := hmacSHA256([]byte("TC3"+p.cfg.SecretKey), []byte(date))
	kService := hmacSHA256(kDate, []byte("sms"))
	kSigning := hmacSHA256(kService, []byte("tc3_request"))
	signature := hex.EncodeToString(hmacSHA256(kSigning, []byte(stringToSign)))

	auth := fmt.Sprintf("TC3-HMAC-SHA256 Credential=%s/%s/sms/tc3_request, SignedHeaders=content-type;host, Signature=%s",
		p.cfg.SecretID, date, signature)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://"+tencentSMSHost+"/", bytes.NewReader([]byte(payload)))
	if err != nil {
		return fmt.Errorf("tencent sms: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("Host", tencentSMSHost)
	req.Header.Set("X-TC-Action", "SendSms")
	req.Header.Set("X-TC-Version", "2021-01-11")
	req.Header.Set("X-TC-Timestamp", timestamp)
	req.Header.Set("Authorization", auth)

	resp, err := p.client.Do(req)
	if err != nil {
		return fmt.Errorf("tencent sms: call gateway: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("tencent sms: read response: %w", err)
	}
	var parsed struct {
		Response struct {
			SendStatusSet []struct {
				Code    string `json:"Code"`
				Message string `json:"Message"`
			} `json:"SendStatusSet"`
			Error *struct {
				Code    string `json:"Code"`
				Message string `json:"Message"`
			} `json:"Error"`
		} `json:"Response"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return fmt.Errorf("tencent sms: decode response: %w", err)
	}
	if parsed.Response.Error != nil {
		return fmt.Errorf("tencent sms: send failed (%s): %s", parsed.Response.Error.Code, parsed.Response.Error.Message)
	}
	if len(parsed.Response.SendStatusSet) > 0 && parsed.Response.SendStatusSet[0].Code != "Ok" {
		st := parsed.Response.SendStatusSet[0]
		return fmt.Errorf("tencent sms: send failed (%s): %s", st.Code, st.Message)
	}
	p.logger.Info("tencent sms sent", zap.String("phone", phone))
	return nil
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func hmacSHA256(key, data []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write(data)
	return mac.Sum(nil)
}
