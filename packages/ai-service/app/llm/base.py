"""Abstract base class for LLM providers."""

from abc import ABC, abstractmethod
from typing import AsyncIterator
from dataclasses import dataclass


@dataclass
class LLMChunk:
    """A single chunk from a streaming LLM response."""

    content: str
    finish_reason: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0


@dataclass
class LLMResponse:
    """A complete LLM response."""

    content: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    # F3-7/F3-9：实际生效的模型名（fallback 命中时与请求的 model 不同），
    # 计费台账据此记录真实模型，避免账单失真。
    model: str = ""


class BaseLLMProvider(ABC):
    """Abstract base class for all LLM providers."""

    @abstractmethod
    async def chat(
        self,
        messages: list[dict],
        model: str,
        temperature: float,
        max_tokens: int,
    ) -> LLMResponse:
        """Send a chat request and return a complete response."""
        ...

    @abstractmethod
    async def stream(
        self,
        messages: list[dict],
        model: str,
        temperature: float,
        max_tokens: int,
    ) -> AsyncIterator[LLMChunk]:
        """Send a chat request and yield chunks as they arrive."""
        ...

    @abstractmethod
    async def count_tokens(self, text: str, model: str) -> int:
        """Count the number of tokens in the given text."""
        ...
