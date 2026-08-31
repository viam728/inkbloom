"""OpenAI-compatible LLM provider (works with OpenAI, DeepSeek, etc.)."""

from typing import AsyncIterator

from openai import AsyncOpenAI

from app.config import settings
from app.llm.base import BaseLLMProvider, LLMChunk, LLMResponse
from app.utils.token_counter import count_tokens as _count_tokens


class OpenAIProvider(BaseLLMProvider):
    """LLM provider using the OpenAI SDK, compatible with any OpenAI-style API."""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
    ) -> None:
        self._client = AsyncOpenAI(
            api_key=api_key or settings.openai_api_key,
            base_url=base_url or settings.openai_base_url,
        )

    async def chat(
        self,
        messages: list[dict],
        model: str | None = None,
        temperature: float = 0.7,
        max_tokens: int = 2048,
    ) -> LLMResponse:
        """Send a chat completion request and return the full response."""
        model = model or settings.default_model

        response = await self._client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            stream=False,
        )

        choice = response.choices[0]
        usage = response.usage

        return LLMResponse(
            content=choice.message.content or "",
            prompt_tokens=usage.prompt_tokens if usage else 0,
            completion_tokens=usage.completion_tokens if usage else 0,
        )

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

        response = await self._client.chat.completions.create(
            model=model,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            stream=False,
            tools=tools,
            tool_choice="auto",
        )

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
            "tool_calls": tool_calls,
            "prompt_tokens": usage.prompt_tokens if usage else 0,
            "completion_tokens": usage.completion_tokens if usage else 0,
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

        response = await self._client.chat.completions.create(
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
