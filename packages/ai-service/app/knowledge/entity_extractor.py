"""Entity extractor using LLM for knowledge graph construction."""

import json
import logging
from typing import Any

from app.llm.base import BaseLLMProvider
from app.config import settings
from app.knowledge.errors import ExtractionError

logger = logging.getLogger(__name__)


class EntityExtractor:
    """Extract entities (characters, locations, organizations, etc.) from text using LLM."""

    def __init__(self, provider: BaseLLMProvider) -> None:
        self.provider = provider

    async def extract(self, text: str, novel_id: int, chapter_id: int) -> list[dict[str, Any]]:
        """Extract entities from the given text using LLM structured output.

        Args:
            text: The chapter text to extract entities from.
            novel_id: The novel ID for context.
            chapter_id: The chapter ID for reference.

        Returns:
            A list of entity dicts with keys: name, type, description.
        """
        prompt = f"""从以下文本中提取所有实体信息。
对每个实体，提取：
- name（名称）
- type（类型：character/location/organization/skill/item 之一）
- description（简要描述，不超过50字）

以 JSON 数组格式返回，示例：
[{{"name": "张三", "type": "character", "description": "主角，年轻的剑客"}}, {{"name": "青云山", "type": "location", "description": "修仙门派所在地"}}]

只返回 JSON 数组，不要添加其他内容。

文本：
{text}"""

        messages = [
            {"role": "system", "content": "你是一个专业的文本分析助手，擅长从小说文本中提取结构化实体信息。请严格按照 JSON 数组格式输出。"},
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
            # Remove markdown code block markers if present
            if content.startswith("```"):
                content = content.split("\n", 1)[-1]
            if content.endswith("```"):
                content = content.rsplit("```", 1)[0]
            content = content.strip()

            entities = json.loads(content)
            if not isinstance(entities, list):
                logger.warning("Entity extraction returned non-list: %s", type(entities))
                return []

            # Validate and normalize entities
            valid_types = {"character", "location", "organization", "skill", "item"}
            normalized = []
            for entity in entities:
                if not isinstance(entity, dict) or "name" not in entity:
                    continue
                entity_type = entity.get("type", "item")
                if entity_type not in valid_types:
                    entity_type = "item"
                normalized.append({
                    "name": entity["name"],
                    "type": entity_type,
                    "description": entity.get("description", ""),
                })

            return normalized

        except json.JSONDecodeError as e:
            logger.error("Failed to parse entity JSON: %s, content: %s", e, result.content[:200])
            # F3-3: a parse failure is an AI fault, not "no entities" —
            # raise so the endpoint can answer degraded instead of 200 [].
            raise ExtractionError(f"entity extraction: unparseable LLM output: {e}") from e
        except ExtractionError:
            raise
        except Exception as e:
            logger.error("Entity extraction failed: %s", e)
            raise ExtractionError(f"entity extraction failed: {e}") from e
