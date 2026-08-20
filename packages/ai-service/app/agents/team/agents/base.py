"""Base Agent abstraction for the InkBloom Agent team.

All concrete Agents (Primary, Fullstack, Assistant) inherit from
BaseAgent and implement ``execute()`` with their model-specific
invocation logic. The pipeline orchestrator interacts with Agents
solely through this interface, keeping the execution layer decoupled
from model providers.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from typing import Any

from app.agents.team.task_card import Complexity, TaskCard, TaskStatus

logger = logging.getLogger(__name__)


class AgentCapability:
    """Capability descriptor advertised by an Agent."""

    def __init__(
        self,
        name: str,
        model: str,
        max_tokens: int,
        thinking: str,
        handles_complexity: set[Complexity],
        handles_languages: set[str] | None = None,
        handles_task_types: set[str] | None = None,
        budget_ratio: float = 0.33,
    ):
        self.name = name
        self.model = model
        self.max_tokens = max_tokens
        self.thinking = thinking
        self.handles_complexity = handles_complexity
        self.handles_languages = handles_languages or set()
        self.handles_task_types = handles_task_types or set()
        self.budget_ratio = budget_ratio

    def can_handle(self, task: TaskCard) -> bool:
        """Check if this Agent can handle the given task."""
        if task.complexity not in self.handles_complexity:
            return False
        # If task context specifies languages, check overlap
        if self.handles_languages and task.context.notes:
            # Simple heuristic: check if any language keyword appears in notes
            notes_lower = task.context.notes.lower()
            if not any(lang in notes_lower for lang in self.handles_languages):
                return False
        return True

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "model": self.model,
            "max_tokens": self.max_tokens,
            "thinking": self.thinking,
            "handles_complexity": [c.value for c in self.handles_complexity],
            "handles_languages": list(self.handles_languages),
            "handles_task_types": list(self.handles_task_types),
            "budget_ratio": self.budget_ratio,
        }


class BaseAgent(ABC):
    """Abstract base for all InkBloom team Agents.

    Subclasses must implement:
      - ``execute()``: core task execution logic
      - ``capabilities()``: static capability descriptor
    """

    def __init__(self) -> None:
        self.logger = logging.getLogger(self.__class__.__name__)

    @property
    @abstractmethod
    def capabilities(self) -> AgentCapability:
        """Return the capability descriptor for this Agent."""
        ...

    @abstractmethod
    async def execute(self, task: TaskCard) -> TaskCard:
        """Execute the task and return an updated TaskCard.

        The returned TaskCard must have its status updated to DONE or FAILED,
        and ``result_summary`` populated.
        """
        ...

    async def validate(self, task: TaskCard) -> dict[str, Any]:
        """Optional post-execution validation.

        Default implementation returns an empty report.
        Override in concrete Agents for model-specific validation.
        """
        return {"agent": self.capabilities.name, "validated": True}

    def can_handle(self, task: TaskCard) -> bool:
        """Delegate to capability descriptor."""
        return self.capabilities.can_handle(task)

    def __repr__(self) -> str:
        cap = self.capabilities
        return f"<{self.__class__.__name__} name={cap.name} model={cap.model}>"
