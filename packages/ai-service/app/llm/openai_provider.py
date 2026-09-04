"""OpenAI-compatible LLM provider (works with OpenAI, DeepSeek, etc.)."""

import asyncio
from typing import AsyncIterator

from openai import AsyncOpenAI

from app.config import settings
from app.llm.base import BaseLLMProvider, LLMChunk, LLMResponse
from app.utils.token_counter import count_tokens as _count_tokens

# Fallback-triggering error families (F3-7): auth exhaustion, rate limit,
# provider 5xx and timeouts all justify trying the next model in the chain.
_FALLABLE_STATUS = {401, 403, 408, 429, 500, 502, 503, 504}


def _fallback_models(primary: str) -> list[str]:
    """Parse the comma-separated fallback chain, dropping the primary."""
    if not settings.fallback_enabled:
        return []
    chain = [m.strip() for m in settings.fallback_models.split(",") if m.strip()]
    return [m for m in chain if m and m != primary]


class OpenAIProvider(BaseLLMProvider):
    """LLM provider using the OpenAI SDK, compatible with any OpenAI-style API.

    Routes by model name: `glm-*` models go to the Zhipu BigModel endpoint
    (OpenAI-compatible) with the dedicated GLM credentials; everything else
    uses the default endpoint. F3-2: a glm-* request without GLM credentials
    now fails loudly instead of silently hitting the (mismatched) default
    endpoint that masked fully broken deployments.
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        glm_api_key: str | None = None,
        glm_base_url: str | None = None,
    ) -> None:
        # F3-5: explicit timeout and a single SDK-level retry — the defaults
        # (600s timeout, 2 retries) multiplied with orchestrator retries into
        # worst-case ~18 upstream calls per scene.
        self._timeout = settings.chat_timeout
        self._client = AsyncOpenAI(
            api_key=api_key or settings.openai_api_key,
            base_url=base_url or settings.openai_base_url,
            timeout=self._timeout,
            max_retries=1,
        )
        self._glm_client: AsyncOpenAI | None = None
        glm_key = glm_api_key or settings.glm_api_key
        if glm_key:
            self._glm_client = AsyncOpenAI(
                api_key=glm_key,
                base_url=glm_base_url or settings.glm_base_url,
                timeout=self._timeout,
                max_retries=1,
            )

    def _client_for(self, model: str | None) -> AsyncOpenAI:
        """Pick the endpoint client for a model id (F3-2 fail-closed)."""
        if model and model.lower().startswith("glm"):
            if self._glm_client is None:
                raise RuntimeError(
                    f"model {model!r} requires GLM credentials "
                    "(INKBLOOM_GLM_API_KEY is not configured)"
                )
            return self._glm_client
        return self._client

    def _fallbackable(self, exc: Exception) -> bool:
        """Whether the error justifies trying the fallback model chain."""
        status = getattr(exc, "status_code", None)
        if isinstance(status, int) and status in _FALLABLE_STATUS:
            return True
        if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
            return True
        text = str(exc).lower()
        return "rate limit" in text or "timeout" in text or "temporarily" in text

    async def chat(
        self,
        messages: list[dict],
        model: str | None = None,
        temperature: float = 0.7,
        max_tokens: int = 2048,
    ) -> LLMResponse:
        """Send a chat completion request and return the full response.

        F3-7: on fallbackable failures (401/429/5xx/timeout) walk the
        configured model chain; the returned LLMResponse.model carries the
        model that actually served the request so billing stays truthful.
        """
        model = model or settings.default_model
        candidates = [model, *_fallback_models(model)]

        last_exc: Exception | None = None
        for candidate in candidates:
            try:
                response = await self._client_for(candidate).chat.completions.create(
                    model=candidate,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    stream=False,
                )
                if not response.choices:
                    # Content-filter / empty responses used to IndexError.
                    raise ValueError(f"model {candidate} returned no choices")
                choice = response.choices[0]
                usage = response.usage
                return LLMResponse(
                    content=choice.message.content or "",
                    prompt_tokens=usage.prompt_tokens if usage else 0,
                    completion_tokens=usage.completion_tokens if usage else 0,
                    model=candidate,
                )
            except Exception as exc:  # noqa: BLE001 — fallback dispatches on error family
                last_exc = exc
                if candidate == candidates[-1] or not self._fallbackable(exc):
                    raise

        raise last_exc  # pragma: no cover — the loop always returns or raises

    async def chat_with_tools(
        self,
        messages: list[dict],
        tools: list[dict],
        model: str | None = None,
        temperature: float = 0.7,
        max_tokens: int = 2048,
    ) -> dict:
        """Send a chat request with function-calling tools.

        Returns a dict with `content` (final text, may be empty) and
        `tool_calls` (list of {id, name, arguments}). OpenAI-compatible
        (DeepSeek supports the same tool-calling protocol).
        """
        model = model or settings.default_model

        response = await self._client_for(model).chat.completions.create(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            stream=False,
            tools=tools,
            tool_choice="auto",
        )

        if not response.choices:
            # Content-filter / empty responses used to IndexError.
            raise ValueError(f"model {model} returned no choices")
        choice = response.choices[0]
        message = choice.message
        usage = response.usage

        tool_calls: list[dict] = []
        if message.tool_calls:
            for tc in message.tool_calls:
                tool_calls.append({
                    "id": tc.id,
                    "name": tc.function.name,
                    "arguments": tc.function.arguments or "{}",
                })

        return {
            "content": message.content or "",
            "reasoning_content": getattr(message, "reasoning_content", "") or "",
            "tool_calls": tool_calls,
            "prompt_tokens": usage.prompt_tokens if usage else 0,
            "completion_tokens": usage.completion_tokens if usage else 0,
            "model": model,
        }

    async def stream(
        self,
        messages: list[dict],
        model: str | None = None,
        temperature: float = 0.7,
        max_tokens: int = 2048,
    ) -> AsyncIterator[LLMChunk]:
        """Stream chat completion chunks as they arrive.

        Tech plan v2 §6.3: request stream_options.include_usage so the
        upstream emits a final usage chunk; the last yielded LLMChunk
        carries prompt_tokens/completion_tokens for the Go-side billing
        middleware to settle against.
        """
        model = model or settings.default_model

        response = await self._client_for(model).chat.completions.create(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            stream=True,
            stream_options={"include_usage": True},
        )

        async for chunk in response:
            # Final usage chunk: choices is empty, usage carries the totals.
            if not chunk.choices:
                usage = getattr(chunk, "usage", None)
                if usage:
                    yield LLMChunk(
                        content="",
                        finish_reason="usage",
                        prompt_tokens=int(getattr(usage, "prompt_tokens", 0) or 0),
                        completion_tokens=int(getattr(usage, "completion_tokens", 0) or 0),
                    )
                continue

            delta = chunk.choices[0].delta
            finish_reason = chunk.choices[0].finish_reason or ""

            yield LLMChunk(
                content=delta.content or "",
                finish_reason=finish_reason,
            )

    async def count_tokens(self, text: str, model: str | None = None) -> int:
        """Count tokens using tiktoken."""
        model = model or settings.default_model
        return _count_tokens(text, model)
