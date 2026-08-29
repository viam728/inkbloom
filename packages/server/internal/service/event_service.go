package service

import (
	"context"
	"encoding/json"
	"fmt"
	"unicode/utf8"

	"github.com/inkbloom/server/internal/dto"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
	"go.uber.org/zap"
	"gorm.io/datatypes"
)

// Analytics ingestion limits (plan A40). Props are advisory metadata for
// dashboards — they must never become a side channel for user content.
const (
	maxPropKeyLen   = 40
	maxPropValueLen = 200
	maxPropsPerItem = 20
)

// EventService validates and persists product-analytics events.
type EventService struct {
	repo repository.EventRepository
}

// NewEventService creates a new EventService.
func NewEventService(r repository.EventRepository) *EventService {
	return &EventService{repo: r}
}

// Ingest validates a batch and writes the surviving events.
//
// Rejection rules (a rejected item never fails the whole batch):
//   - event name must be lowercase snake_case (dto.ValidEventName);
//   - props are flattened to scalars, truncated, and capped per item.
//
// This keeps a malformed client from poisoning the fact table.
func (s *EventService) Ingest(ctx context.Context, userID int64, req *dto.EventBatchRequest) (*dto.EventBatchResponse, error) {
	accepted := make([]model.Event, 0, len(req.Events))
	rejected := 0

	for i := range req.Events {
		item := &req.Events[i]
		if !dto.ValidEventName(item.Event) {
			rejected++
			continue
		}
		props, err := sanitizeProps(item.Props)
		if err != nil {
			zap.L().Warn("analytics: dropping event props",
				zap.String("event", item.Event), zap.Error(err))
			props = nil
		}
		accepted = append(accepted, model.Event{
			UserID:      userID,
			AnonymousID: req.AnonymousID,
			SessionID:   req.SessionID,
			Event:       item.Event,
			Props:       props,
			OccurredAt:  item.TS,
		})
	}

	if len(accepted) == 0 {
		return &dto.EventBatchResponse{Accepted: 0, Rejected: rejected}, nil
	}
	if err := s.repo.CreateBatch(ctx, accepted); err != nil {
		return nil, err
	}
	return &dto.EventBatchResponse{Accepted: len(accepted), Rejected: rejected}, nil
}

// sanitizeProps flattens props to a JSON object of scalar values.
//
// Everything non-scalar is dropped (nested maps, slices, nil) so that:
//   - no user content (chapter text, titles) can be smuggled into analytics;
//   - the JSONB column stays cheap to index and aggregate.
func sanitizeProps(raw map[string]interface{}) (datatypes.JSON, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	out := make(map[string]interface{}, min(len(raw), maxPropsPerItem))
	n := 0
	for k, v := range raw {
		if n >= maxPropsPerItem {
			break
		}
		key := truncate(k, maxPropKeyLen)
		if key == "" {
			continue
		}
		switch val := v.(type) {
		case string:
			out[key] = truncate(val, maxPropValueLen)
		case float64, float32, int, int32, int64, uint, uint32, uint64:
			out[key] = val
		case bool:
			out[key] = val
		default:
			// Nested structures are intentionally discarded, not stringified:
			// stringifying would let a client push arbitrary content through.
			continue
		}
		n++
	}
	if len(out) == 0 {
		return nil, nil
	}
	b, err := json.Marshal(out)
	if err != nil {
		return nil, fmt.Errorf("marshal props: %w", err)
	}
	return datatypes.JSON(b), nil
}

// truncate shortens s to at most max runes, appending an ellipsis when cut.
func truncate(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	runes := []rune(s)
	return string(runes[:max]) + "…"
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
