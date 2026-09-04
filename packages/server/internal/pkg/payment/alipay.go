// Alipay provider (F4-4): alipay.trade.precreate (QR) via the OpenAPI
// gateway with RSA2 signing and async notify verification. Code-only per
// spec F4; manual checklist in docs/specs (F4 file).
package payment

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

const (
	alipayGateway   = "https://openapi.alipay.com/gateway.do"
	alipayPrecreate = "alipay.trade.precreate"
	alipaySuccess   = "10000"
)

// AlipayConfig carries merchant credentials; keys come from env only (F4-1).
type AlipayConfig struct {
	AppID         string
	PrivateKeyPEM string
	PublicKeyPEM  string
	NotifyURL     string
}

// AlipayProvider implements Provider for the Alipay open platform.
type AlipayProvider struct {
	cfg        AlipayConfig
	privateKey *rsa.PrivateKey
	publicKey  *rsa.PublicKey
	client     *http.Client
}

// NewAlipayProvider parses the PEM keys. Only construct when enabled (F4-6).
func NewAlipayProvider(cfg AlipayConfig) (*AlipayProvider, error) {
	priv, err := parseRSAPrivateKey(cfg.PrivateKeyPEM)
	if err != nil {
		return nil, fmt.Errorf("alipay: parse merchant private key: %w", err)
	}
	pub, err := parseRSAPublicKey(cfg.PublicKeyPEM)
	if err != nil {
		return nil, fmt.Errorf("alipay: parse alipay public key: %w", err)
	}
	return &AlipayProvider{cfg: cfg, privateKey: priv, publicKey: pub,
		client: &http.Client{Timeout: 10 * time.Second}}, nil
}

// Channel implements Provider.
func (p *AlipayProvider) Channel() string { return "alipay" }
// Prepay creates a face-to-face (precreate) order and returns the QR content.
func (p *AlipayProvider) Prepay(ctx context.Context, outTradeNo string, amountCents int, subject string) (*PrepayResult, error) {
	if outTradeNo == "" {
		return nil, errors.New("alipay: outTradeNo must be generated before Prepay")
	}
	biz, err := json.Marshal(map[string]interface{}{
		"out_trade_no": outTradeNo,
		"total_amount": fmt.Sprintf("%.2f", float64(amountCents)/100),
		"subject":      subject,
	})
	if err != nil {
		return nil, fmt.Errorf("alipay: marshal biz_content: %w", err)
	}
	params := map[string]string{
		"app_id": p.cfg.AppID, "method": alipayPrecreate,
		"format": "JSON", "charset": "utf-8", "sign_type": "RSA2",
		"timestamp": time.Now().Format("2006-01-02 15:04:05"),
		"version":   "1.0", "notify_url": p.cfg.NotifyURL,
		"biz_content": string(biz),
	}
	params["sign"] = p.signParams(params)

	form := url.Values{}
	for k, v := range params {
		form.Set(k, v)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, alipayGateway, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("alipay: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded;charset=utf-8")

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("alipay: call gateway: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("alipay: read response: %w", err)
	}

	var parsed struct {
		Response map[string]any `json:"alipay_trade_precreate_response"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("alipay: decode response: %w", err)
	}
	code, _ := parsed.Response["code"].(string)
	if code != alipaySuccess {
		subMsg, _ := parsed.Response["sub_msg"].(string)
		return nil, fmt.Errorf("alipay: precreate failed (code=%s): %s", code, subMsg)
	}
	qr, _ := parsed.Response["qr_code"].(string)
	return &PrepayResult{Channel: "alipay", CodeURL: qr}, nil
}

// VerifyNotify validates the async notify signature against the Alipay
// public key and returns the merchant / channel trade numbers.
func (p *AlipayProvider) VerifyNotify(r *http.Request) (string, string, error) {
	if err := r.ParseForm(); err != nil {
		return "", "", ErrNotifyVerification
	}
	sign := r.Form.Get("sign")
	if sign == "" {
		return "", "", ErrNotifyVerification
	}
	// Canonical string: keys sorted ascending, exclude sign/sign_type.
	keys := make([]string, 0, len(r.Form))
	for k := range r.Form {
		if k == "sign" || k == "sign_type" {
			continue
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, k+"="+r.Form.Get(k))
	}
	digest := sha256.Sum256([]byte(strings.Join(parts, "&")))
	sig, err := base64.StdEncoding.DecodeString(sign)
	if err != nil {
		return "", "", ErrNotifyVerification
	}
	if err := rsa.VerifyPKCS1v15(p.publicKey, crypto.SHA256, digest[:], sig); err != nil {
		return "", "", ErrNotifyVerification
	}
	status := r.Form.Get("trade_status")
	if status != "TRADE_SUCCESS" && status != "TRADE_FINISHED" {
		return "", "", ErrNotifyVerification
	}
	return r.Form.Get("out_trade_no"), r.Form.Get("trade_no"), nil
}

// signParams RSA2-signs the canonical string (everything except sign).
func (p *AlipayProvider) signParams(params map[string]string) string {
	keys := make([]string, 0, len(params))
	for k := range params {
		if k == "sign" {
			continue
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	pairs := make([]string, 0, len(keys))
	for _, k := range keys {
		pairs = append(pairs, k+"="+params[k])
	}
	digest := sha256.Sum256([]byte(strings.Join(pairs, "&")))
	sig, err := rsa.SignPKCS1v15(rand.Reader, p.privateKey, crypto.SHA256, digest[:])
	if err != nil {
		panic(fmt.Sprintf("alipay: sign failed: %v", err))
	}
	return base64.StdEncoding.EncodeToString(sig)
}
