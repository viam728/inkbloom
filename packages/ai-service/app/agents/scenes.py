"""Scene registry for agent-based generation.

Each scene defines a system role prompt and a user-prompt template function
that consumes an ``AgentContext`` (base fields, relations, preceding
excerpts, memory items). The orchestrator drives the actual LLM calls.
"""

import json

from app.agents.models import AgentContext

# ── Context formatting helpers ──────────────────────────────────────────


def _format_outline(context: AgentContext) -> str:
    """Format outline acts/nodes into a readable block."""
    if not context.outline_acts:
        return ""
    lines: list[str] = []
    for i, act in enumerate(context.outline_acts, start=1):
        lines.append(f"第{i}幕：{act.title}")
        for node in act.nodes:
            summary = f"——{node.summary}" if node.summary else ""
            lines.append(f"  · {node.title}（{node.status}）{summary}")
    return "\n".join(lines)


def _format_chapters(context: AgentContext) -> str:
    """Format preceding chapter excerpts."""
    if not context.preceding_chapters:
        return ""
    lines: list[str] = []
    for ch in context.preceding_chapters:
        excerpt = ch.excerpt.strip() or "（无摘录）"
        lines.append(f"《{ch.title}》：\n{excerpt}")
    return "\n\n".join(lines)


def _format_memory(context: AgentContext) -> str:
    """Format memory items including base fields and relations."""
    if not context.memory_items:
        return ""
    lines: list[str] = []
    for item in context.memory_items:
        lines.append(f"- {item.name}（{item.type}）")
        if item.content:
            lines.append(f"  描述：{item.content}")
        if item.fields:
            fields = "；".join(f"{k}：{v}" for k, v in item.fields.items() if v)
            if fields:
                lines.append(f"  基本资料：{fields}")
        if item.relations:
            rels = []
            for rel in item.relations:
                if isinstance(rel, dict):
                    rels.append(
                        f"{rel.get('relation') or rel.get('type') or '关联'}："
                        f"{rel.get('target') or rel.get('name') or ''}"
                    )
                else:
                    rels.append(str(rel))
            rels = "；".join(r for r in rels if r and r != "关联：")
            if rels:
                lines.append(f"  人物关系：{rels}")
    return "\n".join(lines)


def _format_target_item(context: AgentContext) -> str:
    """Format the target item (the entity being generated/updated)."""
    if not context.target_item:
        return ""
    lines: list[str] = []
    for k, v in context.target_item.items():
        if v in (None, "", [], {}):
            continue
        if isinstance(v, (dict, list)):
            v = json.dumps(v, ensure_ascii=False)
        lines.append(f"{k}：{v}")
    return "\n".join(lines)


def _format_target_node(context: AgentContext) -> str:
    """Format the target outline node (the chapter to write)."""
    node = context.target_node or {}
    lines: list[str] = []
    title = node.get("title")
    summary = node.get("summary")
    if title:
        lines.append(f"本章节目标是：{title}")
    if summary:
        lines.append(f"章节梗概：{summary}")
    return "\n".join(lines)


def _format_knowledge_nodes(context: AgentContext) -> str:
    """Format knowledge-graph nodes (established entities) into a block."""
    if not context.knowledge_nodes:
        return ""
    lines: list[str] = []
    for node in context.knowledge_nodes:
        if not isinstance(node, dict):
            continue
        name = node.get("name") or ""
        typ = node.get("type") or ""
        desc = node.get("description") or ""
        if not name:
            continue
        label = f"- {name}" + (f"（{typ}）" if typ else "")
        if desc:
            label += f"：{desc}"
        lines.append(label)
    return "\n".join(lines)


def _format_foreshadow_threads(context: AgentContext) -> str:
    """Format open foreshadow threads (to plant/pay off consistently)."""
    if not context.foreshadow_threads:
        return ""
    lines: list[str] = []
    for t in context.foreshadow_threads:
        if not isinstance(t, dict):
            continue
        desc = t.get("description") or ""
        if desc:
            lines.append(f"- {desc}")
    return "\n".join(lines)


def _ctx_block(title: str, body: str) -> str:
    return f"【{title}】\n{body}\n\n" if body else ""


def _instruction_block(instruction: str) -> str:
    return f"【用户指令】\n{instruction.strip()}\n\n" if instruction.strip() else ""


def _common_context(context: AgentContext) -> str:
    """Shared context section used by most scenes."""
    parts = []
    if context.novel_title:
        parts.append(_ctx_block("作品", f"书名：《{context.novel_title}》"))
    parts.append(_ctx_block("作品简介", context.novel_description))
    parts.append(_ctx_block("大纲结构", _format_outline(context)))
    parts.append(_ctx_block("本章目标", _format_target_node(context)))
    parts.append(_ctx_block("前文摘录", _format_chapters(context)))
    parts.append(_ctx_block("相关记忆与设定", _format_memory(context)))
    parts.append(_ctx_block("已沉淀实体（知识图谱）", _format_knowledge_nodes(context)))
    parts.append(_ctx_block("待回收伏笔线索", _format_foreshadow_threads(context)))
    parts.append(_ctx_block("目标对象", _format_target_item(context)))
    return "".join(parts)


# ── Scene user-prompt templates ─────────────────────────────────────────


def _character_user_prompt(context: AgentContext, instruction: str) -> str:
    return (
        _instruction_block(instruction)
        + _common_context(context)
        + "任务：基于以上基本资料与人物关系，丰满该人物的细节设定，"
        "生成一段可直接展示的人物描述（包含外貌、性格、动机、说话方式、"
        "关键经历等）。\n"
        "要求：\n"
        "1. 严格保持与既有人设、人物关系一致，不得与已有设定冲突；\n"
        "2. 细节具体有画面感，避免空泛形容词堆砌；\n"
        "3. 直接输出正文段落，不要输出标题或解释。"
    )


def _setting_user_prompt(context: AgentContext, instruction: str) -> str:
    return (
        _instruction_block(instruction)
        + _common_context(context)
        + "任务：基于大纲、前文与既有设定，扩写该场景/世界观设定，"
        "生成一段可直接展示的设定描述（环境、规则、氛围、与剧情的关联等）。\n"
        "要求：\n"
        "1. 基于大纲与前文已出现的信息扩写，避免与既有设定冲突；\n"
        "2. 补充的细节需与作品整体基调一致，能服务于后续剧情；\n"
        "3. 直接输出正文段落，不要输出标题或解释。"
    )


def _summary_user_prompt(context: AgentContext, instruction: str) -> str:
    return (
        _instruction_block(instruction)
        + _common_context(context)
        + "任务：根据前文摘录、大纲与相关记忆，撰写一段剧情总结/概述，"
        "供作者快速回顾或作为续写参考。\n"
        "要求：\n"
        "1. 忠实于前文内容，不虚构未出现的情节；\n"
        "2. 抓住主线进展、关键转折与人物状态，语言精炼；\n"
        "3. 直接输出正文段落，不要输出标题或解释。"
    )


def _inspiration_user_prompt(context: AgentContext, instruction: str) -> str:
    return (
        _instruction_block(instruction)
        + _common_context(context)
        + "任务：结合当前作品上下文，提供创作灵感与桥段点子。\n"
        "要求：\n"
        "1. 输出 3-5 条具体、有画面感的灵感点子，每条 1-2 句；\n"
        "2. 点子需与既有设定、大纲走向相容，能自然融入剧情；\n"
        "3. 各条点子角度不同，避免雷同；直接输出点子本身，"
        "用换行分隔，不要编号以外的解释。"
    )


def _outline_user_prompt(context: AgentContext, instruction: str) -> str:
    return (
        _instruction_block(instruction)
        + _common_context(context)
        + "任务：基于以上上下文，生成或补全大纲内容（幕/节点级别的情节规划）。\n"
        "要求：\n"
        "1. 与既有大纲、人物设定保持一致，情节推进合乎逻辑；\n"
        "2. 每个节点包含标题与一句话概要，体现冲突与转折；\n"
        "3. 直接输出大纲文本（可用分点形式），不要输出解释。"
    )


def _chapter_user_prompt(context: AgentContext, instruction: str) -> str:
    """成稿一整章正文：以大纲结构/前文/记忆为纲，输出可直接落库的正文段落。"""
    return (
        _instruction_block(instruction)
        + _common_context(context)
        + "任务：基于以上大纲结构、前文摘录、既有记忆与设定，完整撰写本章正文。\n"
        "要求：\n"
        "1. 严格忠于大纲节点目标与前文已发生的情节，与人设、设定保持一致；\n"
        "2. 情节推进具体、有画面感，避免空泛；含必要的对话、动作、心理与氛围描写；\n"
        "3. 章节开头自然衔接前文，结尾留白或制造钩子，为后续章铺垫；\n"
        "4. **分段规范**：正文按情节自然分多个段落，段落之间用空行分隔（每个段落 2-5 句为宜），"
        "不得一整章挤成一坨；对话每人一段，另起一行；\n"
        "5. **插图占位**：在需要配图的关键场景处，单独一行输出插图占位符，格式为"
        "`[插图：画面描述]`（描述该图的人物、动作、环境、氛围，20 字以内）；"
        "每章 1-3 处插图占位，不贪多；\n"
        "6. 直接输出正文段落，不要输出标题、分点或任何解释，不要写“本章”等章节目录信息。"
    )


# ── Scene registry ──────────────────────────────────────────────────────

SCENE_SYSTEM_WRITER = (
    "你是一位经验丰富的中文小说创作助手，深度理解叙事结构、人物弧光与世界构建。"
    "输出可直接展示的中文正文段落，不要附加任何解释、标题或 markdown 标记。"
)

SCENES: dict[str, dict] = {
    "character": {
        "label": "人物生成",
        "system": (
            "你是一位擅长人物塑造的小说创作助手。你严格尊重既有人物设定与人物关系，"
            "在其基础上丰满细节，绝不与已有设定冲突。"
            "输出可直接展示的中文正文段落，不要附加任何解释、标题或 markdown 标记。"
        ),
        "user_prompt": _character_user_prompt,
        "temperature": 0.8,
        "max_tokens": 2048,
        "two_step": True,
    },
    "setting": {
        "label": "场景/世界观生成",
        "system": (
            "你是一位擅长世界构建的小说创作助手。你基于大纲、前文与既有设定扩写"
            "场景与世界观，严格避免与既有设定冲突。"
            "输出可直接展示的中文正文段落，不要附加任何解释、标题或 markdown 标记。"
        ),
        "user_prompt": _setting_user_prompt,
        "temperature": 0.8,
        "max_tokens": 2048,
        "two_step": True,
    },
    "summary": {
        "label": "剧情总结",
        "system": SCENE_SYSTEM_WRITER,
        "user_prompt": _summary_user_prompt,
        "temperature": 0.3,
        "max_tokens": 2048,
        "two_step": False,
    },
    "inspiration": {
        "label": "灵感激发",
        "system": (
            "你是一位创意充沛的小说创作助手，擅长在既有世界观内发散出新颖、"
            "可落地的剧情点子。直接输出点子本身，不要附加解释。"
        ),
        "user_prompt": _inspiration_user_prompt,
        "temperature": 0.9,
        "max_tokens": 2048,
        "two_step": False,
    },
    "outline": {
        "label": "大纲生成",
        "system": SCENE_SYSTEM_WRITER,
        "user_prompt": _outline_user_prompt,
        "temperature": 0.7,
        "max_tokens": 3000,
        "two_step": True,
    },
    # 章节成稿：产出可直接落库的正文段落（P1 全本创作流水线的核心场景）。
    "chapter": {
        "label": "章节正文生成",
        "system": (
            "你是一位资深中文小说家，擅长在既有大纲与已写章节的基础上，"
            "逐章推进情节、塑造人物、铺设伏笔。输出可直接落库的正文段落，"
            "不要附加任何解释、标题或 markdown 标记。"
        ),
        "user_prompt": _chapter_user_prompt,
        "temperature": 0.75,
        "max_tokens": 4096,
        "two_step": True,
    },
}


def get_scene(scene: str) -> dict | None:
    """Look up a scene config by key; returns None for unknown scenes."""
    return SCENES.get(scene)


def known_scene_keys() -> list[str]:
    return list(SCENES.keys())
