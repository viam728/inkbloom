package task_engine

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"time"

	"github.com/google/uuid"
	"github.com/inkbloom/server/internal/middleware"
	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/pkg/breaker"
	"github.com/inkbloom/server/internal/pkg/dlock"
	"github.com/inkbloom/server/internal/repository"
	"github.com/nats-io/nats.go"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

// NATSPublisher is the interface for publishing messages to NATS.
// Implemented by server.NATSManager.
type NATSPublisher interface {
	Publish(subject string, data []byte) error
	JetStream() nats.JetStreamContext
}

// TaskHandler is the interface that task processors must implement.
type TaskHandler interface {
	// Type returns the unique task type identifier.
	Type() string
	// Execute processes the task and returns the result.
	Execute(ctx context.Context, task model.Task) (json.RawMessage, error)
	// MaxRetries returns the maximum number of retries for this task type.
	MaxRetries() int
}

// HandlerRegistry maps task types to their handlers.
type HandlerRegistry map[string]TaskHandler

// TaskResult holds the outcome of task execution.
type TaskResult struct {
	TaskID string
	Result json.RawMessage
	Err    error
}

// TaskEngine orchestrates asynchronous task processing with worker pool,
// distributed locking, circuit breaking, and outbox pattern.
type TaskEngine struct {
	workerCount int
	taskCh      chan model.Task
	resultCh    chan TaskResult
	db          *gorm.DB
	redis       *redis.Client
	nats        NATSPublisher
	lock        dlock.LockAcquirer
	repo        repository.TaskRepository
	registry    HandlerRegistry
	breaker     *breaker.Breaker
	logger      *zap.Logger
	cancel      context.CancelFunc
}

// NewTaskEngine creates a new TaskEngine.
func NewTaskEngine(
	db *gorm.DB,
	rdb *redis.Client,
	nats NATSPublisher,
	lock dlock.LockAcquirer,
	repo repository.TaskRepository,
	cb *breaker.Breaker,
	logger *zap.Logger,
	workerCount int,
) *TaskEngine {
	return &TaskEngine{
		workerCount: workerCount,
		taskCh:      make(chan model.Task, workerCount*2),
		resultCh:    make(chan TaskResult, workerCount*2),
		db:          db,
		redis:       rdb,
		nats:        nats,
		lock:        lock,
		repo:        repo,
		registry:    make(HandlerRegistry),
		breaker:     cb,
		logger:      logger,
	}
}

// RegisterHandler registers a TaskHandler for its task type.
func (e *TaskEngine) RegisterHandler(handler TaskHandler) {
	e.registry[handler.Type()] = handler
	e.logger.Info("registered task handler",
		zap.String("type", handler.Type()),
		zap.Int("max_retries", handler.MaxRetries()),
	)
}

// Start launches the worker pool and begins processing tasks.
func (e *TaskEngine) Start(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	e.cancel = cancel

	// Subscribe to NATS for task.created events. A nil JetStream (local
	// embedded mode, task #37) means there is no remote task feed: workers
	// still run so in-process retries work, and tasks arrive only via
	// direct Submit.
	if js := e.nats.JetStream(); js != nil {
		_, err := js.Subscribe("aigc.task.created", func(msg *nats.Msg) {
			var task model.Task
			if err := json.Unmarshal(msg.Data, &task); err != nil {
				e.logger.Error("failed to unmarshal task from NATS", zap.Error(err))
				msg.Nak()
				return
			}

			select {
			case e.taskCh <- task:
				msg.Ack()
			default:
				e.logger.Warn("task channel full, NAK message", zap.String("task_id", task.ID))
				msg.Nak()
			}
		}, nats.ManualAck())
		if err != nil {
			cancel()
			return fmt.Errorf("nats subscribe: %w", err)
		}
	} else {
		e.logger.Info("task engine running without NATS feed (local mode)")
	}

	e.logger.Info("task engine started", zap.Int("workers", e.workerCount))

	// Start workers
	for i := 0; i < e.workerCount; i++ {
		go e.worker(ctx, i)
	}

	return nil
}

// SubmitLocal enqueues an already-persisted task directly into the worker
// pool (local embedded mode, tech plan v2 §3.2). The local mode has no
// JetStream subscription, so the outbox-published creation event is routed
// here via LocalBus.SetTaskSink. The taskJSON is the marshalled model.Task
// written by Submit's outbox row. A full queue drops the task with an error
// log — the pending row stays in the DB for the next recovery sweep.
func (e *TaskEngine) SubmitLocal(taskJSON []byte) {
	var task model.Task
	if err := json.Unmarshal(taskJSON, &task); err != nil {
		e.logger.Error("local task feed: failed to unmarshal task", zap.Error(err))
		return
	}
	select {
	case e.taskCh <- task:
	default:
		e.logger.Warn("local task feed: task channel full, task left pending",
			zap.String("task_id", task.ID))
	}
}

// Stop gracefully shuts down the task engine.
func (e *TaskEngine) Stop() {
	if e.cancel != nil {
		e.cancel()
	}
	close(e.taskCh)
	e.logger.Info("task engine stopped")
}

// Submit creates a task and an outbox entry within a single DB transaction.
func (e *TaskEngine) Submit(ctx context.Context, task model.Task) error {
	if task.ID == "" {
		task.ID = uuid.New().String()
	}
	if task.MaxRetries == 0 {
		handler, ok := e.registry[task.Type]
		if ok {
			task.MaxRetries = int16(handler.MaxRetries())
		} else {
			task.MaxRetries = 3
		}
	}
	task.Status = "pending"
	task.CreatedAt = time.Now()

	return e.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// 1. Write task record
		if err := tx.Create(&task).Error; err != nil {
			return fmt.Errorf("create task: %w", err)
		}

		// 2. Write outbox record
		taskJSON, err := json.Marshal(task)
		if err != nil {
			return fmt.Errorf("marshal task: %w", err)
		}
		outbox := model.Outbox{
			EventType: "aigc.task.created",
			Payload:   taskJSON,
			Status:    "pending",
			CreatedAt: time.Now(),
		}
		if err := tx.Create(&outbox).Error; err != nil {
			return fmt.Errorf("create outbox: %w", err)
		}

		return nil
	})
}

// worker consumes tasks from taskCh and processes them.
func (e *TaskEngine) worker(ctx context.Context, id int) {
	logger := e.logger.With(zap.Int("worker", id))
	logger.Info("worker started")

	for task := range e.taskCh {
		e.processTask(ctx, task, logger)
	}

	logger.Info("worker stopped")
}

// processTask handles a single task with distributed lock, circuit breaker, and retry logic.
func (e *TaskEngine) processTask(ctx context.Context, task model.Task, logger *zap.Logger) {
	logger = logger.With(zap.String("task_id", task.ID), zap.String("task_type", task.Type))

	// Acquire distributed lock to prevent duplicate processing
	lock, err := e.lock.Acquire(ctx, "task:"+task.ID, 30*time.Second)
	if err != nil {
		logger.Debug("task already being processed", zap.Error(err))
		return
	}
	defer func() {
		if releaseErr := lock.Release(ctx); releaseErr != nil {
			logger.Warn("failed to release lock", zap.Error(releaseErr))
		}
	}()

	// Update status → running
	if err := e.repo.UpdateStatus(ctx, task.ID, "running"); err != nil {
		logger.Error("failed to update task status to running", zap.Error(err))
		return
	}

	// Find handler
	handler, ok := e.registry[task.Type]
	if !ok {
		logger.Error("no handler registered for task type", zap.String("type", task.Type))
		e.repo.UpdateStatus(ctx, task.ID, "dead_letter")
		return
	}

	// Execute through circuit breaker
	var result json.RawMessage
	err = e.breaker.Execute(ctx, func() error {
		var execErr error
		result, execErr = handler.Execute(ctx, task)
		return execErr
	})

	if err != nil {
		logger.Error("task execution failed", zap.Error(err))
		e.handleFailure(ctx, task, err, logger)
		return
	}

	// Success: update status, result, progress
	now := time.Now()
	e.db.WithContext(ctx).Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]interface{}{
		"status":       "success",
		"result":       result,
		"progress":     100,
		"completed_at": now,
	})
	middleware.ObserveTask(task.Type, "success") // v2 §8.1

	// Publish completion event (user_id routes the WS push to the owner,
	// tech plan v2 §3.2; empty user_id falls back to broadcast).
	eventPayload, _ := json.Marshal(map[string]interface{}{
		"task_id": task.ID,
		"user_id": taskUserIDString(task.UserID),
		"type":    task.Type,
		"status":  "success",
		"result":  result,
	})
	if pubErr := e.nats.Publish("aigc.task.completed", eventPayload); pubErr != nil {
		logger.Warn("failed to publish task.completed event", zap.Error(pubErr))
	}

	logger.Info("task completed successfully")
}

// handleFailure manages retry logic with exponential backoff.
func (e *TaskEngine) handleFailure(ctx context.Context, task model.Task, err error, logger *zap.Logger) {
	if task.RetryCount < task.MaxRetries {
		// Increment retry count
		e.repo.IncrementRetry(ctx, task.ID)

		// Exponential backoff: 2^retryCount seconds
		delay := time.Duration(math.Pow(2, float64(task.RetryCount))) * time.Second

		// Reset status to pending for retry
		e.db.WithContext(ctx).Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]interface{}{
			"status":    "pending",
			"error_msg": err.Error(),
		})

		// Re-enqueue with delay
		go func() {
			time.Sleep(delay)
			updatedTask, getErr := e.repo.GetByID(ctx, task.ID)
			if getErr != nil {
				logger.Error("failed to re-fetch task for retry", zap.Error(getErr))
				return
			}
			select {
			case e.taskCh <- *updatedTask:
				logger.Info("task re-enqueued for retry",
					zap.Int16("retry", updatedTask.RetryCount+1),
					zap.Duration("delay", delay),
				)
			default:
				logger.Warn("task channel full during retry")
			}
		}()
	} else {
		// Max retries exceeded → dead_letter
		e.db.WithContext(ctx).Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]interface{}{
			"status":    "dead_letter",
			"error_msg": err.Error(),
		})
		middleware.ObserveTask(task.Type, "dead_letter") // v2 §8.1
		logger.Error("task moved to dead_letter after max retries")

		// Publish dead letter event
		eventPayload, _ := json.Marshal(map[string]interface{}{
			"task_id": task.ID,
			"user_id": taskUserIDString(task.UserID),
			"type":    task.Type,
			"status":  "dead_letter",
			"error":   err.Error(),
			"retries": task.RetryCount,
		})
		e.nats.Publish("aigc.task.dead_letter", eventPayload)
	}
}
