"""Final comprehensive verification script for the Agent team architecture."""

import asyncio
import os

import yaml

from app.agents.team import (
    BudgetTracker,
    Complexity,
    ContextCompressor,
    ContextSummary,
    CostOptimizer,
    PatternCache,
    Priority,
    TaskBatch,
    TaskCard,
    TaskRouter,
    TeamPipeline,
)


def test_router_accuracy():
    """Test 2: Router accuracy."""
    print("2. Router Accuracy Test")
    router = TaskRouter()
    test_cases = [
        ("Fix lint", "simple", "assistant"),
        ("Implement API", "medium", "fullstack"),
        ("Design architecture", "complex", "primary"),
        ("Write tests", "simple", "assistant"),
        ("Refactor module", "medium", "fullstack"),
    ]
    passed = 0
    for title, complexity, expected in test_cases:
        task = TaskCard(title=title, complexity=Complexity(complexity))
        decision = router.route(task)
        ok = decision.agent_name == expected
        if ok:
            passed += 1
        marker = "OK" if ok else f"FAIL (expected: {expected})"
        print(f"  {title} ({complexity}) -> {decision.agent_name} [{marker}]")
    print(f"  Accuracy: {passed}/{len(test_cases)} = {passed/len(test_cases)*100:.0f}%")
    assert passed == len(test_cases), "Router accuracy below 100%"


async def test_pipeline():
    """Test 3: Pipeline execution."""
    print()
    print("3. Pipeline Execution Test")
    pipeline = TeamPipeline()

    # Single task
    task = TaskCard(title="Test task", complexity=Complexity.SIMPLE)
    result = await pipeline.run(task)
    assert result.success, "Single task should succeed"
    print("  Single task: OK")

    # Batch with dependencies
    t1 = TaskCard(title="Impl", complexity=Complexity.MEDIUM)
    t2 = TaskCard(title="Test", complexity=Complexity.SIMPLE, dependencies=[t1.id])
    batch = TaskBatch(tasks=[t1, t2])
    result = await pipeline.run_batch(batch)
    assert result.success, "Batch should succeed"
    assert len(result.tasks) == 2
    print("  Batch with dependencies: OK")

    # Complex task decomposition
    t3 = TaskCard(
        title="Design system",
        complexity=Complexity.COMPLEX,
        context=ContextSummary(affected_files=["a.go", "b.go", "c.go", "d.go", "e.go", "f.go"]),
    )
    result = await pipeline.run(t3)
    assert result.success
    print("  Complex task decomposition: OK")


def test_cost_optimizer():
    """Test 4: Cost optimizer."""
    print()
    print("4. Cost Optimizer Test")
    opt = CostOptimizer()

    # Pattern cache
    opt.set_pattern("error_handler", "go", {"pattern": "if err != nil"})
    p = opt.get_pattern("error_handler", "go")
    assert p is not None, "Pattern should be cached"
    print("  Pattern cache: OK")

    # Context compression
    big_task = TaskCard(
        title="Big task",
        complexity=Complexity.MEDIUM,
        context=ContextSummary(affected_files=[f"file{i}.go" for i in range(20)]),
    )
    compressed = opt.compress(big_task)
    assert len(compressed.context.affected_files) <= 10, "Should compress to max 10 files"
    print("  Context compression: OK")

    # Budget tracking
    opt.consume("assistant", 0.05)
    opt.consume("fullstack", 0.30)
    stats = opt.stats()
    assert "budgets" in stats
    assert "pattern_cache" in stats
    print("  Budget tracking: OK")

    # Budget downgrade
    opt.budget_tracker._consumed["fullstack"] = 0.60
    downgraded = opt.check_budget("fullstack")
    assert downgraded == "assistant", "Should downgrade to assistant"
    print("  Budget downgrade: OK")


def test_config_file():
    """Test 5: Configuration file."""
    print()
    print("5. Configuration File Test")
    with open(".qoder/agents/team.yaml", "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    assert cfg["version"] == "1.0"
    assert len(cfg["team"]["agents"]) == 3
    assert len(cfg["team"]["routing_rules"]) >= 6
    print("  team.yaml: OK (3 agents, 6+ routing rules)")


def test_file_structure():
    """Test 6: File structure."""
    print()
    print("6. File Structure Test")
    base = "packages/ai-service/"
    expected_files = [
        base + "app/agents/team/__init__.py",
        base + "app/agents/team/task_card.py",
        base + "app/agents/team/router.py",
        base + "app/agents/team/pipeline.py",
        base + "app/agents/team/cost_optimizer.py",
        base + "app/agents/team/routes.py",
        base + "app/agents/team/agents/__init__.py",
        base + "app/agents/team/agents/base.py",
        base + "app/agents/team/agents/primary.py",
        base + "app/agents/team/agents/fullstack.py",
        base + "app/agents/team/agents/assistant.py",
        ".qoder/agents/team.yaml",
    ]
    for f in expected_files:
        assert os.path.exists(f), f"Missing: {f}"
        print(f"  {f}: OK")


async def main():
    print("=== Final Comprehensive Verification ===")
    print()

    # 1. Module imports
    print("1. Module imports: OK")

    test_router_accuracy()
    await test_pipeline()
    test_cost_optimizer()
    test_config_file()
    test_file_structure()

    print()
    print("=== ALL VERIFICATIONS PASSED ===")
    print()
    print("Agent Team Architecture is fully implemented and operational.")


if __name__ == "__main__":
    asyncio.run(main())
