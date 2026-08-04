package config

import (
	"fmt"
	"strings"
	"time"

	"github.com/spf13/viper"
)

// Config holds all configuration for the application.
type Config struct {
	Server    ServerConfig    `mapstructure:"server"`
	Database  DatabaseConfig  `mapstructure:"database"`
	Redis     RedisConfig     `mapstructure:"redis"`
	NATS      NATSConfig      `mapstructure:"nats"`
	Log       LogConfig       `mapstructure:"log"`
	Auth      AuthConfig      `mapstructure:"auth"`
	AIService AIServiceConfig `mapstructure:"ai_service"`
}

// AIServiceConfig holds AI service-related configuration.
type AIServiceConfig struct {
	URL string `mapstructure:"url"`
}

// ServerConfig holds server-related configuration.
type ServerConfig struct {
	Port            int           `mapstructure:"port"`
	Mode            string        `mapstructure:"mode"`
	ShutdownTimeout time.Duration `mapstructure:"shutdown_timeout"`
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
	Token string `mapstructure:"token"`
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
	v.SetDefault("log.level", "debug")
	v.SetDefault("log.format", "console")
	v.SetDefault("auth.token", "inkbloom-dev-token")
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

	return &cfg, nil
}
