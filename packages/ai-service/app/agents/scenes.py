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


def _ctx_block(title: str, body: str) -> str:
    return f"【{title}】\n{body}\n\n" if body else ""


def _instruction_block(instruction: str) -> str:
    return f"【用户指令】\n{instruction.strip()}\n\n" if instruction.strip() else ""


def _common_context(context: AgentContext) -> str:
    """Shared context section used by most scenes."""
    parts = []
    if context.novel_title:
        parts.append(_ctx_block("作品", f"书名：《{context.novel_title}》"))
    parts.append(_ctx_block("大纲结构", _format_outline(context)))
    parts.append(_ctx_block("前文摘录", _format_chapters(context)))
    parts.append(_ctx_block("相关记忆与设定", _format_memory(context)))
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
}


def get_scene(scene: str) -> dict | None:
    """Look up a scene config by key; returns None for unknown scenes."""
    return SCENES.get(scene)


def known_scene_keys() -> list[str]:
    return list(SCENES.keys())
