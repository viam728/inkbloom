package signedurl

import (
	"net/url"
	"testing"
	"time"
)

func TestSignVerifyRoundTrip(t *testing.T) {
	SetSecret("test-secret")
	const userID = int64(7)
	path := "/assets/files/_media/u7/gallery/ab/cd.jpg"

	sig, exp := Sign(userID, path, time.Hour)
	if !Verify(userID, path, sig, exp) {
		t.Fatal("valid signature must verify")
	}
}

func TestVerifyRejectsTampering(t *testing.T) {
	SetSecret("test-secret")
	const userID = int64(7)
	path := "/assets/files/_media/u7/gallery/ab/cd.jpg"

	sig, exp := Sign(userID, path, time.Hour)

	if Verify(userID, "/assets/files/_media/u7/gallery/zz/yy.jpg", sig, exp) {
		t.Error("signature must not verify against a different path")
	}
	if Verify(userID+1, path, sig, exp) {
		t.Error("signature must not verify against a different user")
	}
	_, past := Sign(userID, path, -time.Minute)
	if Verify(userID, path, sig, past) {
		t.Error("expired signature must not verify")
	}
	SetSecret("")
	if Verify(userID, path, sig, exp) {
		t.Error("signature must not verify with an empty secret")
	}
	SetSecret("test-secret")
}

func TestSignURLAppendsQuery(t *testing.T) {
	SetSecret("test-secret")
	const path = "/assets/files/_media/u7/gallery/ab/cd.jpg"

	u, err := url.Parse(SignURL(7, path))
	if err != nil {
		t.Fatalf("signed URL must parse: %v", err)
	}
	if u.Path != path {
		t.Fatalf("path = %q, want %q", u.Path, path)
	}

	uid, sig, exp := ParseQuery(u.Query())
	if !Verify(uid, path, sig, exp) {
		t.Fatal("signed URL must verify through ParseQuery")
	}
}
