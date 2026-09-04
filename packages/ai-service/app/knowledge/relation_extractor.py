"""Relation extractor using LLM for knowledge graph construction."""

import json
import logging
from typing import Any

from app.llm.base import BaseLLMProvider
from app.config import settings
from app.knowledge.errors import ExtractionError

logger = logging.getLogger(__name__)


class RelationExtractor:
    """Extract relationships between entities from text using LLM."""

    def __init__(self, provider: BaseLLMProvider) -> None:
        self.provider = provider

    async def extract(self, text: str, entities: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Extract relationships between entities from the given text.

        Args:
            text: The chapter text to extract relations from.
            entities: List of already extracted entities with name/type.

        Returns:
            A list of relation dicts with keys: source_name, target_name, relation_type, description.
        """
        if not entities or len(entities) < 2:
            return []

        entity_list = ", ".join([f"{e['name']}({e.get('type', 'unknown')})" for e in entities])

        prompt = f"""基于以下已知实体列表，从文本中提取实体之间的关系。

已知实体：
{entity_list}

对每段关系，提取：
- source_name（源实体名称，必须是已知实体之一）
- target_name（目标实体名称，必须是已知实体之一）
- relation_type（关系类型，如：friend/enemy/mentor/student/located_in/member_of/owns/loves/hates 等）
- description（关系简要描述，不超过30字）

以 JSON 数组格式返回，示例：
[{{"source_name": "张三", "target_name": "李四", "relation_type": "friend", "description": "同门师兄弟"}}]

只返回 JSON 数组，不要添加其他内容。

文本：
{text}"""

        messages = [
            {"role": "system", "content": "你是一个专业的文本分析助手，擅长从小说文本中提取实体间的关系。请严格按照 JSON 数组格式输出。"},
            {"role": "user", "content": prompt},
        ]

        try:
            result = await self.provider.chat(
                messages=messages,
                model=settings.default_model,
                temperature=0.3,
                max_tokens=4096,
            )

            # Parse JSON from response
            content = result.content.strip()
            if content.startswith("```"):
                content = content.split("\n", 1)[-1]
            if content.endswith("```"):
                content = content.rsplit("```", 1)[0]
            content = content.strip()

            relations = json.loads(content)
            if not isinstance(relations, list):
                logger.warning("Relation extraction returned non-list: %s", type(relations))
                return []

            # Validate relations - ensure source/target exist in entities
            entity_names = {e["name"] for e in entities}
            normalized = []
            for rel in relations:
                if not isinstance(rel, dict):
                    continue
                source = rel.get("source_name", "")
                target = rel.get("target_name", "")
                if source not in entity_names or target not in entity_names:
                    continue
                normalized.append({
                    "source_name": source,
                    "target_name": target,
                    "relation_type": rel.get("relation_type", "related"),
                    "description": rel.get("description", ""),
                })

            return normalized

        except json.JSONDecodeError as e:
            logger.error("Failed to parse relation JSON: %s, content: %s", e, result.content[:200])
            raise ExtractionError(f"relation extraction: unparseable LLM output: {e}") from e
        except ExtractionError:
            raise
        except Exception as e:
            logger.error("Relation extraction failed: %s", e)
            raise ExtractionError(f"relation extraction failed: {e}") from e
