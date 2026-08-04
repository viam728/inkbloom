"""Consistency checker for detecting contradictions in knowledge graph."""

import json
import logging
from typing import Any

from app.llm.base import BaseLLMProvider
from app.config import settings

logger = logging.getLogger(__name__)


class ConsistencyChecker:
    """Check text consistency against existing knowledge graph entities."""

    def __init__(self, provider: BaseLLMProvider) -> None:
        self.provider = provider

    async def check(self, text: str, entities: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Detect consistency issues between the text and existing entities.

        Args:
            text: The new text to check for consistency.
            entities: List of existing entities with their properties.

        Returns:
            A list of issue dicts with keys: description, severity, entity_name.
        """
        if not entities:
            return []

        entity_info = json.dumps(
            [{"name": e["name"], "type": e.get("type", ""), "description": e.get("description", "")} for e in entities],
            ensure_ascii=False,
            indent=2,
        )

        prompt = f"""分析以下文本与已有设定信息之间是否存在矛盾或不一致。

已有设定信息：
{entity_info}

对于每个发现的矛盾，提取：
- description（矛盾描述，简要说明）
- severity（严重程度：error/warning/info 之一）
- entity_name（涉及的实体名称）

如果没有发现矛盾，返回空数组 []。

以 JSON 数组格式返回，示例：
[{{"description": "文本中描述张三为剑客，但已有设定中张三为法师", "severity": "error", "entity_name": "张三"}}]

只返回 JSON 数组，不要添加其他内容。

文本：
{text}"""

        messages = [
            {"role": "system", "content": "你是一个专业的小说一致性检测助手，擅长发现文本中的设定矛盾。请严格按照 JSON 数组格式输出。"},
            {"role": "user", "content": prompt},
        ]

        try:
            result = await self.provider.chat(
                messages=messages,
                model=settings.default_model,
                temperature=0.2,
                max_tokens=4096,
            )

            # Parse JSON from response
            content = result.content.strip()
            if content.startswith("```"):
                content = content.split("\n", 1)[-1]
            if content.endswith("```"):
                content = content.rsplit("```", 1)[0]
            content = content.strip()

            issues = json.loads(content)
            if not isinstance(issues, list):
                logger.warning("Consistency check returned non-list: %s", type(issues))
                return []

            # Validate and normalize issues
            valid_severities = {"error", "warning", "info"}
            normalized = []
            for issue in issues:
                if not isinstance(issue, dict) or "description" not in issue:
                    continue
                severity = issue.get("severity", "warning")
                if severity not in valid_severities:
                    severity = "warning"
                normalized.append({
                    "description": issue["description"],
                    "severity": severity,
                    "entity_name": issue.get("entity_name", ""),
                })

            return normalized

        except json.JSONDecodeError as e:
            logger.error("Failed to parse consistency JSON: %s, content: %s", e, result.content[:200])
            return []
        except Exception as e:
            logger.error("Consistency check failed: %s", e)
            return []
