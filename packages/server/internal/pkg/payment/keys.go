// Shared key parsing helpers for the payment providers (F4-4 / F4-5).
package payment

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"strings"
)

// parseRSAPrivateKey accepts PKCS1 and PKCS8 PEM payloads.
func parseRSAPrivateKey(pemText string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(pemText))
	if block == nil {
		return nil, errors.New("no PEM block found")
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("PKCS8 payload is not an RSA private key")
	}
	return key, nil
}

// parseRSAPublicKey accepts a PEM PUBLIC KEY block or the raw base64 payload
// the Alipay console exports ("支付宝公钥" mode).
func parseRSAPublicKey(pemText string) (*rsa.PublicKey, error) {
	trimmed := strings.TrimSpace(pemText)
	var der []byte
	if strings.Contains(trimmed, "-----BEGIN") {
		block, _ := pem.Decode([]byte(trimmed))
		if block == nil {
			return nil, errors.New("no PEM block found")
		}
		der = block.Bytes
	} else {
		raw, err := base64.StdEncoding.DecodeString(trimmed)
		if err != nil {
			return nil, fmt.Errorf("decode raw public key: %w", err)
		}
		der = raw
	}
	pubAny, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, err
	}
	pub, ok := pubAny.(*rsa.PublicKey)
	if !ok {
		return nil, errors.New("payload is not an RSA public key")
	}
	return pub, nil
}
