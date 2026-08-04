package server

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"go.uber.org/zap"
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = 30 * time.Second
	maxMessageSize = 512
	sendBufferSize = 256
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// WSMessage represents a WebSocket message sent to clients.
type WSMessage struct {
	Type    string      `json:"type"`    // task:created, task:progress, task:completed, task:failed, notification
	Payload interface{} `json:"payload"`
}

// WSClient represents a single WebSocket connection.
type WSClient struct {
	hub    *WSHub
	conn   *websocket.Conn
	userID string
	send   chan WSMessage
}

// WSHub manages WebSocket client connections and message broadcasting.
type WSHub struct {
	clients    map[string]*WSClient
	register   chan *WSClient
	unregister chan *WSClient
	broadcast  chan WSMessage
	mu         sync.RWMutex
	logger     *zap.Logger
}

// NewWSHub creates a new WSHub instance.
func NewWSHub(logger *zap.Logger) *WSHub {
	return &WSHub{
		clients:    make(map[string]*WSClient),
		register:   make(chan *WSClient),
		unregister: make(chan *WSClient),
		broadcast:  make(chan WSMessage, sendBufferSize),
		logger:     logger,
	}
}

// Run starts the hub's main event loop: register, unregister, and broadcast.
func (h *WSHub) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			h.mu.Lock()
			for id, client := range h.clients {
				close(client.send)
				delete(h.clients, id)
			}
			h.mu.Unlock()
			return

		case client := <-h.register:
			h.mu.Lock()
			h.clients[client.userID] = client
			h.mu.Unlock()
			h.logger.Info("WebSocket client registered", zap.String("userID", client.userID),
				zap.Int("total", len(h.clients)))

		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client.userID]; ok {
				delete(h.clients, client.userID)
				close(client.send)
			}
			h.mu.Unlock()
			h.logger.Info("WebSocket client unregistered", zap.String("userID", client.userID),
				zap.Int("total", len(h.clients)))

		case msg := <-h.broadcast:
			h.mu.RLock()
			for _, client := range h.clients {
				select {
				case client.send <- msg:
				default:
					// Client is slow; drop and unregister
					go func(c *WSClient) {
						h.unregister <- c
					}(client)
				}
			}
			h.mu.RUnlock()
		}
	}
}

// HandleConnection upgrades an HTTP request to a WebSocket connection.
// Expects a "token" query parameter for authentication.
func (h *WSHub) HandleConnection(c *gin.Context) {
	// Validate token from query param
	token := c.Query("token")
	if token == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"code": 401, "message": "missing token"})
		return
	}

	// For now, accept any non-empty token; extract userID from token or use default
	userID := c.Query("user_id")
	if userID == "" {
		userID = "default"
	}

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		h.logger.Error("WebSocket upgrade failed", zap.Error(err))
		return
	}

	client := &WSClient{
		hub:    h,
		conn:   conn,
		userID: userID,
		send:   make(chan WSMessage, sendBufferSize),
	}
	h.register <- client

	go client.writePump()
	go client.readPump()
}

// Broadcast sends a message to all connected clients.
func (h *WSHub) Broadcast(msg WSMessage) {
	h.broadcast <- msg
}

// SendToUser sends a message to a specific user.
func (h *WSHub) SendToUser(userID string, msg WSMessage) {
	h.mu.RLock()
	client, ok := h.clients[userID]
	h.mu.RUnlock()
	if !ok {
		return
	}
	select {
	case client.send <- msg:
	default:
		// Client buffer full; skip
		h.logger.Warn("Client send buffer full, dropping message",
			zap.String("userID", userID), zap.String("type", msg.Type))
	}
}

// readPump reads messages from the WebSocket connection.
// It handles Ping/Pong and unregisters the client on disconnect.
func (c *WSClient) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(maxMessageSize)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				c.hub.logger.Warn("WebSocket read error", zap.Error(err), zap.String("userID", c.userID))
			}
			return
		}
		// Optionally handle incoming messages (e.g. client commands)
		_ = message
	}
}

// writePump writes messages from the send channel to the WebSocket connection.
// It also sends periodic Ping frames for heartbeat.
func (c *WSClient) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				// Hub closed the channel
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			data, err := json.Marshal(msg)
			if err != nil {
				c.hub.logger.Error("Failed to marshal WS message", zap.Error(err))
				continue
			}

			w, err := c.conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			_, _ = w.Write(data)

			// Drain queued messages into the same write
			n := len(c.send)
			for i := 0; i < n; i++ {
				queued := <-c.send
				qd, qerr := json.Marshal(queued)
				if qerr != nil {
					continue
				}
				_, _ = w.Write([]byte("\n"))
				_, _ = w.Write(qd)
			}

			if err := w.Close(); err != nil {
				return
			}

		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
