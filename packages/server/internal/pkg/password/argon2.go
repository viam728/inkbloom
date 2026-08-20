// Package password implements argon2id password hashing and verification.
package password

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// argon2id parameters (per product-commercialization-plan §2.4:
// 64MB memory, 3 iterations, parallelism 1).
const (
	argonTime    = 3
	argonMemory  = 64 * 1024
	argonThreads = 1
	argonKeyLen  = 32
	saltLen      = 16

	encodedPrefix = "$argon2id$v=19$"
)

// ErrMalformedHash is returned when an encoded hash cannot be parsed.
var ErrMalformedHash = errors.New("malformed password hash")

// Hash derives an argon2id hash of the password and encodes it in the
// PHC format: $argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash> (raw std-base64).
func Hash(password string) (string, error) {
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generating salt: %w", err)
	}

	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)

	b64 := base64.RawStdEncoding
	return fmt.Sprintf("%sm=%d,t=%d,p=%d$%s$%s",
		encodedPrefix, argonMemory, argonTime, argonThreads,
		b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

// Verify reports whether the password matches the encoded argon2id hash.
// Comparison is constant-time. Any parse/decode failure yields false.
func Verify(password, encoded string) bool {
	salt, expected, ok := decode(encoded)
	if !ok {
		return false
	}

	actual := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, uint32(len(expected)))
	return subtle.ConstantTimeCompare(actual, expected) == 1
}

func decode(encoded string) (salt, key []byte, ok bool) {
	if !strings.HasPrefix(encoded, encodedPrefix) {
		return nil, nil, false
	}
	parts := strings.Split(strings.TrimPrefix(encoded, encodedPrefix), "$")
	if len(parts) != 3 {
		return nil, nil, false
	}

	var memory, iterations uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[0], "m=%d,t=%d,p=%d", &memory, &iterations, &threads); err != nil {
		return nil, nil, false
	}
	// Only accept the parameters this package produces.
	if memory != argonMemory || iterations != argonTime || threads != argonThreads {
		return nil, nil, false
	}

	b64 := base64.RawStdEncoding
	salt, err := b64.DecodeString(parts[1])
	if err != nil {
		return nil, nil, false
	}
	key, err = b64.DecodeString(parts[2])
	if err != nil {
		return nil, nil, false
	}
	return salt, key, true
}
