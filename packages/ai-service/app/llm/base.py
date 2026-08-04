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
