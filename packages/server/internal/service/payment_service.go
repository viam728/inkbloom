package service

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"math/big"
	"time"

	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/pkg/payment"
	"github.com/inkbloom/server/internal/repository"
	"go.uber.org/zap"
)

// Billing errors surfaced by PaymentService (mapped to HTTP codes in the handler).
var (
	ErrInvalidPeriod        = errors.New("period must be month or year")
	ErrInvalidChannel       = errors.New("channel must be sandbox, alipay or wechat")
	ErrChannelNotOpen       = errors.New("支付通道暂未开放")
	ErrOrderNotFound        = errors.New("payment order not found")
	ErrOrderChannelMismatch = errors.New("order channel mismatch")
	ErrOrderClosed          = errors.New("payment order is closed")
)

// Subscription pricing (plan doc §3.1: 10 CNY/month, annual 96 CNY = 8折).
var periodPricing = map[string]struct {
	amountCents int
	days        int
}{
	"month": {amountCents: 1000, days: 30},
	"year":  {amountCents: 9600, days: 365},
}

// PaymentService creates payment orders and fulfills channel callbacks.
type PaymentService struct {
	orders    repository.PaymentOrderRepository
	subs      *SubscriptionService
	providers map[string]payment.Provider
	logger    *zap.Logger
}

// CreatedOrder bundles the persisted order with the channel's pay artefact
// (QR content / redirect URL) the client needs to complete the payment.
type CreatedOrder struct {
	Order   *model.PaymentOrder
	CodeURL string
	PayURL  string
}

// NewPaymentService creates a PaymentService from the registered providers.
func NewPaymentService(orders repository.PaymentOrderRepository, subs *SubscriptionService,
	providers []payment.Provider, logger *zap.Logger) *PaymentService {
	m := make(map[string]payment.Provider, len(providers))
	for _, p := range providers {
		m[p.Channel()] = p
	}
	return &PaymentService{orders: orders, subs: subs, providers: m, logger: logger}
}

// Provider exposes the registered channel provider (F4-6): the notify
// handler needs it to authenticate callbacks before fulfilling.
func (s *PaymentService) Provider(channel string) (payment.Provider, bool) {
	p, ok := s.providers[channel]
	return p, ok
}

// CreateOrder places a subscription order. The sandbox channel pays
// instantly: an internal callback fulfills the order and extends the
// subscription before the response is returned. Real channels keep the
// order in `created` until the verified notify arrives; the returned
// CreatedOrder carries the pay artefact for the client.
func (s *PaymentService) CreateOrder(ctx context.Context, userID int64, period, channel string) (*CreatedOrder, error) {
	price, ok := periodPricing[period]
	if !ok {
		return nil, ErrInvalidPeriod
	}
	provider, ok := s.providers[channel]
	if !ok {
		return nil, ErrInvalidChannel
	}

	// F4-6: the merchant order number must exist BEFORE Prepay — real
	// channels echo it in the pay artefact and the notify, and the old chain
	// passed an empty string here.
	outTradeNo := newOutTradeNo()
	prepay, err := provider.Prepay(ctx, outTradeNo, price.amountCents, "InkBloom 基础订阅")
	if err != nil {
		if errors.Is(err, payment.ErrChannelUnavailable) {
			return nil, ErrChannelNotOpen
		}
		return nil, err
	}

	order := &model.PaymentOrder{
		UserID:      userID,
		Kind:        model.OrderKindSubscription,
		Period:      &period,
		Channel:     channel,
		AmountCents: price.amountCents,
		OutTradeNo:  outTradeNo,
		Status:      model.OrderStatusCreated,
	}
	if err := s.orders.Create(ctx, order); err != nil {
		return nil, err
	}

	// Sandbox: immediately simulate a successful payment via the same
	// fulfillment path used by real channel callbacks.
	if channel == model.OrderChannelSandbox {
		if err := s.Notify(ctx, channel, order.OutTradeNo, "SANDBOX-"+outTradeNo); err != nil {
			return nil, err
		}
		order.Status = model.OrderStatusPaid
		now := time.Now()
		order.PaidAt = &now
		order.FulfilledAt = &now
	}
	return &CreatedOrder{Order: order, CodeURL: prepay.CodeURL, PayURL: prepay.PayURL}, nil
}

// Notify is the idempotent payment callback entry (also used internally by
// the sandbox channel). Duplicate notifications succeed without extending
// the subscription twice: the created→paid transition is an atomic
// conditional UPDATE, and only the winner extends. channelTradeNo records
// the channel's own transaction id (F4-6); the handler passes it only after
// VerifyNotify has authenticated the callback.
func (s *PaymentService) Notify(ctx context.Context, channel, outTradeNo, channelTradeNo string) error {
	order, err := s.orders.GetByOutTradeNo(ctx, outTradeNo)
	if err != nil {
		return err
	}
	if order == nil {
		return ErrOrderNotFound
	}
	if order.Channel != channel {
		return ErrOrderChannelMismatch
	}

	switch order.Status {
	case model.OrderStatusPaid:
		return nil // already fulfilled: idempotent success
	case model.OrderStatusClosed:
		return ErrOrderClosed
	}

	now := time.Now()
	won, err := s.orders.MarkPaid(ctx, order.ID, channelTradeNo, now)
	if err != nil {
		return err
	}
	if !won {
		return nil // concurrent callback already fulfilled it
	}

	price, ok := periodPricing[derefPeriod(order.Period)]
	if !ok {
		return fmt.Errorf("order %s has unknown period", order.OutTradeNo)
	}
	if err := s.subs.Extend(ctx, order.UserID, order.ID, price.days, now); err != nil {
		return err
	}
	s.logger.Info("payment order fulfilled",
		zap.Int64("order_id", order.ID),
		zap.String("out_trade_no", order.OutTradeNo),
		zap.Int64("user_id", order.UserID))
	return nil
}

// ListOrders returns the user's most recent payment orders.
func (s *PaymentService) ListOrders(ctx context.Context, userID int64, limit int) ([]model.PaymentOrder, error) {
	return s.orders.ListByUser(ctx, userID, limit)
}

func derefPeriod(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// newOutTradeNo builds the merchant order number: IB + timestamp + random.
func newOutTradeNo() string {
	n, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		n = big.NewInt(time.Now().UnixNano() % 1000000)
	}
	return fmt.Sprintf("IB%s%06d", time.Now().Format("20060102150405"), n.Int64())
}
