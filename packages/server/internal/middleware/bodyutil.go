package middleware

import (
	"bytes"
	"encoding/json"
	"io"
)

// newReadCloser wraps raw bytes as a fresh request body so downstream
// handlers can re-read it after the rate limiter peeked at it.
func newReadCloser(b []byte) io.ReadCloser {
	return io.NopCloser(bytes.NewReader(b))
}

// jsonUnmarshal is a tiny indirection to keep the ratelimit middleware's
// imports narrow.
func jsonUnmarshal(data []byte, v interface{}) error {
	return json.Unmarshal(data, v)
}
