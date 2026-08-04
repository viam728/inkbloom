"""Context-aware Prompt builder for novel writing assistance."""

import os
from pathlib import Path

_TEMPLATES_DIR = Path(__file__).parent / "templates"


def _load_template(name: str) -> str:
    """Load a prompt template by filename (without .txt extension)."""
    path = _TEMPLATES_DIR / f"{name}.txt"
    if path.exists():
        return path.read_text(encoding="utf-8").strip()
    return ""


class PromptBuilder:
    """根据小说上下文自动组装 AI Prompt。"""

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def build_chat_prompt(self, context: dict) -> list[dict]:
        """构建对话 prompt（注入角色设定、章节摘要等）。

        Parameters
        ----------
        context : dict
            可选字段:
            - novel_genre: str
            - chapter_summary: str
            - related_characters: list[dict]  — 每项至少含 name/description
            - related_settings: list[dict]     — 每项至少含 name/description
            - recent_text: str                 — 最近段落，用于衔接上下文
        """
        messages: list[dict] = [
            {"role": "system", "content": self._system_prompt(context)},
        ]

        if context.get("chapter_summary"):
            messages.append(
                {"role": "system", "content": f"当前章节摘要：{context['chapter_summary']}"}
            )

        if context.get("related_characters"):
            chars_desc = self._format_characters(context["related_characters"])
            messages.append({"role": "system", "content": f"相关角色：\n{chars_desc}"})

        if context.get("related_settings"):
            settings_desc = self._format_settings(context["related_settings"])
            messages.append({"role": "system", "content": f"相关设定：\n{settings_desc}"})

        if context.get("recent_text"):
            messages.append(
                {"role": "system", "content": f"最近内容片段：\n{context['recent_text']}"}
            )

        return messages

    def build_continuation_prompt(self, context: dict) -> list[dict]:
        """构建续写 prompt。

        在对话 prompt 基础上追加专门的续写系统指令。
        """
        messages = self.build_chat_prompt(context)

        continuation_tpl = _load_template("continuation")
        if continuation_tpl:
            messages.append({"role": "system", "content": continuation_tpl})
        else:
            messages.append(
                {
                    "role": "system",
                    "content": (
                        "你将以小说作者的身份继续撰写下文内容。\n"
                        "请保持风格一致、情节连贯、节奏适当。\n"
                        "直接输出续写内容，不要添加任何解释或注释。"
                    ),
                }
            )

        if context.get("recent_text"):
            messages.append(
                {"role": "user", "content": f"请续写以下内容：\n\n{context['recent_text']}"}
            )

        return messages

    def build_polish_prompt(self, context: dict) -> list[dict]:
        """构建润色 prompt。"""
        messages = self.build_chat_prompt(context)

        polish_tpl = _load_template("polish")
        if polish_tpl:
            messages.append({"role": "system", "content": polish_tpl})
        else:
            messages.append(
                {
                    "role": "system",
                    "content": (
                        "你是一位专业的文字润色编辑。\n"
                        "请对下方内容进行润色，提升文笔质量，修正语法错误，"
                        "保持原有风格与叙事意图不变。"
                    ),
                }
            )

        if context.get("text_to_polish"):
            messages.append(
                {"role": "user", "content": f"请润色以下内容：\n\n{context['text_to_polish']}"}
            )

        return messages

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _system_prompt(self, context: dict) -> str:
        genre = context.get("novel_genre", "通用")
        base_tpl = _load_template("chat_system")
        if base_tpl:
            return base_tpl.replace("{{genre}}", genre)
        return (
            f"你是一位专业的{genre}小说写作助手。\n"
            "你的任务是帮助作者创作高质量的小说内容。\n"
            "请保持与已有内容一致的风格、语气和叙事视角。\n"
            "回复应自然流畅，避免明显的AI生成痕迹。"
        )

    def _format_characters(self, characters: list[dict]) -> str:
        if not characters:
            return "无"
        parts = []
        for char in characters:
            name = char.get("name", "未知角色")
            desc = char.get("description", "")
            role = char.get("role", "")
            appearance = char.get("appearance", "")
            lines = [f"- {name}"]
            if role:
                lines.append(f"  角色定位：{role}")
            if appearance:
                lines.append(f"  外貌特征：{appearance}")
            if desc:
                lines.append(f"  简介：{desc}")
            parts.append("\n".join(lines))
        return "\n".join(parts)

    def _format_settings(self, settings: list[dict]) -> str:
        if not settings:
            return "无"
        parts = []
        for setting in settings:
            name = setting.get("name", "未知设定")
            desc = setting.get("description", "")
            category = setting.get("category", "")
            lines = [f"- {name}"]
            if category:
                lines.append(f"  类别：{category}")
            if desc:
                lines.append(f"  描述：{desc}")
            parts.append("\n".join(lines))
        return "\n".join(parts)
