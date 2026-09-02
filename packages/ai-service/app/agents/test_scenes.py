"""Unit tests for agent scene context formatting (novel description)."""

from app.agents.models import AgentContext
from app.agents.scenes import _common_context


def test_common_context_includes_novel_description():
    ctx = AgentContext(novel_title="测试作品", novel_description="一个关于剑客的故事")
    out = _common_context(ctx)
    assert "作品简介" in out
    assert "一个关于剑客的故事" in out


def test_common_context_omits_empty_description():
    ctx = AgentContext(novel_title="测试作品", novel_description="")
    out = _common_context(ctx)
    assert "作品简介" not in out


def test_common_context_omits_missing_description():
    ctx = AgentContext(novel_title="测试作品")
    out = _common_context(ctx)
    assert "作品简介" not in out