"""Agent team package initialization.

Exports the core team components: TaskCard, Router, Pipeline, and Agents.
"""

from app.agents.team.agents import (
    AgentCapability,
    AssistantAgent,
    BaseAgent,
    FullstackAgent,
    PrimaryAgent,
)
from app.agents.team.cost_optimizer import (
    BudgetTracker,
    ContextCompressor,
    CostOptimizer,
    PatternCache,
)
from app.agents.team.pipeline import PipelineResult, TeamPipeline
from app.agents.team.router import RoutingDecision, TaskRouter
from app.agents.team.task_card import (
    Complexity,
    ContextSummary,
    Deliverables,
    Priority,
    TaskBatch,
    TaskCard,
    TaskStatus,
)

__all__ = [
    # Agents
    "AgentCapability",
    "BaseAgent",
    "PrimaryAgent",
    "FullstackAgent",
    "AssistantAgent",
    # Router
    "TaskRouter",
    "RoutingDecision",
    # Pipeline
    "TeamPipeline",
    "PipelineResult",
    # Cost optimization
    "CostOptimizer",
    "PatternCache",
    "ContextCompressor",
    "BudgetTracker",
    # Task models
    "TaskCard",
    "TaskBatch",
    "TaskStatus",
    "Priority",
    "Complexity",
    "ContextSummary",
    "Deliverables",
]
