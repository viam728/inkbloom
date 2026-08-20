package config

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/viper"
)

// defaultJWTSecretPlaceholder is the built-in placeholder jwt.secret. Cloud
// mode refuses to boot with it (v2 §5.2); local mode swaps it for a random
// per-install secret at startup (main.ensureJWTSecret).
const defaultJWTSecretPlaceholder = "9c4e1f7ab02d8365e2f9a4c7d1b80f36a5e0d2c94b7f1a83e6d0c5b2a9f4e718"

// Config holds all configuration for the application.
type Config struct {
	// Mode selects the deployment mode (task #37, M2-a), env INKBLOOM_MODE:
	//   cloud (default) — PostgreSQL + Redis + NATS, multi-user service;
	//   local           — embedded single-machine mode for the Electron
	//                     desktop app: SQLite + in-process kv store, no
	//                     external dependencies.
	Mode      string          `mapstructure:"mode"`
	Server    ServerConfig    `mapstructure:"server"`
	Database  DatabaseConfig  `mapstructure:"database"`
	Redis     RedisConfig     `mapstructure:"redis"`
	NATS      NATSConfig      `mapstructure:"nats"`
	Log       LogConfig       `mapstructure:"log"`
	Auth      AuthConfig      `mapstructure:"auth"`
	JWT       JWTConfig       `mapstructure:"jwt"`
	Admin     AdminConfig     `mapstructure:"admin"`
	AIService AIServiceConfig `mapstructure:"ai_service"`
	// Rollout controls the M6 gradual-release feature flags (task #51).
	Rollout RolloutConfig `mapstructure:"rollout"`
	// Desktop points at the desktop installer artifact (task #51).
	Desktop DesktopConfig `mapstructure:"desktop"`
	// ContentSafety gates the AIGC moderation gateway (tech plan v2 §9.1).
	ContentSafety ContentSafetyConfig `mapstructure:"contentsafety"`
}

// IsLocal reports whether the server runs in the embedded local mode.
func (c *Config) IsLocal() bool { return c.Mode == "local" }

// AIServiceConfig holds AI service-related configuration.
type AIServiceConfig struct {
	URL string `mapstructure:"url"`
}

// ServerConfig holds server-related configuration.
type ServerConfig struct {
	Port            int           `mapstructure:"port"`
	Mode            string        `mapstructure:"mode"`
	ShutdownTimeout time.Duration `mapstructure:"shutdown_timeout"`
	// CORSOrigins is the cross-origin whitelist (tech plan v2 §4.2). Empty
	// falls back to the built-in dev origins (localhost/127.0.0.1 dev ports
	// + the desktop loopback). Production must set this explicitly, e.g. via
	// INKBLOOM_SERVER_CORS_ORIGINS="https://app.example.com,https://www.example.com".
	CORSOrigins     []string      `mapstructure:"cors_origins"`
	// DataRoot is the root directory for all local-mode data (SQLite file,
	// asset/portrait files, backups). Defaults to ./inkbloom-data; the
	// desktop app passes %APPDATA%/InkBloom. Ignored in cloud mode.
	DataRoot string `mapstructure:"data_root"`
	// WebDist points at the built frontend (packages/web/dist) which the
	// local mode serves as a static SPA site. Empty disables hosting.
	WebDist string `mapstructure:"web_dist"`
}

// DatabaseConfig holds database-related configuration.
type DatabaseConfig struct {
	URL string `mapstructure:"url"`
}

// RedisConfig holds Redis-related configuration.
type RedisConfig struct {
	URL string `mapstructure:"url"`
}

// NATSConfig holds NATS-related configuration.
type NATSConfig struct {
	URL string `mapstructure:"url"`
}

// LogConfig holds logging-related configuration.
type LogConfig struct {
	Level  string `mapstructure:"level"`
	Format string `mapstructure:"format"`
}

// AuthConfig holds authentication-related configuration.
type AuthConfig struct {
	// Token is the legacy static bearer token kept for the backdoor switch below.
	Token string `mapstructure:"token"`
	// LegacyToken re-enables the old static-token middleware as a rollback
	// backdoor. Defaults to false; when true, requests bearing auth.token pass.
	LegacyToken bool `mapstructure:"legacy_token"`
}

// AdminConfig holds back-office configuration (task #49, M5).
type AdminConfig struct {
	// Phones lists phone numbers auto-promoted to operator role
	// (role=max(role,1)) at register/login time.
	Phones []string `mapstructure:"phones"`
}

// RolloutConfig holds the gradual-release switches served by
// GET /api/v1/public/flags (task #51, M6).
type RolloutConfig struct {
	// Percent is the rollout percentage (0-100). Logged-in callers with
	// uid % 100 < Percent get enabled=true.
	Percent int `mapstructure:"percent"`
	// Features maps feature names (token_billing / desktop_download /
	// feedback) to their global on/off switches.
	Features map[string]bool `mapstructure:"features"`
}

// DesktopConfig holds the desktop installer location (task #51, M6).
type DesktopConfig struct {
	// InstallerPath is either a direct file path or a directory to scan
	// for the first *.exe. Empty falls back to ../desktop/dist (repo
	// layout) so the local-mode server can serve freshly built installers.
	InstallerPath string `mapstructure:"installer_path"`
}

// ContentSafetyConfig holds the AIGC moderation gateway settings (v2 §9.1).
type ContentSafetyConfig struct {
	// Enabled toggles the gateway. Cloud production must set true; the
	// local embedded mode keeps it off (single-user, no compliance surface).
	Enabled bool `mapstructure:"enabled"`
	// Provider selects the moderation backend (aliyun). Empty = no-op.
	Provider string `mapstructure:"provider"`
	// Endpoint / credentials for the Aliyun Green CIP API.
	Endpoint  string `mapstructure:"endpoint"`
	AccessKey string `mapstructure:"access_key"`
	SecretKey string `mapstructure:"secret_key"`
}

// JWTConfig holds JWT signing and lifetime configuration.
type JWTConfig struct {
	// Secret is the HS256 signing key. MUST be overridden in production.
	Secret string `mapstructure:"secret"`
	// AccessTTL is the lifetime of access tokens (default 2h).
	AccessTTL time.Duration `mapstructure:"access_ttl"`
	// RefreshTTL is the lifetime of refresh tokens (default 720h = 30d),
	// also used as the Redis TTL for revocable refresh jtis.
	RefreshTTL time.Duration `mapstructure:"refresh_ttl"`
}

// Load reads configuration from config.yaml and environment variables.
// Environment variables are prefixed with INKBLOOM_ (e.g. INKBLOOM_SERVER_PORT).
func Load() (*Config, error) {
	v := viper.New()

	v.SetConfigName("config")
	v.SetConfigType("yaml")
	v.AddConfigPath(".")
	v.AddConfigPath("./packages/server")

	// Environment variable overrides
	v.SetEnvPrefix("INKBLOOM")
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()

	// Defaults
	v.SetDefault("server.port", 8080)
	v.SetDefault("server.mode", "debug")
	v.SetDefault("server.shutdown_timeout", 30*time.Second)
	v.SetDefault("server.data_root", "./inkbloom-data")
	v.SetDefault("server.web_dist", "")
	v.SetDefault("mode", "cloud")
	v.SetDefault("log.level", "debug")
	v.SetDefault("log.format", "console")
	v.SetDefault("auth.token", "inkbloom-dev-token")
	v.SetDefault("auth.legacy_token", false)
	// jwt.secret has NO safe default for cloud mode (tech plan v2 §5.2):
	// the placeholder below is only recognized so cloud startup can REFUSE
	// it. Local mode replaces it with a random per-install secret at boot.
	v.SetDefault("jwt.secret", defaultJWTSecretPlaceholder)
	v.SetDefault("jwt.access_ttl", 2*time.Hour)
	v.SetDefault("jwt.refresh_ttl", 720*time.Hour)
	v.SetDefault("admin.phones", []string{})
	v.SetDefault("rollout.percent", 100)
	v.SetDefault("rollout.features", map[string]bool{
		"token_billing":    true,
		"desktop_download": true,
		"feedback":         true,
	})
	v.SetDefault("desktop.installer_path", "")
	v.SetDefault("contentsafety.enabled", false)
	v.SetDefault("contentsafety.provider", "")
	v.SetDefault("contentsafety.endpoint", "")
	v.SetDefault("contentsafety.access_key", "")
	v.SetDefault("contentsafety.secret_key", "")
	v.SetDefault("ai_service.url", "http://localhost:8100")

	if err := v.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return nil, fmt.Errorf("reading config file: %w", err)
		}
		// Config file not found; rely on defaults + env
	}

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return nil, fmt.Errorf("unmarshalling config: %w", err)
	}

	// Local embedded mode listens on 127.0.0.1:18080 by default (task #37,
	// M2-a). The config.yaml port targets the cloud dev service, so local
	// mode ignores it; only the INKBLOOM_SERVER_PORT env var overrides.
	if cfg.IsLocal() && os.Getenv("INKBLOOM_SERVER_PORT") == "" {
		cfg.Server.Port = 18080
	}

	// CORS origins: accept a comma-separated env override (viper leaves the
	// raw string in the slice field otherwise).
	if raw := os.Getenv("INKBLOOM_SERVER_CORS_ORIGINS"); raw != "" {
		parts := strings.Split(raw, ",")
		origins := make([]string, 0, len(parts))
		for _, p := range parts {
			if p = strings.TrimSpace(p); p != "" {
				origins = append(origins, p)
			}
		}
		cfg.Server.CORSOrigins = origins
	}

	// Embedded mode must never expose the static-token backdoor.
	if cfg.IsLocal() {
		cfg.Auth.LegacyToken = false
	}

	// Cloud mode must never run with the placeholder JWT secret (v2 §5.2).
	// Local mode replaces it with a random secret in main.ensureJWTSecret.
	if !cfg.IsLocal() && (cfg.JWT.Secret == "" || cfg.JWT.Secret == defaultJWTSecretPlaceholder) {
		return nil, fmt.Errorf("jwt.secret is not configured: set INKBLOOM_JWT_SECRET (openssl rand -hex 32); cloud mode refuses the built-in placeholder")
	}

	return &cfg, nil
}
