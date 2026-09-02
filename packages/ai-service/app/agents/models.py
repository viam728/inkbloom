"""Pydantic schemas for the agent-based scene generation endpoint.

Request contract is assembled by the Go server; field names must stay
exactly in sync with the Go side (snake_case, alias-free).
"""

from pydantic import BaseModel, Field


class OutlineNodeCtx(BaseModel):
    """A single outline node within an act."""

    title: str
    status: str
    summary: str = ""


class OutlineAct(BaseModel):
    """One act of the novel outline with its nodes."""

    title: str
    nodes: list[OutlineNodeCtx] = []


class ChapterExcerpt(BaseModel):
    """An excerpt of a preceding chapter for continuity."""

    title: str
    excerpt: str


class MemoryItemCtx(BaseModel):
    """A memory item (character / setting / location / ...) from the memory panel."""

    name: str
    type: str
    content: str = ""
    fields: dict = {}
    relations: list = []


class AgentContext(BaseModel):
    """All context the Go side assembles for an agent generation call."""

    novel_title: str = ""
    novel_description: str = ""
    outline_acts: list[OutlineAct] = []
    preceding_chapters: list[ChapterExcerpt] = []
    memory_items: list[MemoryItemCtx] = []
    target_item: dict | None = Field(default=None)
    # 目标大纲节点（chapter 场景精确写作：本节点的标题+概要+状态）。
    target_node: dict | None = Field(default=None)
    # 知识图谱节点（世界设定/角色等已沉淀实体），供生成保持一致。
    knowledge_nodes: list[dict] = []
    # 未回收的伏笔线索，供生成埋设/回收一致。
    foreshadow_threads: list[dict] = []


class AgentGenerateRequest(BaseModel):
    """POST /api/agents/generate request body."""

    scene: str
    instruction: str = ""
    context: AgentContext


class AgentGenerateResponse(BaseModel):
    """POST /api/agents/generate response body."""

    content: str
    scene: str
    model: str | None = None
    elapsed_ms: int = 0
