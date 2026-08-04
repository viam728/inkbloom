//go:build grpc

// Package aiservice provides a gRPC client for the InkBloom AI Service.
//
// This file requires the 'grpc' build tag because it depends on generated
// protobuf code and the gRPC library. For environments without gRPC,
// the Go server uses the HTTP fallback (ai_handler.go) instead.
//
// Before using this package, generate the protobuf code:
//
//	go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
//	go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
//	cd packages/server/proto/aiservice
//	go generate
//
// Or run the Python script from the ai-service package:
//
//	cd packages/ai-service
//	python scripts/generate_proto.py
package aiservice

import (
	"context"
	"fmt"
	"io"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// Client wraps the gRPC connection to the AI service.
type Client struct {
	conn    *grpc.ClientConn
	service AIServiceClient
}

// NewClient creates a new gRPC client connected to the AI service.
func NewClient(addr string) (*Client, error) {
	conn, err := grpc.NewClient(
		addr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to AI service: %w", err)
	}

	return &Client{
		conn:    conn,
		service: NewAIServiceClient(conn),
	}, nil
}

// Close closes the gRPC connection.
func (c *Client) Close() error {
	return c.conn.Close()
}

// ChatMessage represents a chat message.
type ChatMessage struct {
	Role    string
	Content string
}

// ChatStreamChunk represents a chunk from a streaming chat response.
type ChatStreamChunk struct {
	Content      string
	FinishReason string
}

// ChatCompleteResponse represents a complete chat response.
type ChatCompleteResponse struct {
	Content          string
	PromptTokens     int32
	CompletionTokens int32
	TotalTokens      int32
}

// ChatStream sends a chat request and returns a channel of streaming chunks.
func (c *Client) ChatStream(ctx context.Context, messages []ChatMessage, model string, temperature float32, maxTokens int32) (<-chan ChatStreamChunk, <-chan error) {
	chunkCh := make(chan ChatStreamChunk)
	errCh := make(chan error, 1)

	protoMessages := make([]*Message, len(messages))
	for i, msg := range messages {
		protoMessages[i] = &Message{
			Role:    msg.Role,
			Content: msg.Content,
		}
	}

	go func() {
		defer close(chunkCh)

		req := &ChatRequest{
			Messages:    protoMessages,
			Model:       model,
			Temperature: temperature,
			MaxTokens:   maxTokens,
		}

		stream, err := c.service.ChatStream(ctx, req)
		if err != nil {
			errCh <- fmt.Errorf("chat stream error: %w", err)
			return
		}

		for {
			chunk, err := stream.Recv()
			if err == io.EOF {
				return
			}
			if err != nil {
				errCh <- fmt.Errorf("stream recv error: %w", err)
				return
			}

			chunkCh <- ChatStreamChunk{
				Content:      chunk.Content,
				FinishReason: chunk.FinishReason,
			}
		}
	}()

	return chunkCh, errCh
}

// ChatComplete sends a chat request and returns the complete response.
func (c *Client) ChatComplete(ctx context.Context, messages []ChatMessage, model string, temperature float32, maxTokens int32) (*ChatCompleteResponse, error) {
	protoMessages := make([]*Message, len(messages))
	for i, msg := range messages {
		protoMessages[i] = &Message{
			Role:    msg.Role,
			Content: msg.Content,
		}
	}

	req := &ChatRequest{
		Messages:    protoMessages,
		Model:       model,
		Temperature: temperature,
		MaxTokens:   maxTokens,
	}

	resp, err := c.service.ChatComplete(ctx, req)
	if err != nil {
		return nil, fmt.Errorf("chat complete error: %w", err)
	}

	return &ChatCompleteResponse{
		Content:          resp.Content,
		PromptTokens:     resp.Usage.GetPromptTokens(),
		CompletionTokens: resp.Usage.GetCompletionTokens(),
		TotalTokens:      resp.Usage.GetTotalTokens(),
	}, nil
}
