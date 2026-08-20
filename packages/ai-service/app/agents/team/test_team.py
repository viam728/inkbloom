"""Integration tests for the Agent team API endpoints."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_team_health():
    resp = client.get("/api/agents/team/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["agents_registered"] == 3
    assert data["pipeline_parallel"] is True
    assert data["max_retries"] == 2


def test_list_agents():
    resp = client.get("/api/agents/team/agents")
    assert resp.status_code == 200
    agents = resp.json()["agents"]
    assert len(agents) == 3
    names = {a["name"] for a in agents}
    assert names == {"primary", "fullstack", "assistant"}


def test_assign_simple_task():
    resp = client.post("/api/agents/team/assign", json={
        "title": "Fix lint error",
        "complexity": "simple",
        "affected_files": ["utils.go"],
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["decision"]["agent_name"] == "assistant"
    assert data["task"]["status"] == "assigned"


def test_assign_complex_task():
    resp = client.post("/api/agents/team/assign", json={
        "title": "Design distributed architecture",
        "complexity": "complex",
        "affected_files": ["engine.go", "worker.go", "scheduler.go"],
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["decision"]["agent_name"] == "primary"


def test_execute_task():
    resp = client.post("/api/agents/team/execute", json={
        "task": {
            "title": "Add unit tests",
            "complexity": "simple",
            "affected_files": ["test.go"],
            "tests": True,
        }
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["success"] is True


def test_batch_execution():
    resp = client.post("/api/agents/team/batch", json={
        "title": "W1 Fixes",
        "tasks": [
            {"title": "Fix A", "complexity": "medium", "affected_files": ["a.go"]},
            {"title": "Fix B", "complexity": "simple", "affected_files": ["b.go"]},
        ]
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["success"] is True
    result = data["result"]
    assert result["task_count"] == 2
    assert result["completed"] == 2
    assert result["failed"] == 0


def test_team_stats():
    resp = client.get("/api/agents/team/stats")
    assert resp.status_code == 200
    data = resp.json()
    assert "pattern_cache" in data
    assert "budgets" in data


if __name__ == "__main__":
    test_health()
    print("test_health PASSED")

    test_team_health()
    print("test_team_health PASSED")

    test_list_agents()
    print("test_list_agents PASSED")

    test_assign_simple_task()
    print("test_assign_simple_task PASSED")

    test_assign_complex_task()
    print("test_assign_complex_task PASSED")

    test_execute_task()
    print("test_execute_task PASSED")

    test_batch_execution()
    print("test_batch_execution PASSED")

    test_team_stats()
    print("test_team_stats PASSED")

    print()
    print("=== ALL INTEGRATION TESTS PASSED ===")
