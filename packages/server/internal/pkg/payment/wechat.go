// WeChat Pay v3 provider (F4-5): Native (QR) transactions with
// WECHATPAY2-SHA256-RSA2048 request signing, platform-certificate callback
// verification and APIv3-key AES-256-GCM resource decryption.
//
// Code-only implementation (spec F4: no merchant qualification yet). The
// manual verification checklist lives in docs/specs (F4 file).
package payment

import (
	"bytes"
	"context"
	"crypto"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	wechatGateway     = "https://api.mch.weixin.qq.com"
	wechatNativePath  = "/v3/pay/transactions/native"
	wechatCertsPath   = "/v3/certificates"
	wechatAuthScheme  = "WECHATPAY2-SHA256-RSA2048"
	notifyFreshWindow = 5 * time.Minute
)

// WechatConfig carries the merchant APIv3 credentials (F4-1). The private
// key is the merchant API certificate key; secrets come from env only.
type WechatConfig struct {
	AppID         string
	MchID         string
	CertSerialNo  string
	PrivateKeyPEM string
	APIv3Key      string // 32 bytes
	NotifyURL     string
}

// WechatProvider implements Provider for WeChat Pay v3.
type WechatProvider struct {
	cfg        WechatConfig
	privateKey *rsa.PrivateKey
	client     *http.Client

	// Platform certificates (public keys) for callback verification, fetched
	// from /v3/certificates and refreshed at most every 30 minutes (F4-5).
	certsMu      sync.RWMutex
	certSerials  map[string]*rsa.PublicKey
	certsFetched time.Time
}

// NewWechatProvider parses the merchant key and validates the config. Only
// construct when the channel is enabled (F4-6).
func NewWechatProvider(cfg WechatConfig) (*WechatProvider, error) {
	if len(cfg.APIv3Key) != 32 {
		return nil, errors.New("wechat: APIv3 key must be exactly 32 bytes")
	}
	priv, err := parseRSAPrivateKey(cfg.PrivateKeyPEM)
	if err != nil {
		return nil, fmt.Errorf("wechat: parse merchant private key: %w", err)
	}
	return &WechatProvider{
		cfg:         cfg,
		privateKey:  priv,
		client:      &http.Client{Timeout: 10 * time.Second},
		certSerials: map[string]*rsa.PublicKey{},
	}, nil
}

// Channel implements Provider.
func (p *WechatProvider) Channel() string { return "wechat" }
// Prepay places a Native (QR) order and returns the code_url.
func (p *WechatProvider) Prepay(ctx context.Context, outTradeNo string, amountCents int, subject string) (*PrepayResult, error) {
	if outTradeNo == "" {
		return nil, errors.New("wechat: outTradeNo must be generated before Prepay")
	}
	body, err := json.Marshal(map[string]interface{}{
		"appid":        p.cfg.AppID,
		"mchid":        p.cfg.MchID,
		"description":  subject,
		"out_trade_no": outTradeNo,
		"notify_url":   p.cfg.NotifyURL,
		"amount":       map[string]interface{}{"total": amountCents, "currency": "CNY"},
	})
	if err != nil {
		return nil, fmt.Errorf("wechat: marshal request: %w", err)
	}

	respBody, err := p.signedCall(ctx, http.MethodPost, wechatNativePath, body)
	if err != nil {
		return nil, err
	}
	var parsed struct {
		CodeURL string `json:"code_url"`
	}
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return nil, fmt.Errorf("wechat: decode response: %w", err)
	}
	if parsed.CodeURL == "" {
		return nil, errors.New("wechat: empty code_url in response")
	}
	return &PrepayResult{Channel: "wechat", CodeURL: parsed.CodeURL}, nil
}

// VerifyNotify validates the Wechatpay-Signature header against the cached
// platform certificate, decrypts the AES-256-GCM resource and returns the
// merchant / channel trade numbers.
func (p *WechatProvider) VerifyNotify(r *http.Request) (string, string, error) {
	ts := r.Header.Get("Wechatpay-Timestamp")
	nonce := r.Header.Get("Wechatpay-Nonce")
	serial := r.Header.Get("Wechatpay-Serial")
	sig := r.Header.Get("Wechatpay-Signature")
	if ts == "" || nonce == "" || serial == "" || sig == "" {
		return "", "", ErrNotifyVerification
	}
	tsSecs, err := strconv.ParseInt(ts, 10, 64)
	if err != nil || time.Since(time.Unix(tsSecs, 0)) > notifyFreshWindow {
		return "", "", ErrNotifyVerification
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return "", "", ErrNotifyVerification
	}
	message := ts + "\n" + nonce + "\n" + string(body) + "\n"

	pub, err := p.platformKey(r.Context(), serial)
	if err != nil {
		return "", "", ErrNotifyVerification
	}
	sigBytes, err := base64.StdEncoding.DecodeString(sig)
	if err != nil {
		return "", "", ErrNotifyVerification
	}
	digest := sha256.Sum256([]byte(message))
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, digest[:], sigBytes); err != nil {
		return "", "", ErrNotifyVerification
	}

	var envelope struct {
		Resource struct {
			Nonce          string `json:"nonce"`
			Ciphertext     string `json:"ciphertext"`
			AssociatedData string `json:"associated_data"`
		} `json:"resource"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return "", "", ErrNotifyVerification
	}
	plaintext, err := p.aeadDecrypt(envelope.Resource.Ciphertext, envelope.Resource.Nonce, envelope.Resource.AssociatedData)
	if err != nil {
		return "", "", ErrNotifyVerification
	}
	var payload struct {
		OutTradeNo    string `json:"out_trade_no"`
		TransactionID string `json:"transaction_id"`
		TradeState    string `json:"trade_state"`
	}
	if err := json.Unmarshal(plaintext, &payload); err != nil {
		return "", "", ErrNotifyVerification
	}
	if payload.TradeState != "SUCCESS" {
		return "", "", ErrNotifyVerification
	}
	return payload.OutTradeNo, payload.TransactionID, nil
}
// signedCall issues an Authorization-signed v3 request and returns the body.
func (p *WechatProvider) signedCall(ctx context.Context, method, path string, body []byte) ([]byte, error) {
	nonce, err := randNonce()
	if err != nil {
		return nil, fmt.Errorf("wechat: nonce: %w", err)
	}
	ts := time.Now().Unix()
	message := fmt.Sprintf("%s\n%s\n%d\n%s\n%s\n", method, path, ts, nonce, string(body))
	digest := sha256.Sum256([]byte(message))
	sig, err := rsa.SignPKCS1v15(rand.Reader, p.privateKey, crypto.SHA256, digest[:])
	if err != nil {
		return nil, fmt.Errorf("wechat: sign: %w", err)
	}
	auth := fmt.Sprintf(`%s mchid="%s",nonce_str="%s",signature="%s",timestamp="%d",serial_no="%s"`,
		wechatAuthScheme, p.cfg.MchID, nonce, base64.StdEncoding.EncodeToString(sig), ts, p.cfg.CertSerialNo)

	req, err := http.NewRequestWithContext(ctx, method, wechatGateway+path, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("wechat: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", auth)

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("wechat: call gateway: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("wechat: read response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("wechat: gateway error (%d): %s", resp.StatusCode, string(data))
	}
	return data, nil
}

// platformKey returns the platform public key for a certificate serial,
// fetching /v3/certificates at most every 30 minutes.
func (p *WechatProvider) platformKey(ctx context.Context, serial string) (*rsa.PublicKey, error) {
	p.certsMu.RLock()
	pub, ok := p.certSerials[serial]
	fresh := time.Since(p.certsFetched) < 30*time.Minute
	p.certsMu.RUnlock()
	if ok && fresh {
		return pub, nil
	}

	body, err := p.signedCall(ctx, http.MethodGet, wechatCertsPath, nil)
	if err != nil {
		if ok {
			return pub, nil // serve the stale key rather than failing the notify
		}
		return nil, err
	}
	var parsed struct {
		Data []struct {
			Serial        string `json:"serial_no"`
			EncryptCertificate struct {
				Algorithm      string `json:"algorithm"`
				Nonce          string `json:"nonce"`
				AssociatedData string `json:"associated_data"`
				Ciphertext     string `json:"ciphertext"`
			} `json:"encrypt_certificate"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("wechat: decode certificates: %w", err)
	}
	p.certsMu.Lock()
	p.certsFetched = time.Now()
	for _, c := range parsed.Data {
		plain, err := p.aeadDecrypt(c.EncryptCertificate.Ciphertext, c.EncryptCertificate.Nonce, c.EncryptCertificate.AssociatedData)
		if err != nil {
			continue
		}
		if key, err := parseRSAPublicKey(string(plain)); err == nil {
			p.certSerials[c.Serial] = key
		}
	}
	p.certsMu.Unlock()

	p.certsMu.RLock()
	defer p.certsMu.RUnlock()
	if pub, ok := p.certSerials[serial]; ok {
		return pub, nil
	}
	return nil, fmt.Errorf("wechat: unknown platform certificate serial %s", serial)
}

// aeadDecrypt decrypts an APIv3 AES-256-GCM resource (F4-5).
func (p *WechatProvider) aeadDecrypt(ciphertextB64, nonceB64, associatedData string) ([]byte, error) {
	ciphertext, err := base64.StdEncoding.DecodeString(ciphertextB64)
	if err != nil || len(ciphertext) < 16 {
		return nil, errors.New("wechat: bad ciphertext")
	}
	block, err := aes.NewCipher([]byte(p.cfg.APIv3Key))
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, []byte(nonceB64), ciphertext, []byte(associatedData))
}

// randNonce produces a random 16-char nonce for the Authorization header.
func randNonce() (string, error) {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return strings.ToLower(base64.StdEncoding.EncodeToString(buf))[:16], nil
}
