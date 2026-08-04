"""OpenAI DALL-E image generation provider."""

import hashlib
import logging
import os
import time
from pathlib import Path

import httpx

from app.aigc.base import BaseImageProvider, ImageResult
from app.config import settings

logger = logging.getLogger(__name__)

_THUMB_MAX = 256


class DallEProvider(BaseImageProvider):
    """OpenAI DALL-E image generation (requires API key)."""

    def __init__(self, storage_root: str | None = None):
        self.storage_root = Path(storage_root or os.path.expanduser("~/.inkbloom"))
        self.api_key = settings.openai_api_key
        self.base_url = settings.openai_base_url.rstrip("/")

    async def generate(
        self,
        prompt: str,
        width: int = 1024,
        height: int = 1024,
        **kwargs,
    ) -> ImageResult:
        novel_id = kwargs.get("novel_id", 0)
        model = kwargs.get("model", "dall-e-3")
        quality = kwargs.get("quality", "standard")

        # Map dimensions to DALL-E size string
        size = self._resolve_size(width, height)

        # Call OpenAI images API
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": model,
            "prompt": prompt,
            "n": 1,
            "size": size,
            "quality": quality,
            "response_format": "url",
        }

        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                f"{self.base_url}/images/generations",
                json=payload,
                headers=headers,
            )
            resp.raise_for_status()
            data = resp.json()

        image_url = data["data"][0]["url"]

        # Download the image
        asset_dir = self.storage_root / "novels" / str(novel_id) / "assets"
        asset_dir.mkdir(parents=True, exist_ok=True)

        file_hash = hashlib.md5(f"{prompt}-{time.time()}".encode()).hexdigest()[:12]
        filename = f"dalle_{file_hash}.png"
        file_path = asset_dir / filename

        async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
            img_resp = await client.get(image_url)
            img_resp.raise_for_status()

        file_path.write_bytes(img_resp.content)
        file_size = file_path.stat().st_size

        # Thumbnail
        thumb_path = asset_dir / f"thumb_dalle_{file_hash}.png"
        try:
            from PIL import Image

            with Image.open(file_path) as img:
                img.thumbnail((_THUMB_MAX, _THUMB_MAX))
                img.save(thumb_path, format="PNG")
        except Exception as exc:
            logger.warning("Failed to create thumbnail: %s", exc)
            thumb_path = Path("")

        rel_path = f"/assets/files/novels/{novel_id}/assets/{filename}"
        rel_thumb = (
            f"/assets/files/novels/{novel_id}/assets/thumb_dalle_{file_hash}.png"
            if thumb_path.exists()
            else ""
        )

        return ImageResult(
            url=rel_path,
            file_path=str(file_path),
            width=width,
            height=height,
            provider="dalle",
            thumbnail_path=rel_thumb,
            file_size=file_size,
            metadata={"model": model, "quality": quality, "source_url": image_url},
        )

    async def is_available(self) -> bool:
        """Available only when an OpenAI API key is configured."""
        return bool(self.api_key)

    @staticmethod
    def _resolve_size(w: int, h: int) -> str:
        """Map pixel dimensions to the closest DALL-E size string."""
        if w == h:
            return "1024x1024"
        if w > h:
            return "1792x1024"
        return "1024x1792"
