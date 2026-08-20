"""Shared helpers for AI action endpoints: LLM invocation, JSON parsing, HTML stripping."""

import json
import logging
import re
from datetime import datetime, timezone

from app.config import settings

logger = logging.getLogger(__name__)

# ── LLM invocation ───────────────────────────────────────────────────────


async def call_llm(
    llm,
    system: str,
    user: str,
    temperature: float = 0.7,
    max_tokens: int = 2048,
    model: str | None = None,
) -> tuple[str, str | None, dict | None, str]:
    """Call the LLM provider (non-streaming).

    Returns (content, error, usage, model). On any failure (missing key,
    upstream error, timeout) returns ("", error_message, None, model)
    instead of raising. usage is ``{"prompt_tokens": n, "completion_tokens":
    n}`` when the provider reports token counts (task #43: Go server bills
    on it). model is the model actually used (provider response value when
    available, else the requested model, else settings.default_model) —
    task #46: the billing ledger records it.
    """
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    resolved_model = model or settings.default_model
    try:
        result = await llm.chat(
            messages=messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
        )
        usage = {
            "prompt_tokens": int(getattr(result, "prompt_tokens", 0) or 0),
            "completion_tokens": int(getattr(result, "completion_tokens", 0) or 0),
        }
        # Prefer the model echoed by the provider response when present.
        actual_model = str(getattr(result, "model", "") or "") or resolved_model
        return result.content or "", None, usage, actual_model
    except Exception as exc:  # noqa: BLE001 - never leak 500 to caller
        logger.warning("LLM call failed: %s", exc)
        return "", str(exc), None, resolved_model


# ── HTML stripping ───────────────────────────────────────────────────────

_TAG_RE = re.compile(r"<[^>]+>")
_ENTITY_MAP = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
}


def strip_html(html: str) -> str:
    """Strip HTML tags and decode common entities, return plain text."""
    if not html:
        return ""
    text = _TAG_RE.sub("", html)
    for entity, ch in _ENTITY_MAP.items():
        text = text.replace(entity, ch)
    return re.sub(r"\s+", " ", text).strip()


# ── Robust JSON parsing ──────────────────────────────────────────────────

_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.DOTALL | re.IGNORECASE)


def _try_loads(text: str):
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None


def extract_json(text: str):
    """Parse JSON from raw LLM output, tolerating markdown fences and prose.

    Returns the parsed object, or None if parsing fails.
    """
    if not text:
        return None
    text = text.strip()

    parsed = _try_loads(text)
    if parsed is not None:
        return parsed

    # Strip markdown code fences: ```json ... ```
    for match in _FENCE_RE.finditer(text):
        parsed = _try_loads(match.group(1).strip())
        if parsed is not None:
            return parsed

    # Fallback: slice between the first and last structural bracket
    for open_ch, close_ch in (("[", "]"), ("{", "}")):
        start = text.find(open_ch)
        end = text.rfind(close_ch)
        if start != -1 and end > start:
            parsed = _try_loads(text[start : end + 1])
            if parsed is not None:
                return parsed

    logger.warning("Failed to parse JSON from LLM output: %.200s", text)
    return None


def as_string_list(value, fallback: list[str] | None = None) -> list[str]:
    """Coerce a parsed JSON value into a list of non-empty strings."""
    fallback = fallback if fallback is not None else []
    if isinstance(value, str):
        return [value.strip()] if value.strip() else fallback
    if not isinstance(value, list):
        return fallback
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]


def clamp_score(value, default: int = 60) -> int:
    """Clamp a value into [0, 100] integer score."""
    try:
        return max(0, min(100, round(float(value))))
    except (TypeError, ValueError):
        return default


def now_iso() -> str:
    """Current UTC time as ISO-8601 string (matches frontend `generatedAt`)."""
    return datetime.now(timezone.utc).isoformat()
