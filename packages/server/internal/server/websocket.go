package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
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
	// CheckOrigin is replaced by WSHub.CheckOrigin (whitelist-driven, v2 §5.3).
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// WSMessage represents a WebSocket message sent to clients.
type WSMessage struct {
	Type    string      `json:"type"` // task:created, task:progress, task:completed, task:failed, notification
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
// Multiple concurrent connections per user are supported (several browser
// tabs, desktop + web): clients are grouped per userID, never overwritten.
type WSHub struct {
	clients    map[string]map[*WSClient]struct{}
	register   chan *WSClient
	unregister chan *WSClient
	broadcast  chan WSMessage
	mu         sync.RWMutex
	logger     *zap.Logger

	// authenticate validates the query-string token and returns the user id.
	// When nil, any non-empty token is accepted (legacy dev behavior).
	authenticate func(token string) (int64, error)

	// localAnon admits tokenless connections as the anonymous local user
	// (desktop embedded mode, v2 §3.4). Never enable in cloud mode.
	localAnon bool

	// allowedOrigins is the WS Origin whitelist (v2 §5.3). Empty means
	// "no cross-origin browser clients" (desktop loopback + same-origin
	// nginx deployments pass via the empty-Origin / same-host rules).
	allowedOrigins map[string]struct{}
}

// NewWSHub creates a new WSHub instance.
func NewWSHub(logger *zap.Logger) *WSHub {
	return &WSHub{
		clients:    make(map[string]map[*WSClient]struct{}),
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
			for id, set := range h.clients {
				for client := range set {
					close(client.send)
				}
				delete(h.clients, id)
			}
			h.mu.Unlock()
			return

		case client := <-h.register:
			h.mu.Lock()
			if h.clients[client.userID] == nil {
				h.clients[client.userID] = make(map[*WSClient]struct{})
			}
			h.clients[client.userID][client] = struct{}{}
			total := h.totalClientsLocked()
			h.mu.Unlock()
			h.logger.Info("WebSocket client registered", zap.String("userID", client.userID),
				zap.Int("total", total))

		case client := <-h.unregister:
			// Only the exact client instance leaving is torn down. A stale
			// unregister (e.g. a replaced connection's read pump exiting
			// late) must never close a newer connection's channel — doing
			// so used to panic SendToUser with "send on closed channel".
			h.mu.Lock()
			if set, ok := h.clients[client.userID]; ok {
				if _, live := set[client]; live {
					delete(set, client)
					close(client.send)
				}
				if len(set) == 0 {
					delete(h.clients, client.userID)
				}
			}
			total := h.totalClientsLocked()
			h.mu.Unlock()
			h.logger.Info("WebSocket client unregistered", zap.String("userID", client.userID),
				zap.Int("total", total))

		case msg := <-h.broadcast:
			h.mu.RLock()
			for _, set := range h.clients {
				for client := range set {
					select {
					case client.send <- msg:
					default:
						// Client is slow; drop and unregister
						go func(c *WSClient) {
							h.unregister <- c
						}(client)
					}
				}
			}
			h.mu.RUnlock()
		}
	}
}

// totalClientsLocked counts live connections; callers must hold h.mu (any
// flavor) — it never takes the lock itself.
func (h *WSHub) totalClientsLocked() int {
	n := 0
	for _, set := range h.clients {
		n += len(set)
	}
	return n
}

// SetAuthenticator installs the token validator (JWT access token) used by
// HandleConnection to authenticate the "token" query parameter.
func (h *WSHub) SetAuthenticator(fn func(token string) (int64, error)) {
	h.authenticate = fn
}

// SetLocalAnon enables the tokenless anonymous admission used by the
// desktop embedded mode (loopback listener only).
func (h *WSHub) SetLocalAnon(enabled bool) {
	h.localAnon = enabled
}

// SetAllowedOrigins installs the WS Origin whitelist (v2 §5.3). Requests
// with an Origin header must match an entry; requests without an Origin
// header (non-browser clients, curl, the desktop shell's loopback page)
// are always allowed.
func (h *WSHub) SetAllowedOrigins(origins []string) {
	m := make(map[string]struct{}, len(origins))
	for _, o := range origins {
		o = strings.TrimSpace(o)
		if o != "" {
			m[o] = struct{}{}
		}
	}
	h.allowedOrigins = m
}

// HandleConnection upgrades an HTTP request to a WebSocket connection.
// Expects a "token" query parameter carrying a JWT access token.
// In local embedded mode (v2 §3.4) a missing token is admitted as the
// anonymous local user (uid=0): the listener is loopback-bound and the
// desktop renderer connects before any cloud login.
func (h *WSHub) HandleConnection(c *gin.Context) {
	// Validate token from query param
	token := c.Query("token")
	if token == "" {
		if h.localAnon {
			h.serve(c, "0")
			return
		}
		c.JSON(http.StatusUnauthorized, gin.H{"code": 401, "message": "missing token"})
		return
	}

	var userID string
	if h.authenticate != nil {
		uid, err := h.authenticate(token)
		if err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"code": 401, "message": "invalid or expired token"})
			return
		}
		userID = strconv.FormatInt(uid, 10)
	} else {
		// Legacy fallback: accept any non-empty token.
		userID = c.Query("user_id")
		if userID == "" {
			userID = "default"
		}
	}

	h.serve(c, userID)
}

// serve upgrades the request and registers the client under userID.
func (h *WSHub) serve(c *gin.Context, userID string) {
	// Origin whitelist enforcement (v2 §5.3): browser cross-origin requests
	// carry an Origin header and must match; non-browser clients (no Origin)
	// and same-host origins always pass.
	if !h.originAllowed(c.Request) {
		h.logger.Warn("WebSocket origin rejected",
			zap.String("origin", c.GetHeader("Origin")),
			zap.String("ip", c.ClientIP()))
		c.JSON(http.StatusForbidden, gin.H{"code": 403, "message": "origin not allowed"})
		return
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

// originAllowed reports whether the request's Origin passes the whitelist.
// Rules (v2 §5.3):
//   - no Origin header (non-browser clients, curl, server-side) → allow;
//   - Origin host == request Host (same-origin deployment) → allow;
//   - Origin in the configured whitelist → allow;
//   - otherwise → reject.
func (h *WSHub) originAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	// Same-origin: strip scheme and compare host.
	if u, err := url.Parse(origin); err == nil && u.Host == r.Host {
		return true
	}
	_, ok := h.allowedOrigins[origin]
	return ok
}

// Broadcast sends a message to all connected clients.
func (h *WSHub) Broadcast(msg WSMessage) {
	h.broadcast <- msg
}

// SendToUser sends a message to every live connection of the user (all tabs
// and devices). The set is copied under RLock before sending: pushing into a
// full buffer while holding RLock would deadlock against unregister.
func (h *WSHub) SendToUser(userID string, msg WSMessage) {
	h.mu.RLock()
	set, ok := h.clients[userID]
	if !ok {
		h.mu.RUnlock()
		return
	}
	targets := make([]*WSClient, 0, len(set))
	for client := range set {
		targets = append(targets, client)
	}
	h.mu.RUnlock()

	dropped := false
	for _, client := range targets {
		select {
		case client.send <- msg:
		default:
			dropped = true
		}
	}
	if dropped {
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
