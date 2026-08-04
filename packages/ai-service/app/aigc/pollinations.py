"""Pollinations.ai — free image generation provider."""

import hashlib
import logging
import os
import time
import urllib.parse
from pathlib import Path

import httpx
from PIL import Image

from app.aigc.base import BaseImageProvider, ImageResult

logger = logging.getLogger(__name__)

# Base URL for Pollinations image generation
_POLLINATIONS_BASE = "https://image.pollinations.ai/prompt"

# Thumbnail max dimension
_THUMB_MAX = 256


class PollinationsProvider(BaseImageProvider):
    """Free image generation via Pollinations.ai.

    URL pattern:
        https://image.pollinations.ai/prompt/{url_encoded_prompt}?width={w}&height={h}&seed={seed}
    A simple GET request returns the raw image bytes.
    """

    def __init__(self, storage_root: str | None = None):
        self.storage_root = Path(storage_root or os.path.expanduser("~/.inkbloom"))

    async def generate(
        self,
        prompt: str,
        width: int = 1024,
        height: int = 1024,
        **kwargs,
    ) -> ImageResult:
        novel_id = kwargs.get("novel_id", 0)
        seed = kwargs.get("seed") or int(time.time()) % 100000

        # 1. Build the URL
        encoded_prompt = urllib.parse.quote(prompt, safe="")
        url = (
            f"{_POLLINATIONS_BASE}/{encoded_prompt}"
            f"?width={width}&height={height}&seed={seed}&nologo=true"
        )

        # 2. Ensure output directory exists
        asset_dir = self.storage_root / "novels" / str(novel_id) / "assets"
        asset_dir.mkdir(parents=True, exist_ok=True)

        # 3. Download the image
        file_hash = hashlib.md5(f"{prompt}-{seed}".encode()).hexdigest()[:12]
        filename = f"img_{file_hash}.png"
        file_path = asset_dir / filename

        async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
            resp = await client.get(url)
            resp.raise_for_status()

        file_path.write_bytes(resp.content)
        file_size = file_path.stat().st_size
        logger.info("Downloaded image to %s (%d bytes)", file_path, file_size)

        # 4. Generate thumbnail
        thumb_path = asset_dir / f"thumb_{file_hash}.png"
        try:
            with Image.open(file_path) as img:
                img.thumbnail((_THUMB_MAX, _THUMB_MAX))
                img.save(thumb_path, format="PNG")
            logger.info("Thumbnail saved to %s", thumb_path)
        except Exception as exc:
            logger.warning("Failed to create thumbnail: %s", exc)
            thumb_path = Path("")

        # 5. Build the relative URL path for frontend access
        rel_path = f"/assets/files/novels/{novel_id}/assets/{filename}"
        rel_thumb = (
            f"/assets/files/novels/{novel_id}/assets/thumb_{file_hash}.png"
            if thumb_path.exists()
            else ""
        )

        return ImageResult(
            url=rel_path,
            file_path=str(file_path),
            width=width,
            height=height,
            provider="pollinations",
            thumbnail_path=rel_thumb,
            file_size=file_size,
            metadata={"seed": seed, "source_url": url},
        )

    async def is_available(self) -> bool:
        """Pollinations is always available (free, no API key needed)."""
        return True
