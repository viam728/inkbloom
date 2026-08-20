"""Pipeline orchestrator for the InkBloom Agent team.

Implements the "plan -> implement -> verify" collaboration loop:

  1. Primary Agent decomposes complex tasks into sub-tasks
  2. Fullstack Agent implements medium/simple tasks
  3. Assistant Agent verifies and validates outputs
  4. On failure, tasks are retried or escalated

Supports sequential and parallel execution modes.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.agents.team.agents import AssistantAgent, BaseAgent, FullstackAgent, PrimaryAgent
from app.agents.team.router import RoutingDecision, TaskRouter
from app.agents.team.task_card import Complexity, TaskBatch, TaskCard, TaskStatus

logger = logging.getLogger(__name__)


class PipelineResult:
    """Result of a pipeline execution."""

    def __init__(
        self,
        batch_id: str,
        tasks: list[TaskCard],
        success: bool,
        summary: str = "",
    ):
        self.batch_id = batch_id
        self.tasks = tasks
        self.success = success
        self.summary = summary

    def to_dict(self) -> dict[str, Any]:
        return {
            "batch_id": self.batch_id,
            "success": self.success,
            "summary": self.summary,
            "task_count": len(self.tasks),
            "completed": len([t for t in self.tasks if t.status == TaskStatus.DONE]),
            "failed": len([t for t in self.tasks if t.status == TaskStatus.FAILED]),
            "tasks": [t.model_dump() for t in self.tasks],
        }


class TeamPipeline:
    """Orchestrates the Agent team collaboration pipeline.

    Usage::

        pipeline = TeamPipeline()
        result = await pipeline.run(task_card)
        # or
        result = await pipeline.run_batch(task_batch)
    """

    def __init__(
        self,
        max_retries: int = 2,
        enable_parallel: bool = True,
    ) -> None:
        self.router = TaskRouter()
        self.max_retries = max_retries
        self.enable_parallel = enable_parallel
        self.logger = logger

        # Agent cache for quick lookup
        self._primary = self.router.get_agent("primary")
        self._fullstack = self.router.get_agent("fullstack")
        self._assistant = self.router.get_agent("assistant")

    # ------------------------------------------------------------------ #
    # Single task execution
    # ------------------------------------------------------------------ #

    async def run(self, task: TaskCard) -> PipelineResult:
        """Execute a single task through the full pipeline."""
        self.logger.info("Pipeline starting for task: %s", task.to_summary())

        # Step 1: Route
        decision = self.router.route(task)
        task = task.update_status(TaskStatus.ASSIGNED, assigned_agent=decision.agent_name)

        # Step 2: Execute
        agent = self.router.get_agent(decision.agent_name)
        task = await self._execute_with_agent(agent, task)

        # Step 3: Verify (if not assistant already)
        if decision.agent_name != "assistant":
            task = await self._verify_task(task)

        # Step 4: Handle failures
        if task.status == TaskStatus.FAILED and task.retry_count < self.max_retries:
            task = await self._retry_task(task)

        success = task.status == TaskStatus.DONE
        summary = f"Task {task.id}: {task.status.value}"

        return PipelineResult(
            batch_id=task.id,
            tasks=[task],
            success=success,
            summary=summary,
        )

    # ------------------------------------------------------------------ #
    # Batch execution
    # ------------------------------------------------------------------ #

    async def run_batch(self, batch: TaskBatch) -> PipelineResult:
        """Execute a batch of tasks with dependency resolution."""
        self.logger.info(
            "Pipeline starting batch %s with %d tasks",
            batch.batch_id,
            len(batch.tasks),
        )

        # Working copy
        tasks_by_id: dict[str, TaskCard] = {t.id: t for t in batch.tasks}
        completed: set[str] = set()
        failed: set[str] = set()

        while len(completed) + len(failed) < len(batch.tasks):
            # Find ready tasks
            ready = [
                t for t in tasks_by_id.values()
                if t.status in (TaskStatus.PENDING, TaskStatus.ASSIGNED)
                and t.is_ready(completed)
            ]

            if not ready:
                # Deadlock detection: remaining tasks have unmet dependencies
                remaining = [
                    t for t in tasks_by_id.values()
                    if t.status not in (TaskStatus.DONE, TaskStatus.FAILED)
                ]
                if remaining:
                    for t in remaining:
                        t = t.update_status(TaskStatus.FAILED)
                        tasks_by_id[t.id] = t
                        failed.add(t.id)
                break

            if self.enable_parallel and len(ready) > 1:
                # Execute ready tasks in parallel
                results = await asyncio.gather(
                    *[self._run_single(tasks_by_id[t.id]) for t in ready],
                    return_exceptions=True,
                )
                for task, result in zip(ready, results):
                    if isinstance(result, Exception):
                        self.logger.error("Task %s failed with exception: %s", task.id, result)
                        task = task.update_status(TaskStatus.FAILED)
                        tasks_by_id[task.id] = task
                        failed.add(task.id)
                    else:
                        tasks_by_id[task.id] = result
                        if result.status == TaskStatus.DONE:
                            completed.add(result.id)
                        elif result.status == TaskStatus.FAILED:
                            failed.add(result.id)
            else:
                # Sequential execution
                for task in ready:
                    result = await self._run_single(task)
                    tasks_by_id[task.id] = result
                    if result.status == TaskStatus.DONE:
                        completed.add(result.id)
                    elif result.status == TaskStatus.FAILED:
                        failed.add(result.id)

        final_tasks = list(tasks_by_id.values())
        success = len(failed) == 0
        summary = (
            f"Batch {batch.batch_id}: "
            f"{len(completed)} done, {len(failed)} failed"
        )

        return PipelineResult(
            batch_id=batch.batch_id,
            tasks=final_tasks,
            success=success,
            summary=summary,
        )

    # ------------------------------------------------------------------ #
    # Internal helpers
    # ------------------------------------------------------------------ #

    async def _run_single(self, task: TaskCard) -> TaskCard:
        """Execute a single task (no dependency checks)."""
        decision = self.router.route(task)
        agent = self.router.get_agent(decision.agent_name)
        task = task.update_status(TaskStatus.ASSIGNED, assigned_agent=decision.agent_name)
        return await self._execute_with_agent(agent, task)

    async def _execute_with_agent(self, agent: BaseAgent, task: TaskCard) -> TaskCard:
        """Execute task with the given Agent, handling exceptions."""
        try:
            task = task.update_status(TaskStatus.IN_PROGRESS)
            result = await agent.execute(task)
            self.logger.info("Agent %s completed task %s", agent.capabilities.name, task.id)
            return result
        except Exception as exc:
            self.logger.exception(
                "Agent %s failed on task %s", agent.capabilities.name, task.id
            )
            return task.update_status(
                TaskStatus.FAILED,
                result_summary=f"Execution error: {exc}",
            )

    async def _verify_task(self, task: TaskCard) -> TaskCard:
        """Run Assistant Agent verification on a completed task."""
        if task.status != TaskStatus.DONE:
            return task

        self.logger.info("Verifying task %s with Assistant Agent", task.id)
        try:
            verify_task = TaskCard(
                parent_id=task.id,
                title=f"Verify: {task.title}",
                description="Post-execution verification",
                complexity=Complexity.SIMPLE,
                context=task.context,
            )
            result = await self._assistant.execute(verify_task)

            # Merge verification report into original task
            report = result.verification_report
            if report.get("all_passed", True):
                task = task.update_status(
                    TaskStatus.DONE,
                    result_summary=task.result_summary + " [verified]",
                    verification_report=report,
                )
            else:
                task = task.update_status(
                    TaskStatus.FAILED,
                    result_summary=task.result_summary + " [verification failed]",
                    verification_report=report,
                )
        except Exception as exc:
            self.logger.error("Verification failed for task %s: %s", task.id, exc)
            # Don't fail the task just because verification errored
            task = task.update_status(
                TaskStatus.DONE,
                result_summary=task.result_summary + " [verify error]",
            )

        return task

    async def _retry_task(self, task: TaskCard) -> TaskCard:
        """Retry a failed task, possibly escalating to a stronger Agent."""
        task = task.update_status(
            TaskStatus.PENDING,
            result_summary=task.result_summary + f" [retry {task.retry_count + 1}]",
        )
        # Increment retry count manually since update_status doesn't handle it
        data = task.model_dump()
        data["retry_count"] = task.retry_count + 1
        task = TaskCard.model_validate(data)

        # Escalation: if assistant failed, try fullstack; if fullstack failed, try primary
        escalation = {
            "assistant": "fullstack",
            "fullstack": "primary",
        }
        current = task.assigned_agent or "assistant"
        next_agent = escalation.get(current)

        if next_agent:
            self.logger.info(
                "Escalating task %s from %s to %s",
                task.id, current, next_agent,
            )
            task = task.update_status(TaskStatus.ASSIGNED, assigned_agent=next_agent)
            agent = self.router.get_agent(next_agent)
            return await self._execute_with_agent(agent, task)

        # No escalation possible, mark as failed
        return task.update_status(TaskStatus.FAILED)
