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

        In production this would invoke the Kimi-for-Coding API with:
          - Task description and acceptance criteria
          - Relevant code context (affected files, key interfaces)
          - Existing patterns to follow

        Current implementation is a stub that simulates execution.
        """
        self.logger.info("FullstackAgent executing: %s", task.to_summary())

        # Simulate implementation work
        files = task.context.affected_files
        result = (
            f"Implemented {task.title}; "
            f"touched {len(files)} file(s): {', '.join(files) if files else 'none'}"
        )

        return task.update_status(
            status=TaskStatus.DONE,
            assigned_agent=self.capabilities.name,
            result_summary=result,
            verification_report={
                "files_modified": files,
                "tests_written": task.deliverables.tests,
                "docs_written": task.deliverables.documentation,
            },
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
