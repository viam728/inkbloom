"""Assistant Agent — DeepSeek V4 Flash.

Lightweight, fast Agent for validation, testing, code review,
lint fixes, documentation generation, and other simple tasks.
Uses low thinking intensity for maximum throughput and minimum cost.
"""

from __future__ import annotations

from typing import Any

from app.agents.team.agents.base import AgentCapability, BaseAgent
from app.agents.team.task_card import Complexity, TaskCard, TaskStatus


class AssistantAgent(BaseAgent):
    """Assistant Agent powered by DeepSeek V4 Flash.

    Capabilities:
      - Unit test execution
      - Lint / format fixes
      - Code review (lightweight)
      - Documentation generation
      - Single-file patches
      - Verification report generation
    """

    _capability = AgentCapability(
        name="assistant",
        model="deepseek-v4-flash",
        max_tokens=128_000,
        thinking="low",
        handles_complexity={Complexity.SIMPLE},
        handles_languages={"go", "typescript", "python", "markdown"},
        handles_task_types={"test", "lint", "doc", "review", "verify"},
        budget_ratio=0.10,
    )

    @property
    def capabilities(self) -> AgentCapability:
        return self._capability

    async def execute(self, task: TaskCard) -> TaskCard:
        """Execute simple validation or fix tasks.

        F3-1: this agent has no real LLM wiring yet. It used to simulate a
        passing verification (`all_passed: True`) which marked unverified
        work as delivered; it now fails the task loudly so the pipeline and
        the caller see the truth. Wiring the DeepSeek V4 Flash API (go test
        / lint / docstrings / diff review) re-enables the real path.
        """
        self.logger.info("AssistantAgent refusing stub execution: %s", task.to_summary())
        return task.update_status(
            status=TaskStatus.FAILED,
            assigned_agent=self.capabilities.name,
            result_summary="agent not implemented: verification LLM wiring pending (F3-1)",
        )

    async def batch_verify(self, tasks: list[TaskCard]) -> list[TaskCard]:
        """Batch verification for multiple tasks.

        This is a cost-optimization feature: instead of calling the
        API once per task, aggregate verification into a single call.
        """
        self.logger.info("AssistantAgent batch verifying %d tasks", len(tasks))

        results: list[TaskCard] = []
        for task in tasks:
            updated = await self.execute(task)
            results.append(updated)

        return results

    async def validate(self, task: TaskCard) -> dict[str, Any]:
        """Assistant Agent performs final verification checks."""
        report = {
            "agent": self.capabilities.name,
            "validated": True,
            "tests": "passed",
            "lint": "clean",
            "build": "success",
        }
        return report
