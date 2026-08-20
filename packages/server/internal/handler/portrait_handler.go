package handler

import (
	"bytes"
	"fmt"
	"image"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/disintegration/imaging"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/pkg/storage"
)

const (
	// portraitMaxBytes caps portrait uploads at 8MB.
	portraitMaxBytes = 8 << 20
	// portraitMaxLongSide is the compression target for the full image.
	portraitMaxLongSide = 2048
	// portraitThumbSize is the long-side size of the generated thumbnail.
	portraitThumbSize = 256
)

// portraitMIMETypes is the allowed upload MIME whitelist.
var portraitMIMETypes = map[string]bool{
	"image/jpeg": true,
	"image/png":  true,
	"image/webp": true,
	"image/gif":  true,
}

// portraitExtensions is the allowed file-extension whitelist.
var portraitExtensions = map[string]bool{
	".jpg":  true,
	".jpeg": true,
	".png":  true,
	".webp": true,
	".gif":  true,
}

// PortraitHandler handles character-portrait uploads for novels and media.
// Images are decoded, resized to at most 2048px on the long side and saved
// with a UUID filename; a 256px thumbnail is generated alongside in a
// thumbs/ subdirectory. Both files stay inside the StaticFS root
// (~/.inkbloom/novels/*) so they are directly servable via /assets/files/*.
type PortraitHandler struct {
	fs *storage.FileStorage
}

// NewPortraitHandler creates a new PortraitHandler.
func NewPortraitHandler(fs *storage.FileStorage) *PortraitHandler {
	return &PortraitHandler{fs: fs}
}

// UploadNovelPortrait handles POST /novels/:id/portraits — multipart field
// "file". The processed image lands in NovelAssetDir(id)/portraits/ and the
// returned url is /assets/files/{id}/assets/portraits/{uuid}.{ext}.
func (h *PortraitHandler) UploadNovelPortrait(c *gin.Context) {
	novelID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || novelID <= 0 {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "invalid novel id"})
		return
	}

	dir := filepath.Join(h.fs.NovelAssetDir(novelID), "portraits")
	urlPrefix := fmt.Sprintf("/assets/files/%d/assets/portraits", novelID)
	h.uploadPortrait(c, dir, urlPrefix)
}

// UploadMediaPortrait handles POST /media/portraits — same semantics as the
// novel variant, but stores under ~/.inkbloom/novels/_media/portraits/ so
// the file remains inside the StaticFS root (url /assets/files/_media/...).
func (h *PortraitHandler) UploadMediaPortrait(c *gin.Context) {
	dir := filepath.Join(h.fs.NovelAssetDir(0), "_media", "portraits")
	h.uploadPortrait(c, dir, "/assets/files/_media/portraits")
}

// uploadPortrait validates the multipart upload, processes the image and
// writes full + thumbnail into dir, answering with the APIResponse envelope.
func (h *PortraitHandler) uploadPortrait(c *gin.Context, dir, urlPrefix string) {
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "missing multipart field \"file\""})
		return
	}
	defer file.Close()

	if header.Size <= 0 || header.Size > portraitMaxBytes {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "file must be between 1 byte and 8MB"})
		return
	}

	ext := strings.ToLower(filepath.Ext(header.Filename))
	if !portraitExtensions[ext] {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "unsupported file extension; allowed: jpg, jpeg, png, webp, gif"})
		return
	}

	data, err := io.ReadAll(io.LimitReader(file, portraitMaxBytes+1))
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "failed to read upload"})
		return
	}
	if len(data) > portraitMaxBytes {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "file exceeds the 8MB limit"})
		return
	}

	mime := strings.ToLower(strings.SplitN(http.DetectContentType(data), ";", 2)[0])
	if !portraitMIMETypes[mime] {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "unsupported content type; allowed: image/jpeg, image/png, image/webp, image/gif"})
		return
	}

	img, err := imaging.Decode(bytes.NewReader(data))
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: "failed to decode image: " + err.Error()})
		return
	}

	// Pick the storage format: JPEG stays JPEG; PNG/WEBP/GIF are re-encoded
	// as PNG (imaging has no webp encoder and animated GIF frames collapse
	// to the first frame on decode).
	outExt := ".png"
	if mime == "image/jpeg" {
		outExt = ".jpg"
	}
	name := uuid.New().String() + outExt

	if err := h.fs.EnsureDir(dir); err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "failed to create portrait directory"})
		return
	}
	thumbDir := filepath.Join(dir, "thumbs")
	if err := h.fs.EnsureDir(thumbDir); err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "failed to create thumbnail directory"})
		return
	}

	full := resizeLongSide(img, portraitMaxLongSide)
	thumb := resizeLongSide(full, portraitThumbSize)

	fullPath := filepath.Join(dir, name)
	if err := imaging.Save(full, fullPath); err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "failed to save portrait: " + err.Error()})
		return
	}

	thumbPath := filepath.Join(thumbDir, name)
	if err := imaging.Save(thumb, thumbPath); err != nil {
		// Roll back the already-written full image to avoid orphans.
		_ = os.Remove(fullPath)
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "failed to save thumbnail: " + err.Error()})
		return
	}

	info, err := os.Stat(fullPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: "failed to stat saved portrait"})
		return
	}

	bounds := full.Bounds()
	c.JSON(http.StatusOK, dto.APIResponse{
		Code:    200,
		Message: "ok",
		Data: gin.H{
			"url":       urlPrefix + "/" + name,
			"thumb_url": urlPrefix + "/thumbs/" + name,
			"width":     bounds.Dx(),
			"height":    bounds.Dy(),
			"size":      info.Size(),
		},
	})
}

// resizeLongSide scales img down so its longest side is at most maxSide,
// preserving the aspect ratio. Images already small enough pass through.
func resizeLongSide(img image.Image, maxSide int) image.Image {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	long := w
	if h > long {
		long = h
	}
	if long <= maxSide {
		return img
	}
	if w >= h {
		return imaging.Resize(img, maxSide, 0, imaging.Lanczos)
	}
	return imaging.Resize(img, 0, maxSide, imaging.Lanczos)
}
