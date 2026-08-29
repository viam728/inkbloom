"""Foreshadow extractor using LLM (business plan v3 E2, construction plan A11).

Two directions, deliberately kept as separate calls:

- ``detect_plants``   finds setups an author buried in a chapter ("伏笔").
- ``detect_resolutions`` decides which *already registered* threads a chapter
  pays off.

They are separate because their failure modes are asymmetric: a missed setup
is merely a lost convenience, while a false "resolved" mark silently removes
a thread from the author's to-do list. Keeping them apart lets the caller
apply different confidence thresholds — planting always asks the author,
resolving is the narrow case allowed to write automatically.
"""

import json
import logging
from typing import Any

from app.llm.base import BaseLLMProvider
from app.config import settings

logger = logging.getLogger(__name__)


def _strip_code_fence(content: str) -> str:
    """Remove markdown ``` fences that LLMs like to wrap JSON in."""
    content = content.strip()
    if content.startswith("```"):
        content = content.split("\n", 1)[-1]
    if content.endswith("```"):
        content = content.rsplit("```", 1)[0]
    return content.strip()


class ForeshadowExtractor:
    """Detect foreshadow planting and payoff in chapter text using LLM."""

    def __init__(self, provider: BaseLLMProvider) -> None:
        self.provider = provider

    async def detect_plants(
        self, text: str, novel_id: int, chapter_id: int
    ) -> list[dict[str, Any]]:
        """Find setups planted in this chapter.

        Returns a list of candidate dicts with keys: description, anchor,
        expect_chapter, confidence, reason. Candidates are NOT persisted —
        the author confirms each one.
        """
        if not text or not text.strip():
            return []

        prompt = f"""分析以下小说章节，找出作者**埋下的伏笔**（即后续应当回收的悬念、细节或铺垫）。

判断标准（满足其一即可）：
1. 刻意强调却未解释的细节（一柄缠布的刀、一封没拆的信）
2. 人物说出的、读者尚不知真假的断言
3. 与当前情节无关、但被特意描写的物件或场景
4. 留下的疑问或未完成的动作

**不要**把以下当成伏笔：
- 普通的环境描写与人物外貌
- 本章之内已经解释清楚的内容
- 纯粹的情绪抒发

对每条伏笔，返回：
- description（一句话概括这条伏笔，不超过 40 字）
- anchor（原文中的关键句片段，原样摘录，不超过 30 字，用于日后跳转定位）
- expect_chapter（建议回收的章节序号，整数；无法确定则为 null）
- confidence（0 到 1 之间的小数，表示你有多确信这是伏笔）
- reason（不超过 30 字，说明为什么认为这是伏笔）

以 JSON 数组返回，示例：
[{{"description": "来人腰间的刀缠着布条，来历不明", "anchor": "他盯着来人腰间的刀", "expect_chapter": 8, "confidence": 0.82, "reason": "刻意强调却未解释"}}]

只返回 JSON 数组，不要添加其他内容。若确实没有伏笔，返回空数组 []。

章节正文：
{text}"""

        messages = [
            {
                "role": "system",
                "content": "你是一位资深小说编辑，擅长识别叙事中的伏笔与铺垫。请严格按 JSON 数组输出，宁可漏报也不要把普通描写当成伏笔。",
            },
            {"role": "user", "content": prompt},
        ]

        # NOTE: errors are deliberately NOT swallowed here.
        #
        # An upstream failure (bad API key, timeout) and a genuine "no setups
        # found" both used to return [], which made the caller render an
        # outage as "nothing found". Letting the exception reach the endpoint
        # lets it answer with degraded=true instead.
        result = await self.provider.chat(
            messages=messages,
            model=settings.default_model,
            temperature=0.3,
            max_tokens=4096,
        )
        candidates = json.loads(_strip_code_fence(result.content))
        if not isinstance(candidates, list):
            raise ValueError(f"expected a JSON list, got {type(candidates).__name__}")
        return [c for c in candidates if self._valid_candidate(c)]

    async def detect_resolutions(
        self, text: str, threads: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Decide which registered threads this chapter pays off.

        Args:
            text: Chapter body.
            threads: Open threads, each with ``id``, ``description`` and
                optionally ``plant_anchor``.

        Returns:
            A list of ``{"id": ..., "anchor": ..., "confidence": ...}`` for
            threads judged to be paid off. Only these ids are written back.
        """
        if not text or not text.strip() or not threads:
            return []

        thread_lines = "\n".join(
            "- id={id}: {desc}{anchor}".format(
                id=t.get("id"),
                desc=t.get("description", ""),
                anchor=f"（埋设原文：{t['plant_anchor']}）" if t.get("plant_anchor") else "",
            )
            for t in threads
        )

        prompt = f"""以下是该小说中**尚未回收**的伏笔清单：

{thread_lines}

请判断本章正文是否回收（呼应、揭示、兑现）了其中某些伏笔。

回收的判定标准（必须明确满足）：
1. 伏笔所指的悬念被明确揭示或解释
2. 埋设的物件/人物在情节中真正发挥作用
3. 读者此前不知道的信息被点明

**不要**判定为回收的情况：
- 仅仅再次提到该物件或人物，但没有推进
- 只是语气或氛围上的呼应
- 你凭猜测认为"可能是"，但没有明确文本依据

对确凿回收的伏笔，返回：
- id（必须与清单中的 id 一致）
- anchor（本章中体现回收的关键句片段，不超过 30 字）
- confidence（0 到 1 之间的小数，**低于 0.7 就不要返回**）

以 JSON 数组返回，示例：[{{"id": 12, "anchor": "刀出鞘时，布条散落", "confidence": 0.91}}]

只返回 JSON 数组。若本章没有回收任何伏笔，返回 []。

本章正文：
{text}"""

        messages = [
            {
                "role": "system",
                "content": "你是一位严谨的小说编辑，负责核实伏笔是否被回收。只有文本证据确凿时才判定回收；不确定就返回空数组。请严格按 JSON 数组输出。",
            },
            {"role": "user", "content": prompt},
        ]

        # See the note in detect_plants: failures propagate so the endpoint
        # can mark the response degraded rather than reporting "nothing paid
        # off" during an outage.
        result = await self.provider.chat(
            messages=messages,
            model=settings.default_model,
            temperature=0.2,
            max_tokens=2048,
        )
        hits = json.loads(_strip_code_fence(result.content))
        if not isinstance(hits, list):
            raise ValueError(f"expected a JSON list, got {type(hits).__name__}")
        return [h for h in hits if self._valid_hit(h, threads)]

    @staticmethod
    def _valid_candidate(c: Any) -> bool:
        """Keep only well-formed candidates with a usable description."""
        if not isinstance(c, dict):
            return False
        desc = c.get("description")
        if not isinstance(desc, str) or not desc.strip():
            return False
        try:
            conf = float(c.get("confidence", 0))
        except (TypeError, ValueError):
            return False
        return conf >= 0.5

    @staticmethod
    def _valid_hit(h: Any, threads: list[dict[str, Any]]) -> bool:
        """Keep only high-confidence hits whose id is in the known thread set.

        The id guard matters: an LLM can hallucinate an id, and writing an
        unknown id back would mark the wrong thread resolved.
        """
        if not isinstance(h, dict):
            return False
        known = {t.get("id") for t in threads}
        try:
            tid = int(h.get("id"))
        except (TypeError, ValueError):
            return False
        if tid not in known:
            logger.warning("Foreshadow resolve returned unknown id: %s", tid)
            return False
        try:
            conf = float(h.get("confidence", 0))
        except (TypeError, ValueError):
            return False
        return conf >= 0.7
