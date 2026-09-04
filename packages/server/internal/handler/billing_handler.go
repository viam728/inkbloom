package handler

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/service"
)

// SubscriptionHandler handles subscription HTTP requests (/api/v1/subscription*).
type SubscriptionHandler struct {
	subService *service.SubscriptionService
	payService *service.PaymentService
}

// NewSubscriptionHandler creates a new SubscriptionHandler.
func NewSubscriptionHandler(ss *service.SubscriptionService, ps *service.PaymentService) *SubscriptionHandler {
	return &SubscriptionHandler{subService: ss, payService: ps}
}

// Get handles GET /api/v1/subscription
func (h *SubscriptionHandler) Get(c *gin.Context) {
	uid, ok := userIDFromContext(c)
	if !ok {
		return
	}

	view, err := h.subService.View(c.Request.Context(), uid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: view})
}

// CreateOrder handles POST /api/v1/subscription/orders
func (h *SubscriptionHandler) CreateOrder(c *gin.Context) {
	uid, ok := userIDFromContext(c)
	if !ok {
		return
	}

	var req dto.CreateOrderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, dto.APIResponse{Code: 400, Message: err.Error()})
		return
	}

	created, err := h.payService.CreateOrder(c.Request.Context(), uid, req.Period, req.Channel)
	if err != nil {
		status, code := mapBillingError(err)
		c.JSON(status, dto.APIResponse{Code: code, Message: err.Error()})
		return
	}
	order := created.Order
	c.JSON(http.StatusCreated, dto.APIResponse{Code: 201, Message: "created", Data: dto.CreateOrderResponse{
		OrderID:     order.ID,
		OutTradeNo:  order.OutTradeNo,
		AmountCents: order.AmountCents,
		Channel:     order.Channel,
		Status:      order.Status,
		CodeURL:     created.CodeURL,
		PayURL:      created.PayURL,
	}})
}

// PaymentHandler handles payment callback / order list requests (/api/v1/payment*).
type PaymentHandler struct {
	payService *service.PaymentService
}

// NewPaymentHandler creates a new PaymentHandler.
func NewPaymentHandler(ps *service.PaymentService) *PaymentHandler {
	return &PaymentHandler{payService: ps}
}

// Notify handles POST /api/v1/payment/notify/:channel (no auth: channel callback).
// F4-6: the channel's own signature authenticates the request BEFORE the
// order is fulfilled — this endpoint used to accept a bare out_trade_no with
// zero verification, i.e. free subscriptions for anyone who could guess or
// observe an order number.
func (h *PaymentHandler) Notify(c *gin.Context) {
	channel := c.Param("channel")
	provider, ok := h.payService.Provider(channel)
	if !ok {
		c.JSON(http.StatusNotFound, dto.APIResponse{Code: 404, Message: "channel not available"})
		return
	}

	outTradeNo, channelTradeNo, err := provider.VerifyNotify(c.Request)
	if err != nil {
		// 401 with no detail: never leak why verification failed.
		c.JSON(http.StatusUnauthorized, dto.APIResponse{Code: 401, Message: "unauthorized"})
		return
	}

	if err := h.payService.Notify(c.Request.Context(), channel, outTradeNo, channelTradeNo); err != nil {
		status, code := mapBillingError(err)
		c.JSON(status, dto.APIResponse{Code: code, Message: err.Error()})
		return
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok"})
}

// ListOrders handles GET /api/v1/payment/orders?limit=20
func (h *PaymentHandler) ListOrders(c *gin.Context) {
	uid, ok := userIDFromContext(c)
	if !ok {
		return
	}

	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "20"))
	orders, err := h.payService.ListOrders(c.Request.Context(), uid, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, dto.APIResponse{Code: 500, Message: err.Error()})
		return
	}

	list := make([]dto.OrderDTO, 0, len(orders))
	for i := range orders {
		o := &orders[i]
		item := dto.OrderDTO{
			OrderID:     o.ID,
			Kind:        o.Kind,
			AmountCents: o.AmountCents,
			Channel:     o.Channel,
			Status:      o.Status,
			PaidAt:      o.PaidAt,
			CreatedAt:   o.CreatedAt,
		}
		if o.Period != nil {
			item.Period = *o.Period
		}
		list = append(list, item)
	}
	c.JSON(http.StatusOK, dto.APIResponse{Code: 200, Message: "ok", Data: dto.OrderListResponse{Orders: list}})
}

// mapBillingError maps billing service sentinel errors to HTTP status + code.
func mapBillingError(err error) (int, int) {
	switch err {
	case service.ErrInvalidPeriod, service.ErrInvalidChannel,
		service.ErrChannelNotOpen, service.ErrOrderChannelMismatch:
		return http.StatusBadRequest, 400
	case service.ErrOrderNotFound:
		return http.StatusNotFound, 404
	case service.ErrOrderClosed:
		return http.StatusConflict, 409
	default:
		return http.StatusInternalServerError, 500
	}
}
