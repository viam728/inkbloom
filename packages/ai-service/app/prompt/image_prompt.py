"""Image prompt builder — converts Chinese novel context into English image generation prompts."""

import json
import logging
from pathlib import Path

from app.llm.base import BaseLLMProvider

logger = logging.getLogger(__name__)

_TEMPLATES_DIR = Path(__file__).parent / "templates"


def _load_template(name: str) -> str:
    path = _TEMPLATES_DIR / f"{name}.txt"
    if path.exists():
        return path.read_text(encoding="utf-8").strip()
    return ""


# Style modifier presets
STYLE_MODIFIERS: dict[str, str] = {
    "realistic": "photorealistic, highly detailed, 8k resolution, cinematic lighting, sharp focus",
    "anime": "anime style, vibrant colors, detailed illustration, cel shading, expressive eyes",
    "watercolor": "watercolor painting, soft edges, artistic, flowing pigments, delicate brushstrokes",
    "oil_painting": "oil painting, rich textures, classical art style, bold brushstrokes, warm palette",
    "ink_wash": "Chinese ink wash painting, minimalist, traditional, elegant brushstrokes, rice paper",
    "digital_art": "digital art, concept art, trending on ArtStation, intricate details, vivid colors",
}

# Default negative prompt applied to all generations
_BASE_NEGATIVE = (
    "blurry, low quality, deformed, distorted, ugly, bad anatomy, "
    "bad proportions, duplicate, morbid, mutilated, poorly drawn face, "
    "mutation, extra limb, watermark, text, signature"
)


class ImagePromptBuilder:
    """将小说上下文转换为英文图片生成 Prompt。

    使用 LLM 将中文小说段落分析、翻译并转换为适合 AI 图片生成的英文 prompt。
    """

    def __init__(self, provider: BaseLLMProvider) -> None:
        self.provider = provider

    async def generate_image_prompt(
        self,
        context_text: str,
        genre: str = "",
        style: str = "realistic",
    ) -> dict:
        """生成英文图片 prompt 和 negative prompt。

        Parameters
        ----------
        context_text : str
            中文小说上下文段落。
        genre : str
            小说类型（如 玄幻、都市、武侠）。
        style : str
            图片风格偏好，对应 STYLE_MODIFIERS 的 key。

        Returns
        -------
        dict
            {"prompt": str, "negative_prompt": str}
        """
        system_prompt = _load_template("image_prompt")
        if not system_prompt:
            system_prompt = (
                "You are an expert at converting Chinese novel descriptions into "
                "English image generation prompts.\n"
                "Given a passage from a Chinese novel, create a detailed English "
                "prompt for AI image generation.\n"
                "Focus on: scene composition, character appearance, lighting, "
                "atmosphere, art style.\n"
                "Output strictly as JSON with keys 'prompt' and 'negative_prompt'."
            )

        user_prompt = (
            f"Convert this Chinese novel passage into an image generation prompt:\n\n"
            f"Genre: {genre}\n"
            f"Style preference: {style}\n\n"
            f"Passage:\n{context_text}\n\n"
            "Create a vivid, detailed English prompt for generating an illustration "
            "of this scene. Return JSON with 'prompt' and 'negative_prompt' keys."
        )

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]

        try:
            response = await self.provider.chat(
                messages=messages,
                model=None,
                temperature=0.7,
                max_tokens=1024,
            )
            result = self._parse_response(response.content, style)
        except Exception as exc:
            logger.warning("LLM call failed, falling back to rule-based prompt: %s", exc)
            result = self._fallback_prompt(context_text, style)

        # Append style modifiers
        style_mod = STYLE_MODIFIERS.get(style, STYLE_MODIFIERS["realistic"])
        result["prompt"] = f"{result['prompt']}, {style_mod}"

        # Ensure negative prompt always has the base
        if _BASE_NEGATIVE not in result.get("negative_prompt", ""):
            neg = result.get("negative_prompt", "")
            result["negative_prompt"] = f"{neg}, {_BASE_NEGATIVE}" if neg else _BASE_NEGATIVE

        return result

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _parse_response(self, content: str, style: str) -> dict:
        """Parse the LLM JSON response, with robustness for code fences etc."""
        text = content.strip()
        # Strip Markdown code fences if present
        if text.startswith("```"):
            lines = text.split("\n")
            # Remove first and last lines
            lines = [l for l in lines[1:] if not l.strip().startswith("```")]
            text = "\n".join(lines).strip()

        try:
            data = json.loads(text)
            prompt = data.get("prompt", "")
            negative = data.get("negative_prompt", "")
            return {"prompt": prompt, "negative_prompt": negative}
        except json.JSONDecodeError:
            # If we can't parse, treat the entire content as the prompt
            return {"prompt": text, "negative_prompt": _BASE_NEGATIVE}

    def _fallback_prompt(self, context_text: str, style: str) -> dict:
        """Simple rule-based fallback when LLM is unavailable."""
        # Take first 200 chars as a rough scene description
        snippet = context_text[:200].replace("\n", " ").strip()
        return {
            "prompt": f"scene from a Chinese novel: {snippet}",
            "negative_prompt": _BASE_NEGATIVE,
        }
