package handler

import (
	"net/http"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/pkg/authtoken"
	"github.com/inkbloom/server/internal/service"
)

// PublicHandler serves the anonymous endpoints under /api/v1/public
// (task #51, M6): rollout feature flags and the desktop installer
// download. No AuthJWT is applied; flags optionally parses a Bearer
// token to compute the per-user enabled switch.
type PublicHandler struct {
	public *service.PublicService
	tokens *authtoken.Manager
}

// NewPublicHandler creates a new PublicHandler. tokens may be nil, in which
// case the enabled switch is never returned.
func NewPublicHandler(ps *service.PublicService, tokens *authtoken.Manager) *PublicHandler {
	return &PublicHandler{public: ps, tokens: tokens}
}

// Flags handles GET /api/v1/public/flags.
func (h *PublicHandler) Flags(c *gin.Context) {
	uid := h.optionalUID(c)
	data := h.public.Flags(uid)
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: data})
}

// optionalUID extracts the caller's uid from a Bearer token when present;
// anonymous (or unparsable-token) callers yield nil. Invalid tokens are
// silently ignored: this endpoint must stay reachable without auth.
func (h *PublicHandler) optionalUID(c *gin.Context) *int64 {
	if h.tokens == nil {
		return nil
	}
	auth := c.GetHeader("Authorization")
	const prefix = "Bearer "
	if !strings.HasPrefix(auth, prefix) {
		return nil
	}
	claims, err := h.tokens.ParseTyped(strings.TrimSpace(strings.TrimPrefix(auth, prefix)), authtoken.TypeAccess)
	if err != nil {
		return nil
	}
	uid, err := claims.UID()
	if err != nil {
		return nil
	}
	return &uid
}

// DownloadDesktop handles GET /api/v1/public/download/desktop: streams the
// installer artifact, or 404 JSON when nothing has been published yet.
func (h *PublicHandler) DownloadDesktop(c *gin.Context) {
	path, ok := h.public.DesktopInstaller()
	if !ok {
		c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "桌面端安装包尚未发布"})
		return
	}
	c.FileAttachment(path, filepath.Base(path))
}
