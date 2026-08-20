"""Application configuration using Pydantic Settings."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """InkBloom AI Service configuration."""

    # Server
    grpc_port: int = 50051
    http_port: int = 8100

    # LLM (OpenAI-compatible; DeepSeek by default)
    openai_api_key: str = ""
    openai_base_url: str = "https://api.deepseek.com"
    default_model: str = "deepseek-v4-flash"

    # Go service
    go_service_url: str = "http://localhost:8080"

    class Config:
        env_prefix = "INKBLOOM_"
        env_file = ".env"


settings = Settings()
