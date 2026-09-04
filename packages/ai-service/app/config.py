"""Application configuration using Pydantic Settings."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """InkBloom AI Service configuration."""

    # Server
    grpc_port: int = 50051
    http_port: int = 8100

    # LLM (OpenAI-compatible; Zhipu GLM by default — 开发阶段统一 glm-4.5-air)
    openai_api_key: str = ""
    openai_base_url: str = "https://api.deepseek.com"
    default_model: str = "glm-4.5-air"

    # Zhipu GLM (OpenAI-compatible too; used when a requested model is glm-*)
    glm_api_key: str = ""
    glm_base_url: str = "https://open.bigmodel.cn/api/paas/v4"

    # Image generation endpoint (F3-2): DALL·E 等 OpenAI 图像接口与文本补全
    # 的网关不同，不能复用 openai_base_url（指向 DeepSeek 时 /images/generations
    # 必然 404）。
    image_base_url: str = "https://api.openai.com/v1"
    image_api_key: str = ""

    # Go service
    go_service_url: str = "http://localhost:8080"

    # ── LLM call budget (F3-5)：集中管理，禁止散落硬编码 ────────────────────
    # 单次非流式补全超时（SDK 默认 600s 曾拖垮连接池）
    chat_timeout: float = 30.0
    # 流式总时长上限（orchestrator 侧用 asyncio.wait_for 强制）
    stream_total_timeout: float = 300.0
    # 单场景上游调用次数上限（此前 SDK 2 × 空内容 3 × oneshot 3 ≈ 最坏 18 次）
    max_llm_attempts: int = 2

    # ── Multi-model fallback (F3-7) ────────────────────────────────────────
    fallback_enabled: bool = True
    # 逗号分隔的降级模型链；主模型 401/429/5xx/超时时依次尝试
    fallback_models: str = "deepseek-chat"

    class Config:
        env_prefix = "INKBLOOM_"
        env_file = ".env"

    def validate_model_routing(self) -> None:
        """Fail-fast 校验「模型前缀 ↔ base_url ↔ key」三者匹配（F3-2）。

        容器部署曾出现 default_model=glm-4.5-air 但凭据/端点落在 DeepSeek 的
        组合：所有默认模型请求打到 DeepSeek 端点报 model not found，生成/
        抽取/对话全链路 100% 失败。启动期拒绝该配置比运行时静默失败便宜得多。
        """
        model = (self.default_model or "").lower()
        if model.startswith("glm"):
            if not self.glm_api_key:
                raise RuntimeError(
                    "config error: default_model is a glm-* model but INKBLOOM_GLM_API_KEY "
                    "is empty — glm-* traffic would be routed to the wrong endpoint. "
                    "Set INKBLOOM_GLM_API_KEY or switch default_model."
                )
            return
        # 非 glm 模型走默认（DeepSeek 等）端点
        if not self.openai_api_key:
            raise RuntimeError(
                "config error: default_model requires INKBLOOM_OPENAI_API_KEY "
                "(or INKBLOOM_DEEPSEEK_API_KEY depending on deployment naming); "
                "every LLM call would fail without it."
            )


settings = Settings()
