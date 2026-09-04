// Package assetguard decides whether a user may read a /assets/files/...
// path. Neither existing transport authenticator proves ownership: a signed
// URL only binds (uid, path, exp) — signing happens on request and the path
// is client-supplied — and a Bearer token only proves "some logged-in user".
// Ownership must therefore be re-derived from the path itself.
//
// Recognized layouts (see storage.FileStorage):
//
//	/assets/files/{novelID}/assets/...   → owned by the novel's user
//	/assets/files/{novelID}/gallery/...  → owned by the novel's user
//	/assets/files/_media/u{uid}/...      → owned by uid (path-derivable)
//	/assets/files/_memo/u{uid}/...       → owned by uid (path-derivable)
//	/assets/files/_media/portraits/...   → shared area, any authed user
//
// Every other layout is denied (fail-closed).
package assetguard

import (
	"context"
	"strconv"
	"strings"
)

// assetPrefix is the static-mount prefix every guarded path starts with.
const assetPrefix = "/assets/files/"

// NovelOwner reports whether userID owns novelID. Backed by
// NovelRepository.GetByID, which is already user-scoped and degrades
// ownership violations to "not found".
type NovelOwner func(ctx context.Context, userID, novelID int64) bool

// Guardian implements the ownership policy for the static asset route and
// the /assets/sign issuance endpoint.
type Guardian struct {
	ownsNovel NovelOwner
}

// New creates a Guardian. ownsNovel must be non-nil for novel-scoped paths
// to be granted; with it nil every novel-scoped request is denied.
func New(ownsNovel NovelOwner) *Guardian {
	return &Guardian{ownsNovel: ownsNovel}
}

// Owns reports whether userID may read assetPath (a /assets/files/... URL
// path, without query string). Fail-closed: any path whose ownership cannot
// be derived from its layout is denied.
func (g *Guardian) Owns(ctx context.Context, userID int64, assetPath string) bool {
	rel := strings.TrimPrefix(assetPath, assetPrefix)
	if rel == assetPath || rel == "" {
		return false
	}
	seg, rest, _ := strings.Cut(rel, "/")

	switch {
	case seg == "_media" || seg == "_memo":
		owner, hasOwner := strings.CutPrefix(rest, "u")
		if !hasOwner {
			// Shared area (e.g. _media/portraits): any authenticated user.
			return true
		}
		ownerSeg := owner
		if i := strings.IndexByte(ownerSeg, '/'); i >= 0 {
			ownerSeg = ownerSeg[:i]
		}
		uid, err := strconv.ParseInt(ownerSeg, 10, 64)
		return err == nil && uid > 0 && uid == userID

	case seg == "gallery":
		// Novel-scoped gallery without an owning id in the path: ownership
		// is not derivable, deny (fail-closed).
		return false
	}

	novelID, err := strconv.ParseInt(seg, 10, 64)
	if err != nil || novelID <= 0 || g.ownsNovel == nil {
		return false
	}
	return g.ownsNovel(ctx, userID, novelID)
}
