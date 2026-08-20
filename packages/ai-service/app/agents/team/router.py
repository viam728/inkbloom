"""Task Router for the InkBloom Agent team.

The router analyses incoming TaskCards and assigns them to the
most appropriate Agent based on complexity, language, task type,
and current budget constraints. It supports:

  - Rule-based routing (heuristics)
  - Capability matching
  - Budget-aware load balancing
  - Escalation / fallback chains
"""

from __future__ import annotations

import logging
from typing import Any

from app.agents.team.agents import AssistantAgent, BaseAgent, FullstackAgent, PrimaryAgent
from app.agents.team.task_card import Complexity, TaskCard, TaskStatus

logger = logging.getLogger(__name__)


class RoutingDecision:
    """Outcome of a routing decision."""

    def __init__(
        self,
        agent_name: str,
        reason: str,
        confidence: float = 1.0,
        fallback_chain: list[str] | None = None,
    ):
        self.agent_name = agent_name
        self.reason = reason
        self.confidence = confidence
        self.fallback_chain = fallback_chain or []

    def to_dict(self) -> dict[str, Any]:
        return {
            "agent_name": self.agent_name,
            "reason": self.reason,
            "confidence": self.confidence,
            "fallback_chain": self.fallback_chain,
        }


class TaskRouter:
    """Routes TaskCards to the appropriate Agent.

    Usage::

        router = TaskRouter()
        decision = router.route(task)
        agent = router.get_agent(decision.agent_name)
        result = await agent.execute(task)
    """

    def __init__(self) -> None:
        # Initialise the three Agents
        self._agents: dict[str, BaseAgent] = {
            "primary": PrimaryAgent(),
            "fullstack": FullstackAgent(),
            "assistant": AssistantAgent(),
        }
        self.logger = logger

    # ------------------------------------------------------------------ #
    # Public API
    # ------------------------------------------------------------------ #

    def route(self, task: TaskCard) -> RoutingDecision:
        """Analyse the task and return a routing decision."""
        self.logger.info("Routing task: %s", task.to_summary())

        # 1. Rule-based fast path
        decision = self._rule_based_route(task)
        if decision:
            self.logger.info(
                "Rule-based route: %s (reason: %s)",
                decision.agent_name,
                decision.reason,
            )
            return decision

        # 2. Capability matching
        decision = self._capability_route(task)
        if decision:
            self.logger.info(
                "Capability route: %s (reason: %s)",
                decision.agent_name,
                decision.reason,
            )
            return decision

        # 3. Default fallback
        return RoutingDecision(
            agent_name="fullstack",
            reason="default fallback",
            confidence=0.5,
            fallback_chain=["primary", "assistant"],
        )

    def get_agent(self, name: str) -> BaseAgent:
        """Retrieve an Agent by name."""
        if name not in self._agents:
            raise ValueError(f"Unknown agent: {name}")
        return self._agents[name]

    def list_agents(self) -> list[dict[str, Any]]:
        """Return capability descriptors for all registered Agents."""
        return [agent.capabilities.to_dict() for agent in self._agents.values()]

    # ------------------------------------------------------------------ #
    # Routing heuristics
    # ------------------------------------------------------------------ #

    def _rule_based_route(self, task: TaskCard) -> RoutingDecision | None:
        """Apply hard-coded routing rules (fast, deterministic).

        Rules are evaluated in order; the first match wins.
        """
        rules = [
            # Simple tasks -> assistant
            (
                lambda t: t.complexity == Complexity.SIMPLE,
                "assistant",
                "simple task",
            ),
            # Complex tasks -> primary
            (
                lambda t: t.complexity == Complexity.COMPLEX,
                "primary",
                "complex architectural task",
            ),
            # Test/lint/doc tasks -> assistant
            (
                lambda t: any(
                    kw in t.title.lower()
                    for kw in ("test", "lint", "doc", "format", "verify")
                ),
                "assistant",
                "verification task",
            ),
            # Design/plan tasks -> primary
            (
                lambda t: any(
                    kw in t.title.lower() for kw in ("design", "plan", "arch")
                ),
                "primary",
                "design/planning task",
            ),
        ]

        for predicate, agent_name, reason in rules:
            if predicate(task):
                return RoutingDecision(
                    agent_name=agent_name,
                    reason=reason,
                    confidence=0.9,
                    fallback_chain=self._fallback_chain(agent_name),
                )

        return None

    def _capability_route(self, task: TaskCard) -> RoutingDecision | None:
        """Match task against Agent capabilities."""
        candidates: list[tuple[str, float]] = []

        for name, agent in self._agents.items():
            if not agent.can_handle(task):
                continue
            # Score by capability fit
            score = self._score_fit(agent, task)
            candidates.append((name, score))

        if not candidates:
            return None

        # Pick highest score
        candidates.sort(key=lambda x: x[1], reverse=True)
        best_name, best_score = candidates[0]

        return RoutingDecision(
            agent_name=best_name,
            reason=f"capability match (score={best_score:.2f})",
            confidence=min(best_score, 1.0),
            fallback_chain=[n for n, _ in candidates[1:]],
        )

    def _score_fit(self, agent: BaseAgent, task: TaskCard) -> float:
        """Score how well an Agent fits a task (0.0 - 1.0+)."""
        cap = agent.capabilities
        score = 0.0

        # Complexity match
        if task.complexity in cap.handles_complexity:
            score += 0.4

        # Language match
        if cap.handles_languages and task.context.notes:
            notes = task.context.notes.lower()
            for lang in cap.handles_languages:
                if lang in notes:
                    score += 0.2
                    break

        # Task type match
        if cap.handles_task_types:
            title = task.title.lower()
            for tt in cap.handles_task_types:
                if tt in title:
                    score += 0.2
                    break

        # Budget efficiency (prefer cheaper Agents for simple tasks)
        if task.complexity == Complexity.SIMPLE and cap.budget_ratio < 0.2:
            score += 0.2

        return score

    def _fallback_chain(self, primary: str) -> list[str]:
        """Return fallback Agent names for a given primary assignment."""
        chain = ["fullstack", "primary", "assistant"]
        if primary in chain:
            chain.remove(primary)
        return chain

    # ------------------------------------------------------------------ #
    # Batch routing
    # ------------------------------------------------------------------ #

    def route_batch(self, tasks: list[TaskCard]) -> list[tuple[TaskCard, RoutingDecision]]:
        """Route multiple tasks, returning (task, decision) pairs."""
        results: list[tuple[TaskCard, RoutingDecision]] = []
        for task in tasks:
            decision = self.route(task)
            results.append((task, decision))
        return results
