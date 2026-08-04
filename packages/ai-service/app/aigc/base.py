"""Abstract base class for image generation providers."""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass
class ImageResult:
    """Result of an image generation operation."""

    url: str
    file_path: str
    width: int
    height: int
    provider: str
    thumbnail_path: str = ""
    file_size: int = 0
    metadata: dict = field(default_factory=dict)


class BaseImageProvider(ABC):
    """Abstract base class that all image providers must implement."""

    @abstractmethod
    async def generate(
        self,
        prompt: str,
        width: int = 1024,
        height: int = 1024,
        **kwargs,
    ) -> ImageResult:
        """Generate an image from a text prompt.

        Args:
            prompt: Text description of the image to generate.
            width: Desired image width in pixels.
            height: Desired image height in pixels.
            **kwargs: Provider-specific options (novel_id, seed, etc.).

        Returns:
            ImageResult with file paths and metadata.
        """
        ...

    @abstractmethod
    async def is_available(self) -> bool:
        """Check whether this provider is currently available and configured."""
        ...
