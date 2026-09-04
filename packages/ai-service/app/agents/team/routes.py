"""HTTP routes for the Agent team collaboration endpoints.

Provides endpoints for:
  - Task routing and assignment
  - Pipeline execution (single task and batch)
  - Agent capability introspection
  - Team status and health
"""

from __future__ import annotations

import logging
import time
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.agents.team import (
    Complexity,
    ContextSummary,
    CostOptimizer,
    Deliverables,
    PipelineResult,
    Priority,
    TaskBatch,
    TaskCard,
    TaskRouter,
    TaskStatus,
    TeamPipeline,
)

logger = logging.getLogger(__name__)

# Shared instances
_router = TaskRouter()
_pipeline = TeamPipeline()
_optimizer = CostOptimizer()


def _reject_unimplemented(result: PipelineResult) -> None:
    """F3-1: a task that died on a stub agent is a 501, not a fake success.

    The stub agents previously returned `success=true` / DONE with nothing
    behind it; when every task in a run failed with the not-implemented
    marker, the endpoint now refuses to pretend work happened.
    """
    tasks = getattr(result, "tasks", None) or []
    if not tasks:
        return
    failed_on_stub = [
        t
        for t in tasks
        if getattr(getattr(t, "status", None), "name", str(getattr(t, "status", ""))) == "FAILED"
        and "not implemented" in (getattr(t, "result_summary", "") or "")
    ]
    if len(failed_on_stub) == len(tasks):
        raise HTTPException(
            status_code=501,
            detail="agent not implemented: this task type has no real LLM wiring yet (F3-1)",
        )


# ── Request / Response models ───────────────────────────────────────────


class TaskCardRequest(BaseModel):
    """Request to create and route a TaskCard."""

    title: str
    description: str = ""
    priority: str = "P2"
    complexity: str = "medium"
    acceptance_criteria: list[str] = []
    affected_files: list[str] = []
    relevant_modules: list[str] = []
    key_interfaces: list[str] = []
    existing_patterns: list[str] = []
    notes: str = ""
    dependencies: list[str] = []
    code_changes: list[str] = []
    tests: bool = False
    documentation: bool = False


class TaskCardResponse(BaseModel):
    """Response containing the routed TaskCard and decision."""

    task: dict[str, Any]
    decision: dict[str, Any]
    elapsed_ms: int


class PipelineExecuteRequest(BaseModel):
    """Request to execute a task through the full pipeline."""

    task: TaskCardRequest


class PipelineBatchRequest(BaseModel):
    """Request to execute a batch of tasks."""

    title: str = ""
    tasks: list[TaskCardRequest]


class PipelineExecuteResponse(BaseModel):
    """Response from pipeline execution."""

    success: bool
    summary: str
    result: dict[str, Any]
    elapsed_ms: int


class AgentInfoResponse(BaseModel):
    """Response containing Agent capability information."""

    agents: list[dict[str, Any]]


# ── Helper functions ────────────────────────────────────────────────────


def _make_task_card(req: TaskCardRequest) -> TaskCard:
    """Convert a request into a TaskCard."""
    return TaskCard(
        title=req.title,
        description=req.description,
        priority=Priority(req.priority.upper()),
        complexity=Complexity(req.complexity.lower()),
        acceptance_criteria=req.acceptance_criteria,
        context=ContextSummary(
            affected_files=req.affected_files,
            relevant_modules=req.relevant_modules,
            key_interfaces=req.key_interfaces,
            existing_patterns=req.existing_patterns,
            notes=req.notes,
        ),
        dependencies=req.dependencies,
        deliverables=Deliverables(
            code_changes=req.code_changes,
            tests=req.tests,
            documentation=req.documentation,
        ),
    )


# ── Router factory ──────────────────────────────────────────────────────


def create_team_router() -> APIRouter:
    """Create the Agent team router."""
    router = APIRouter()

    @router.post("/api/agents/team/assign", response_model=TaskCardResponse)
    async def assign_task(request: TaskCardRequest):
        """Route a task to the most appropriate Agent.

        Returns the TaskCard with assigned_agent populated and the
        routing decision metadata.
        """
        start = time.perf_counter()
        task = _make_task_card(request)
        decision = _router.route(task)
        task = task.update_status(TaskStatus.ASSIGNED, assigned_agent=decision.agent_name)
        elapsed_ms = int((time.perf_counter() - start) * 1000)

        logger.info(
            "Task '%s' routed to %s (confidence=%.2f)",
            task.title,
            decision.agent_name,
            decision.confidence,
        )

        return {
            "task": task.model_dump(),
            "decision": decision.to_dict(),
            "elapsed_ms": elapsed_ms,
        }

    @router.post("/api/agents/team/execute", response_model=PipelineExecuteResponse)
    async def execute_task(request: PipelineExecuteRequest):
        """Execute a single task through the full Agent team pipeline.

        The pipeline performs: route -> execute -> verify -> retry on failure.
        F3-1: stub agents now surface as 501 instead of a fake `success=true`
        with no artifact behind it.
        """
        start = time.perf_counter()
        task = _make_task_card(request.task)
        result = await _pipeline.run(task)
        elapsed_ms = int((time.perf_counter() - start) * 1000)

        _reject_unimplemented(result)

        return {
            "success": result.success,
            "summary": result.summary,
            "result": result.to_dict(),
            "elapsed_ms": elapsed_ms,
        }

    @router.post("/api/agents/team/batch", response_model=PipelineExecuteResponse)
    async def execute_batch(request: PipelineBatchRequest):
        """Execute a batch of tasks with dependency resolution.

        Tasks are executed in dependency order, with independent tasks
        running in parallel when enable_parallel is True.
        """
        start = time.perf_counter()
        batch = TaskBatch(
            title=request.title,
            tasks=[_make_task_card(t) for t in request.tasks],
        )
        result = await _pipeline.run_batch(batch)
        elapsed_ms = int((time.perf_counter() - start) * 1000)

        _reject_unimplemented(result)

        return {
            "success": result.success,
            "summary": result.summary,
            "result": result.to_dict(),
            "elapsed_ms": elapsed_ms,
        }

    @router.get("/api/agents/team/agents", response_model=AgentInfoResponse)
    async def list_agents():
        """List all registered Agents and their capabilities."""
        return {"agents": _router.list_agents()}

    @router.get("/api/agents/team/health")
    async def team_health():
        """Health check for the Agent team."""
        return {
            "status": "ok",
            "agents_registered": len(_router.list_agents()),
            "pipeline_parallel": _pipeline.enable_parallel,
            "max_retries": _pipeline.max_retries,
            "optimizer": _optimizer.stats(),
        }

    @router.get("/api/agents/team/stats")
    async def team_stats():
        """Return cost optimization statistics."""
        return _optimizer.stats()

    return router
