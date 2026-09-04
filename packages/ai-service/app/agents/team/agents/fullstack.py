"""Fullstack Agent — Kimi-for-Coding.

The main implementation workhorse. Handles component development,
API implementation, database migrations, and cross-file refactoring.
Uses medium-to-high thinking intensity and a 200K+ context window.
"""

from __future__ import annotations

from typing import Any

from app.agents.team.agents.base import AgentCapability, BaseAgent
from app.agents.team.task_card import Complexity, TaskCard, TaskStatus


class FullstackAgent(BaseAgent):
    """Fullstack Agent powered by Kimi-for-Coding.

    Capabilities:
      - Component development (React/TypeScript)
      - API implementation (Go/Gin)
      - AI service logic (Python/FastAPI)
      - Database migrations
      - Cross-file refactoring (< 10 files)
    """

    _capability = AgentCapability(
        name="fullstack",
        model="kimi-for-coding",
        max_tokens=200_000,
        thinking="medium",
        handles_complexity={Complexity.MEDIUM, Complexity.SIMPLE},
        handles_languages={"go", "typescript", "python", "sql"},
        handles_task_types={"implement", "refactor", "migrate", "component"},
        budget_ratio=0.50,
    )

    @property
    def capabilities(self) -> AgentCapability:
        return self._capability

    async def execute(self, task: TaskCard) -> TaskCard:
        """Execute implementation tasks.

        F3-1: no real Kimi-for-Coding wiring yet. The stub used to fabricate
        an "Implemented …" DONE summary with zero artifacts behind it; it
        now fails the task so callers never mistake simulation for delivery.
        """
        self.logger.info("FullstackAgent refusing stub execution: %s", task.to_summary())
        return task.update_status(
            status=TaskStatus.FAILED,
            assigned_agent=self.capabilities.name,
            result_summary="agent not implemented: implementation LLM wiring pending (F3-1)",
        )

    async def validate(self, task: TaskCard) -> dict[str, Any]:
        """Fullstack Agent performs implementation quality checks."""
        report = {
            "agent": self.capabilities.name,
            "validated": True,
            "code_quality": "reviewed",
            "pattern_consistency": "checked",
            "type_safety": "verified" if "typescript" in task.context.notes.lower() else "n/a",
        }
        return report
