package handler

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/service"
)

// TokenHandler handles token billing HTTP requests (/api/v1/token*).
type TokenHandler struct {
	tokenService *service.TokenService
}

// NewTokenHandler creates a new TokenHandler.
func NewTokenHandler(ts *service.TokenService) *TokenHandler {
	return &TokenHandler{tokenService: ts}
}

// Balance handles GET /api/v1/token/balance
func (h *TokenHandler) Balance(c *gin.Context) {
	uid, ok := userIDFromContext(c)
	if !ok {
		return
	}

	acct, err := h.tokenService.Balance(c.Request.Context(), uid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: dto.TokenBalanceResponse{
		Balance:        acct.Balance,
		GiftBalance:    acct.GiftBalance,
		GiftExpiresAt:  acct.GiftExpiresAt,
		TotalRecharged: acct.TotalRecharged,
		TotalConsumed:  acct.TotalConsumed,
		LowBalance:     acct.UsableBalance(time.Now()) < model.LowBalanceThreshold,
	}})
}

// Ledger handles GET /api/v1/token/ledger?limit=50
func (h *TokenHandler) Ledger(c *gin.Context) {
	uid, ok := userIDFromContext(c)
	if !ok {
		return
	}

	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
	rows, err := h.tokenService.Ledger(c.Request.Context(), uid, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}

	items := make([]dto.TokenLedgerItem, 0, len(rows))
	for i := range rows {
		r := &rows[i]
		items = append(items, dto.TokenLedgerItem{
			ID:               r.ID,
			Direction:        r.Direction,
			Amount:           r.Amount,
			BalanceAfter:     r.BalanceAfter,
			Reason:           r.Reason,
			RefType:          r.RefType,
			Model:            r.Model,
			PromptTokens:     r.PromptTokens,
			CompletionTokens: r.CompletionTokens,
			Endpoint:         r.Endpoint,
			CreatedAt:        r.CreatedAt,
		})
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: dto.TokenLedgerResponse{Items: items}})
}

// Stats handles GET /api/v1/token/stats?range=day|week|month
func (h *TokenHandler) Stats(c *gin.Context) {
	uid, ok := userIDFromContext(c)
	if !ok {
		return
	}

	rng := c.DefaultQuery("range", "day")
	res, err := h.tokenService.Stats(c.Request.Context(), uid, rng)
	if err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	series := make([]dto.TokenStatsPoint, 0, len(res.Series))
	for _, p := range res.Series {
		series = append(series, dto.TokenStatsPoint{Bucket: p.Bucket, Consumed: p.Consumed})
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: dto.TokenStatsResponse{
		Total:  res.Total,
		Series: series,
	}})
}

// CreateOrder handles POST /api/v1/token/orders (sandbox pays instantly).
func (h *TokenHandler) CreateOrder(c *gin.Context) {
	uid, ok := userIDFromContext(c)
	if !ok {
		return
	}

	var req dto.CreateTokenOrderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	order, err := h.tokenService.CreateOrder(c.Request.Context(), uid, req.Pack, req.Channel)
	if err != nil {
		status, code := mapTokenError(err)
		c.JSON(status, dto.APIResponse{Code: code, Message: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, dto.APIResponse{Code: 201, Message: "created", Data: dto.CreateTokenOrderResponse{
		OrderID:     order.ID,
		OutTradeNo:  order.OutTradeNo,
		AmountCents: order.AmountCents,
		Pack:        order.Pack,
		Tokens:      order.Tokens,
		Status:      order.Status,
	}})
}

// ListOrders handles GET /api/v1/token/orders?limit=20
func (h *TokenHandler) ListOrders(c *gin.Context) {
	uid, ok := userIDFromContext(c)
	if !ok {
		return
	}

	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "20"))
	orders, err := h.tokenService.ListOrders(c.Request.Context(), uid, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}

	list := make([]dto.TokenOrderDTO, 0, len(orders))
	for i := range orders {
		o := &orders[i]
		list = append(list, dto.TokenOrderDTO{
			OrderID:     o.ID,
			Pack:        o.Pack,
			Tokens:      o.Tokens,
			AmountCents: o.AmountCents,
			Channel:     o.Channel,
			Status:      o.Status,
			CreatedAt:   o.CreatedAt,
		})
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: dto.TokenOrderListResponse{Orders: list}})
}

// mapTokenError maps token service sentinel errors to HTTP status + code.
func mapTokenError(err error) (int, int) {
	switch {
	case errors.Is(err, service.ErrInvalidTokenPack), errors.Is(err, service.ErrInvalidTokenChannel):
		return http.StatusBadRequest, 400
	case errors.Is(err, service.ErrTokenInsufficient):
		return http.StatusPaymentRequired, 402
	default:
		return http.StatusInternalServerError, 500
	}
}
