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
        # INKBLOOM_STORAGE_ROOT overrides the default ~/.inkbloom so the Go
        # server and the ai-service can share one storage root (task #57).
        self.storage_root = Path(
            storage_root
            or os.environ.get("INKBLOOM_STORAGE_ROOT")
            or os.path.expanduser("~/.inkbloom")
        )
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
        scope = kwargs.get("scope") or "novel"
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

        # Download the image. Scope routes the directory (task #64);
        # every scope lives under the Go StaticFS root
        # ({storage_root}/novels) so files stay servable via
        # /assets/files/* (same convention as the gallery, task #57).
        if scope == "media":
            asset_dir = self.storage_root / "novels" / "_media" / "aigc"
            url_prefix = "/assets/files/_media/aigc"
        elif scope == "memo":
            asset_dir = self.storage_root / "novels" / "_memo" / "aigc"
            url_prefix = "/assets/files/_memo/aigc"
        else:  # novel
            asset_dir = self.storage_root / "novels" / str(novel_id) / "assets"
            url_prefix = f"/assets/files/{novel_id}/assets"
        asset_dir.mkdir(parents=True, exist_ok=True)

        # _aigc suffix marks AI-generated files (task #64)
        file_hash = hashlib.md5(f"{prompt}-{time.time()}".encode()).hexdigest()[:12]
        filename = f"dalle_{file_hash}_aigc.png"
        file_path = asset_dir / filename

        async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
            img_resp = await client.get(image_url)
            img_resp.raise_for_status()

        file_path.write_bytes(img_resp.content)
        file_size = file_path.stat().st_size

        # Thumbnail
        thumb_path = asset_dir / f"thumb_dalle_{file_hash}_aigc.png"
        try:
            from PIL import Image

            with Image.open(file_path) as img:
                img.thumbnail((_THUMB_MAX, _THUMB_MAX))
                img.save(thumb_path, format="PNG")
        except Exception as exc:
            logger.warning("Failed to create thumbnail: %s", exc)
            thumb_path = Path("")

        # The Go StaticFS root is already {storage_root}/novels, so no
        # "novels/" segment belongs in the URL (task #57 fix).
        rel_path = f"{url_prefix}/{filename}"
        rel_thumb = (
            f"{url_prefix}/thumb_dalle_{file_hash}_aigc.png"
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
