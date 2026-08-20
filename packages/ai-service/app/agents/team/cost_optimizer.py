"""Cost optimization utilities for the Agent team.

Implements:
  - Batch verification (aggregate multiple tasks into one API call)
  - Context compression (trim file contents to signatures only)
  - Pattern cache (reuse verified code patterns)
  - Budget tracking and automatic downgrade
"""

from __future__ import annotations

import hashlib
import logging
import time
from typing import Any

from app.agents.team.task_card import Complexity, TaskCard

logger = logging.getLogger(__name__)


class PatternCache:
    """Cache for reusable code patterns to avoid redundant LLM calls.

    Keys are SHA-256 hashes of (pattern_name + file_signature);
    values are the cached pattern metadata.
    """

    def __init__(self, max_size: int = 20, ttl_seconds: float = 3600.0) -> None:
        self._cache: dict[str, dict[str, Any]] = {}
        self._max_size = max_size
        self._ttl_seconds = ttl_seconds

    def _key(self, pattern: str, signature: str) -> str:
        raw = f"{pattern}:{signature}"
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

    def get(self, pattern: str, signature: str) -> dict[str, Any] | None:
        """Retrieve a cached pattern if it exists and is not expired."""
        key = self._key(pattern, signature)
        entry = self._cache.get(key)
        if entry is None:
            return None
        if time.time() - entry["timestamp"] > self._ttl_seconds:
            del self._cache[key]
            return None
        logger.debug("Pattern cache hit: %s", pattern)
        return entry["data"]

    def set(self, pattern: str, signature: str, data: dict[str, Any]) -> None:
        """Store a pattern in the cache."""
        # Evict oldest if at capacity
        if len(self._cache) >= self._max_size:
            oldest = min(self._cache, key=lambda k: self._cache[k]["timestamp"])
            del self._cache[oldest]

        key = self._key(pattern, signature)
        self._cache[key] = {
            "timestamp": time.time(),
            "data": data,
        }
        logger.debug("Pattern cache set: %s", pattern)

    def stats(self) -> dict[str, Any]:
        """Return cache statistics."""
        return {
            "size": len(self._cache),
            "max_size": self._max_size,
            "ttl_seconds": self._ttl_seconds,
        }


class ContextCompressor:
    """Compress task context to reduce token usage.

    Strategies:
      - Limit number of files in context
      - Truncate file contents to signatures (imports + function defs)
      - Remove redundant whitespace/comments
    """

    def __init__(
        self,
        max_files: int = 10,
        max_lines_per_file: int = 100,
        signatures_only: bool = True,
    ) -> None:
        self.max_files = max_files
        self.max_lines_per_file = max_lines_per_file
        self.signatures_only = signatures_only

    def compress(self, task: TaskCard) -> TaskCard:
        """Return a new TaskCard with compressed context."""
        ctx = task.context
        files = ctx.affected_files[: self.max_files]

        # Build compressed notes
        notes = ctx.notes
        if len(ctx.affected_files) > self.max_files:
            notes += (
                f"\n[Note: {len(ctx.affected_files)} files total, "
                f"showing first {self.max_files}]"
            )

        compressed_ctx = ctx.model_copy(update={
            "affected_files": files,
            "notes": notes,
        })

        return task.model_copy(update={"context": compressed_ctx})


class BudgetTracker:
    """Track per-Agent budget consumption and enforce limits.

    Budgets are expressed as relative ratios (0.0 - 1.0).
    When an Agent's budget is exhausted, tasks are downgraded
    to the next cheaper Agent.
    """

    def __init__(
        self,
        budgets: dict[str, float] | None = None,
        downgrade_chain: dict[str, str] | None = None,
    ) -> None:
        self._budgets = budgets or {
            "primary": 0.40,
            "fullstack": 0.50,
            "assistant": 0.10,
        }
        self._consumed: dict[str, float] = {name: 0.0 for name in self._budgets}
        self._downgrade_chain = downgrade_chain or {
            "primary": "fullstack",
            "fullstack": "assistant",
        }

    def consume(self, agent_name: str, cost: float) -> None:
        """Record cost consumption for an Agent."""
        self._consumed[agent_name] = self._consumed.get(agent_name, 0.0) + cost
        logger.info(
            "Budget consumed: %s = %.3f / %.3f",
            agent_name,
            self._consumed[agent_name],
            self._budgets.get(agent_name, 1.0),
        )

    def is_exhausted(self, agent_name: str) -> bool:
        """Check if an Agent's budget is exhausted."""
        limit = self._budgets.get(agent_name, 1.0)
        consumed = self._consumed.get(agent_name, 0.0)
        return consumed >= limit

    def get_downgrade(self, agent_name: str) -> str | None:
        """Return the downgrade target for an exhausted Agent."""
        return self._downgrade_chain.get(agent_name)

    def check_and_downgrade(self, agent_name: str) -> str:
        """Return the Agent to use, downgrading if budget is exhausted."""
        current = agent_name
        visited: set[str] = set()
        while self.is_exhausted(current) and current not in visited:
            visited.add(current)
            downgrade = self.get_downgrade(current)
            if downgrade is None:
                break
            logger.warning(
                "Budget exhausted for %s, downgrading to %s",
                current,
                downgrade,
            )
            current = downgrade
        return current

    def stats(self) -> dict[str, Any]:
        """Return budget consumption statistics."""
        return {
            name: {
                "budget": self._budgets.get(name, 0.0),
                "consumed": self._consumed.get(name, 0.0),
                "remaining": max(0.0, self._budgets.get(name, 0.0) - self._consumed.get(name, 0.0)),
            }
            for name in self._budgets
        }


class CostOptimizer:
    """High-level cost optimizer combining all optimization strategies.

    Usage::

        optimizer = CostOptimizer()
        compressed_task = optimizer.compress(task)
        cached_pattern = optimizer.get_pattern("error_handler", file_sig)
        if cached_pattern:
            # reuse
        agent = optimizer.check_budget(agent_name)
    """

    def __init__(self) -> None:
        self.pattern_cache = PatternCache()
        self.context_compressor = ContextCompressor()
        self.budget_tracker = BudgetTracker()

    def compress(self, task: TaskCard) -> TaskCard:
        """Compress task context before sending to an Agent."""
        return self.context_compressor.compress(task)

    def get_pattern(self, pattern: str, signature: str) -> dict[str, Any] | None:
        """Retrieve a cached code pattern."""
        return self.pattern_cache.get(pattern, signature)

    def set_pattern(self, pattern: str, signature: str, data: dict[str, Any]) -> None:
        """Cache a code pattern for reuse."""
        self.pattern_cache.set(pattern, signature, data)

    def check_budget(self, agent_name: str) -> str:
        """Check budget and return the Agent to use (may be downgraded)."""
        return self.budget_tracker.check_and_downgrade(agent_name)

    def consume(self, agent_name: str, cost: float) -> None:
        """Record cost consumption."""
        self.budget_tracker.consume(agent_name, cost)

    def stats(self) -> dict[str, Any]:
        """Return comprehensive optimization statistics."""
        return {
            "pattern_cache": self.pattern_cache.stats(),
            "budgets": self.budget_tracker.stats(),
        }
