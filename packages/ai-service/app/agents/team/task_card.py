"""TaskCard model for Agent team inter-communication.

TaskCard provides a structured, lightweight protocol for passing tasks
between Agents without transmitting full code context. It captures
essential metadata, context summaries, and deliverable requirements.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class Priority(str, enum.Enum):
    """Task priority levels aligned with InkBloom gap taxonomy."""

    P0 = "P0"  # Blocking / critical
    P1 = "P1"  # Important / commercial
    P2 = "P2"  # Enhancement / nice-to-have


class Complexity(str, enum.Enum):
    """Task complexity tier used by the router to assign Agents."""

    SIMPLE = "simple"  # < 50 lines, single file
    MEDIUM = "medium"  # < 300 lines, < 5 files
    COMPLEX = "complex"  # architectural, multi-module


class TaskStatus(str, enum.Enum):
    """Lifecycle status of a TaskCard."""

    PENDING = "pending"
    ASSIGNED = "assigned"
    IN_PROGRESS = "in_progress"
    REVIEW = "review"
    DONE = "done"
    FAILED = "failed"
    ROLLED_BACK = "rolled_back"


class ContextSummary(BaseModel):
    """Lightweight context summary avoiding full code dumps."""

    affected_files: list[str] = Field(default_factory=list)
    relevant_modules: list[str] = Field(default_factory=list)
    key_interfaces: list[str] = Field(default_factory=list)
    existing_patterns: list[str] = Field(default_factory=list)
    notes: str = ""  # Free-form hints for the assigned Agent


class Deliverables(BaseModel):
    """Expected outputs from the task execution."""

    code_changes: list[str] = Field(default_factory=list)
    tests: bool = False
    documentation: bool = False


class TaskCard(BaseModel):
    """Structured task descriptor for Agent team collaboration.

    TaskCards are immutable once created; status transitions are tracked
    via ``update_status()`` which returns a new instance.
    """

    # Identity
    id: str = Field(default_factory=lambda: str(uuid.uuid4())[:8])
    parent_id: str | None = None  # For sub-tasks spawned by decomposition

    # Classification
    priority: Priority = Priority.P2
    complexity: Complexity = Complexity.MEDIUM
    status: TaskStatus = TaskStatus.PENDING

    # Descriptions
    title: str
    description: str = ""
    acceptance_criteria: list[str] = Field(default_factory=list)

    # Context (lightweight)
    context: ContextSummary = Field(default_factory=ContextSummary)

    # Dependencies
    dependencies: list[str] = Field(default_factory=list)

    # Outputs
    deliverables: Deliverables = Field(default_factory=Deliverables)

    # Assignment & provenance
    assigned_agent: str | None = None  # e.g. "primary", "fullstack", "assistant"
    created_by: str = "user"  # or agent name that spawned this
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)

    # Execution metadata (filled during pipeline)
    result_summary: str = ""  # Brief description of what was done
    verification_report: dict[str, Any] = Field(default_factory=dict)
    retry_count: int = 0

    def update_status(
        self,
        status: TaskStatus,
        assigned_agent: str | None = None,
        result_summary: str = "",
        verification_report: dict[str, Any] | None = None,
    ) -> TaskCard:
        """Return a new TaskCard with updated status and metadata.

        TaskCards are treated as value objects; mutations create copies.
        """
        data = self.model_dump()
        data["status"] = status.value
        data["updated_at"] = datetime.utcnow()
        if assigned_agent is not None:
            data["assigned_agent"] = assigned_agent
        if result_summary:
            data["result_summary"] = result_summary
        if verification_report is not None:
            data["verification_report"] = verification_report
        return TaskCard.model_validate(data)

    def is_ready(self, completed_ids: set[str]) -> bool:
        """Return True if all dependency tasks are completed."""
        return all(dep in completed_ids for dep in self.dependencies)

    def to_summary(self) -> str:
        """One-line human-readable summary for logging."""
        return (
            f"[{self.priority.value}] {self.title} "
            f"({self.complexity.value}) -> {self.assigned_agent or 'unassigned'} "
            f"[{self.status.value}]"
        )


class TaskBatch(BaseModel):
    """A batch of TaskCards with shared metadata."""

    batch_id: str = Field(default_factory=lambda: str(uuid.uuid4())[:8])
    title: str = ""
    tasks: list[TaskCard] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=datetime.utcnow)

    def by_status(self, status: TaskStatus) -> list[TaskCard]:
        return [t for t in self.tasks if t.status == status]

    def ready_tasks(self) -> list[TaskCard]:
        completed = {t.id for t in self.tasks if t.status == TaskStatus.DONE}
        return [t for t in self.tasks if t.is_ready(completed)]
