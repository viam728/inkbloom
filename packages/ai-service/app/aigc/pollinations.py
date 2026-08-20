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
        # INKBLOOM_STORAGE_ROOT overrides the default ~/.inkbloom so the Go
        # server and the ai-service can share one storage root (task #57).
        self.storage_root = Path(
            storage_root
            or os.environ.get("INKBLOOM_STORAGE_ROOT")
            or os.path.expanduser("~/.inkbloom")
        )

    async def generate(
        self,
        prompt: str,
        width: int = 1024,
        height: int = 1024,
        **kwargs,
    ) -> ImageResult:
        novel_id = kwargs.get("novel_id", 0)
        scope = kwargs.get("scope") or "novel"
        seed = kwargs.get("seed") or int(time.time()) % 100000

        # 1. Build the URL
        encoded_prompt = urllib.parse.quote(prompt, safe="")
        url = (
            f"{_POLLINATIONS_BASE}/{encoded_prompt}"
            f"?width={width}&height={height}&seed={seed}&nologo=true"
        )

        # 2. Ensure output directory exists. Scope routes the directory
        # (task #64); every scope lives under the Go StaticFS root
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

        # 3. Download the image (_aigc suffix marks AI-generated files,
        # task #64)
        file_hash = hashlib.md5(f"{prompt}-{seed}".encode()).hexdigest()[:12]
        filename = f"img_{file_hash}_aigc.png"
        file_path = asset_dir / filename

        async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
            resp = await client.get(url)
            resp.raise_for_status()

        file_path.write_bytes(resp.content)
        file_size = file_path.stat().st_size
        logger.info("Downloaded image to %s (%d bytes)", file_path, file_size)

        # 4. Generate thumbnail
        thumb_path = asset_dir / f"thumb_{file_hash}_aigc.png"
        try:
            with Image.open(file_path) as img:
                img.thumbnail((_THUMB_MAX, _THUMB_MAX))
                img.save(thumb_path, format="PNG")
            logger.info("Thumbnail saved to %s", thumb_path)
        except Exception as exc:
            logger.warning("Failed to create thumbnail: %s", exc)
            thumb_path = Path("")

        # 5. Build the relative URL path for frontend access. The Go
        # StaticFS root is already {storage_root}/novels, so no "novels/"
        # segment belongs in the URL (task #57 fix).
        rel_path = f"{url_prefix}/{filename}"
        rel_thumb = (
            f"{url_prefix}/thumb_{file_hash}_aigc.png"
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
