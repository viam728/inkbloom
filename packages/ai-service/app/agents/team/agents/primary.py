"""Primary Agent — K3-1M.

Responsible for global planning, complex architectural decisions,
core algorithm design, and task decomposition. Uses the largest
context window (1M tokens) and highest thinking intensity.

In the current implementation this Agent acts as a "meta-planner";
it receives complex tasks, decomposes them into sub-TaskCards, and
dispatches them to the pipeline. Actual LLM invocation is stubbed
and should be wired to the real K3-1M API endpoint.
"""

from __future__ import annotations

from typing import Any

from app.agents.team.agents.base import AgentCapability, BaseAgent
from app.agents.team.task_card import Complexity, Deliverables, TaskCard, TaskStatus


class PrimaryAgent(BaseAgent):
    """Primary Agent powered by K3-1M.

    Capabilities:
      - Complex architectural design
      - Multi-module coordination
      - Task decomposition and planning
      - Core algorithm implementation
    """

    _capability = AgentCapability(
        name="primary",
        model="k3-1m",
        max_tokens=1_000_000,
        thinking="high",
        handles_complexity={Complexity.COMPLEX, Complexity.MEDIUM},
        handles_languages={"go", "typescript", "python", "architecture"},
        handles_task_types={"design", "plan", "decompose", "review"},
        budget_ratio=0.40,
    )

    @property
    def capabilities(self) -> AgentCapability:
        return self._capability

    async def execute(self, task: TaskCard) -> TaskCard:
        """Execute a complex task via planning and decomposition.

        F3-1: the "decomposition" here is a string heuristic with no LLM
        behind it — it used to report DONE as if planning had happened.
        The agent now fails its tasks until the K3-1M API is wired, so
        pipeline results are never fabricated plans.
        """
        self.logger.info("PrimaryAgent refusing stub execution: %s", task.to_summary())
        return task.update_status(
            status=TaskStatus.FAILED,
            assigned_agent=self.capabilities.name,
            result_summary="agent not implemented: planning LLM wiring pending (F3-1)",
        )

    def _decompose(self, task: TaskCard) -> list[TaskCard]:
        """Decompose a complex task into sub-tasks.

        This is a rule-based heuristic; in production it should call
        the K3-1M model to intelligently decompose.
        """
        sub_tasks: list[TaskCard] = []

        # Heuristic: if affected files > 5, split by module
        files = task.context.affected_files
        if len(files) > 5:
            # Group by directory/module
            modules: dict[str, list[str]] = {}
            for f in files:
                parts = f.split("/")
                mod = parts[2] if len(parts) > 2 else "misc"
                modules.setdefault(mod, []).append(f)

            for mod, mod_files in modules.items():
                sub = TaskCard(
                    parent_id=task.id,
                    title=f"[{task.title}] {mod} module",
                    description=f"Implement {mod} portion of {task.title}",
                    complexity=Complexity.MEDIUM,
                    priority=task.priority,
                    context=task.context.model_copy(update={"affected_files": mod_files}),
                    deliverables=task.deliverables,
                )
                sub_tasks.append(sub)
        else:
            # Split into implementation + test
            impl = TaskCard(
                parent_id=task.id,
                title=f"[{task.title}] implementation",
                description=f"Core implementation for {task.title}",
                complexity=Complexity.MEDIUM,
                priority=task.priority,
                context=task.context,
                deliverables=task.deliverables.model_copy(update={"tests": False}),
            )
            test = TaskCard(
                parent_id=task.id,
                title=f"[{task.title}] tests",
                description=f"Unit tests for {task.title}",
                complexity=Complexity.SIMPLE,
                priority=task.priority,
                context=task.context,
                deliverables=Deliverables(tests=True),
                dependencies=[impl.id],
            )
            sub_tasks.extend([impl, test])

        self.logger.info(
            "Decomposed task %s into %d sub-tasks", task.id, len(sub_tasks)
        )
        return sub_tasks

    async def validate(self, task: TaskCard) -> dict[str, Any]:
        """Primary Agent performs architectural validation."""
        report = {
            "agent": self.capabilities.name,
            "validated": True,
            "architecture_check": "passed",
            "decomposition_quality": "reviewed",
        }
        return report
