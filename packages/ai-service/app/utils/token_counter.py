"""Token counting utility using tiktoken."""

from functools import lru_cache

import tiktoken


@lru_cache(maxsize=32)
def _get_encoding(model: str) -> tiktoken.Encoding:
    """Get tiktoken encoding for a model, with caching."""
    try:
        return tiktoken.encoding_for_model(model)
    except KeyError:
        # Fallback for models not directly supported by tiktoken
        return tiktoken.get_encoding("cl100k_base")


def count_tokens(text: str, model: str = "gpt-4o-mini") -> int:
    """Count the number of tokens in the given text for the specified model.

    Args:
        text: The text to count tokens for.
        model: The model name to determine encoding. Defaults to gpt-4o-mini.

    Returns:
        The number of tokens in the text.
    """
    encoding = _get_encoding(model)
    return len(encoding.encode(text))
