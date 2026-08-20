package contentsafety

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// AliyunChecker calls the Aliyun content-safety (green) API. It is wired
// once the service is provisioned; until then NewChecker returns the no-op.
//
// Config (env / config.yaml contentsafety.*):
//
//	endpoint   — e.g. green-cip.cn-shanghai.aliyuncs.com
//	access_key / secret_key — RAM credentials with Green read scope
//
// The implementation uses the Green CIP 2.0 text/image moderation API.
type AliyunChecker struct {
	endpoint  string
	accessKey string
	secretKey string
	client    *http.Client
}

// NewAliyunChecker creates the Aliyun-backed checker.
func NewAliyunChecker(endpoint, accessKey, secretKey string) *AliyunChecker {
	return &AliyunChecker{
		endpoint:  endpoint,
		accessKey: accessKey,
		secretKey: secretKey,
		client:    &http.Client{Timeout: 10 * time.Second},
	}
}

// CheckText implements Checker via the text moderation API.
func (c *AliyunChecker) CheckText(ctx context.Context, text string) (Result, error) {
	// Aliyun Green textModerationPlus: service=textModerationPlus
	payload := map[string]interface{}{
		"service": "textModerationPlus",
		"serviceParameters": map[string]string{
			"content": text,
		},
	}
	return c.invoke(ctx, "/green/cip/textModerationPlus", payload)
}

// CheckImage implements Checker via the image moderation API.
func (c *AliyunChecker) CheckImage(ctx context.Context, imageRef string) (Result, error) {
	payload := map[string]interface{}{
		"service": "baselineCheck",
		"serviceParameters": map[string]string{
			"imageUrl": imageRef,
		},
	}
	return c.invoke(ctx, "/green/cip/baselineCheck", payload)
}

// invoke posts one moderation request and maps the response to Result.
func (c *AliyunChecker) invoke(ctx context.Context, path string, payload map[string]interface{}) (Result, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return Result{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://"+c.endpoint+path, bytes.NewReader(body))
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	// NOTE: Aliyun Green uses HMAC-SHA1 signed headers (x-acs-*). The full
	// signature scheme is wired when the service is provisioned; this stub
	// carries the credentials as headers for the sandbox endpoint.
	req.Header.Set("x-acs-access-key-id", c.accessKey)

	resp, err := c.client.Do(req)
	if err != nil {
		return Result{}, fmt.Errorf("contentsafety invoke: %w", err)
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return Result{}, err
	}
	if resp.StatusCode != http.StatusOK {
		return Result{}, fmt.Errorf("contentsafety status %d: %s", resp.StatusCode, string(respBody))
	}

	var out struct {
		Code int `json:"Code"`
		Data struct {
			Result []struct {
				Label string `json:"Label"`
			} `json:"Result"`
		} `json:"Data"`
	}
	if err := json.Unmarshal(respBody, &out); err != nil {
		return Result{}, fmt.Errorf("contentsafety parse: %w", err)
	}
	labels := make([]string, 0, len(out.Data.Result))
	for _, r := range out.Data.Result {
		if r.Label != "" && r.Label != "nonLabel" {
			labels = append(labels, r.Label)
		}
	}
	return Result{Pass: len(labels) == 0, Labels: labels}, nil
}
