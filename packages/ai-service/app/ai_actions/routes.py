"""HTTP routes for AI action endpoints (candidates / review / inspiration / ...)."""

import logging
import time

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.ai_actions import prompts
from app.ai_actions.service import (
    as_string_list,
    call_llm,
    clamp_score,
    extract_json,
    now_iso,
    strip_html,
)
from app.llm.base import BaseLLMProvider

logger = logging.getLogger(__name__)

_SEVERITY_LEVELS = {"low", "medium", "high"}
_PLATFORMS = {"wechat", "xiaohongshu", "weibo", "video"}


# ── Request models ───────────────────────────────────────────────────────


class CandidatesRequest(BaseModel):
    action: str
    context: str
    model: str | None = None
    n: int = Field(default=3, ge=1, le=10)


class ReviewRequest(BaseModel):
    chapter_id: int
    text: str


class InspirationRequest(BaseModel):
    category: str
    context: str | None = None


class ExpandOutlineRequest(BaseModel):
    outline_title: str
    summary: str
    memory_context: str | None = None
    target_words: int | None = Field(default=None, ge=1)


class AnalyzeStoryRequest(BaseModel):
    title: str
    chapter_count: int = 0
    total_words: int = 0
    outline_acts: int = 0
    outline_nodes: int = 0
    characters: int = 0


class AnalyzeMediaRequest(BaseModel):
    title: str
    content: str
    platform: str


class GenerateTitlesRequest(BaseModel):
    topic: str
    platform: str
    count: int = Field(default=8, ge=1, le=30)


class AdaptContentRequest(BaseModel):
    content: str
    platform: str


# ── Helpers ──────────────────────────────────────────────────────────────


def _parse_analysis(parsed) -> dict | None:
    """Normalize LLM output into the frontend AnalysisReport shape."""
    if not isinstance(parsed, dict):
        return None

    dimensions = []
    raw_dims = parsed.get("dimensions")
    if isinstance(raw_dims, list):
        for d in raw_dims:
            if not isinstance(d, dict):
                continue
            dimensions.append(
                {
                    "label": str(d.get("label") or d.get("name") or ""),
                    "score": clamp_score(d.get("score"), default=0),
                    "tip": str(d.get("tip") or d.get("comment") or ""),
                }
            )

    return {
        "score": clamp_score(parsed.get("score")),
        "summary": str(parsed.get("summary") or ""),
        "dimensions": dimensions,
        "suggestions": as_string_list(parsed.get("suggestions")),
        "generatedAt": now_iso(),
    }


# ── Router factory ───────────────────────────────────────────────────────


def create_router(llm: BaseLLMProvider) -> APIRouter:
    """Create the AI action router bound to the given LLM provider."""
    router = APIRouter()

    @router.post("/api/ai/candidates")
    async def ai_candidates(request: CandidatesRequest):
        """Generate n candidate texts for a writing action in one LLM call."""
        start = time.perf_counter()
        try:
            user = prompts.candidates_prompt(request.action, request.context, request.n)
            content, err = await call_llm(
                llm, prompts.SYSTEM_JSON, user, temperature=0.8, model=request.model
            )
            if err:
                return {"candidates": [], "error": err}

            parsed = extract_json(content)
            candidates = as_string_list(parsed)
            if not candidates:
                # Fallback: model ignored JSON format, split by lines
                candidates = [
                    line.strip().lstrip("-•·").strip()
                    for line in content.splitlines()
                    if line.strip()
                ]
            return {"candidates": candidates}
        finally:
            logger.info(
                "ai_candidates action=%s took %.2fs",
                request.action,
                time.perf_counter() - start,
            )

    @router.post("/api/ai/review")
    async def ai_review(request: ReviewRequest):
        """Review chapter text and return annotations."""
        start = time.perf_counter()
        try:
            user = prompts.review_prompt(request.chapter_id, request.text)
            content, err = await call_llm(
                llm, prompts.SYSTEM_JSON, user, temperature=0.3, max_tokens=3000
            )
            if err:
                return {"annotations": [], "error": err}

            parsed = extract_json(content)
            annotations = []
            if isinstance(parsed, list):
                for item in parsed:
                    if not isinstance(item, dict):
                        continue
                    quote = str(item.get("quote") or "").strip()
                    comment = str(item.get("comment") or "").strip()
                    if not quote and not comment:
                        continue
                    severity = str(item.get("severity") or "medium").lower()
                    if severity not in _SEVERITY_LEVELS:
                        severity = "medium"
                    annotation = {
                        "quote": quote,
                        "comment": comment,
                        "severity": severity,
                    }
                    suggestion = str(item.get("suggestion") or "").strip()
                    if suggestion:
                        annotation["suggestion"] = suggestion
                    annotations.append(annotation)
            return {"annotations": annotations}
        finally:
            logger.info(
                "ai_review chapter_id=%s took %.2fs",
                request.chapter_id,
                time.perf_counter() - start,
            )

    @router.post("/api/ai/inspiration")
    async def ai_inspiration(request: InspirationRequest):
        """Generate inspiration ideas for a writing category."""
        start = time.perf_counter()
        try:
            user = prompts.inspiration_prompt(request.category, request.context or "")
            content, err = await call_llm(
                llm, prompts.SYSTEM_JSON, user, temperature=0.9
            )
            if err:
                return {"items": [], "error": err}

            parsed = extract_json(content)
            items = as_string_list(parsed)
            if not items:
                items = [
                    line.strip().lstrip("-•·").strip()
                    for line in content.splitlines()
                    if line.strip()
                ]
            return {"items": items}
        finally:
            logger.info(
                "ai_inspiration category=%s took %.2fs",
                request.category,
                time.perf_counter() - start,
            )

    @router.post("/api/ai/expand-outline")
    async def ai_expand_outline(request: ExpandOutlineRequest):
        """Expand an outline node into a full prose draft."""
        start = time.perf_counter()
        try:
            system, user = prompts.expand_outline_prompt(
                request.outline_title,
                request.summary,
                request.memory_context or "",
                request.target_words,
            )
            max_tokens = (
                min(8000, max(2048, request.target_words * 3))
                if request.target_words
                else 4096
            )
            content, err = await call_llm(
                llm, system, user, temperature=0.8, max_tokens=max_tokens
            )
            if err:
                return {"draft": "", "error": err}
            return {"draft": content.strip()}
        finally:
            logger.info(
                "ai_expand_outline title=%s took %.2fs",
                request.outline_title,
                time.perf_counter() - start,
            )

    @router.post("/api/ai/analyze-story")
    async def ai_analyze_story(request: AnalyzeStoryRequest):
        """Analyze a novel's overall state (matches web AnalysisReport shape)."""
        start = time.perf_counter()
        try:
            user = prompts.analyze_story_prompt(
                request.title,
                request.chapter_count,
                request.total_words,
                request.outline_acts,
                request.outline_nodes,
                request.characters,
            )
            content, err = await call_llm(
                llm, prompts.SYSTEM_JSON, user, temperature=0.4, max_tokens=3000
            )
            if err:
                return {"error": err}

            report = _parse_analysis(extract_json(content))
            if report is None:
                logger.warning("ai_analyze_story: unparseable report for %s", request.title)
                return {"error": "failed to parse analysis report"}
            return report
        finally:
            logger.info(
                "ai_analyze_story title=%s took %.2fs",
                request.title,
                time.perf_counter() - start,
            )

    @router.post("/api/ai/analyze-media")
    async def ai_analyze_media(request: AnalyzeMediaRequest):
        """Analyze media content for a platform (matches web AnalysisReport shape)."""
        start = time.perf_counter()
        try:
            plain = strip_html(request.content)
            user = prompts.analyze_media_prompt(request.title, plain, request.platform)
            content, err = await call_llm(
                llm, prompts.SYSTEM_JSON, user, temperature=0.4, max_tokens=3000
            )
            if err:
                return {"error": err}

            report = _parse_analysis(extract_json(content))
            if report is None:
                logger.warning("ai_analyze_media: unparseable report for %s", request.title)
                return {"error": "failed to parse analysis report"}
            return report
        finally:
            logger.info(
                "ai_analyze_media platform=%s took %.2fs",
                request.platform,
                time.perf_counter() - start,
            )

    @router.post("/api/ai/generate-titles")
    async def ai_generate_titles(request: GenerateTitlesRequest):
        """Generate platform-styled titles for a topic."""
        start = time.perf_counter()
        try:
            platform = request.platform if request.platform in _PLATFORMS else "wechat"
            user = prompts.generate_titles_prompt(request.topic, platform, request.count)
            content, err = await call_llm(
                llm, prompts.SYSTEM_JSON, user, temperature=0.9
            )
            if err:
                return {"titles": [], "error": err}

            parsed = extract_json(content)
            titles = as_string_list(parsed)
            if not titles:
                titles = [
                    line.strip().lstrip("-•·").strip()
                    for line in content.splitlines()
                    if line.strip()
                ]
            return {"titles": titles}
        finally:
            logger.info(
                "ai_generate_titles platform=%s took %.2fs",
                request.platform,
                time.perf_counter() - start,
            )

    @router.post("/api/ai/adapt-content")
    async def ai_adapt_content(request: AdaptContentRequest):
        """Adapt content to a platform's style and length limits."""
        start = time.perf_counter()
        try:
            platform = request.platform if request.platform in _PLATFORMS else "wechat"
            plain = strip_html(request.content)
            if not plain:
                return {"adapted": "", "error": "empty content after stripping HTML"}

            system, user = prompts.adapt_content_prompt(plain, platform)
            content, err = await call_llm(
                llm, system, user, temperature=0.7, max_tokens=3000
            )
            if err:
                return {"adapted": "", "error": err}
            return {"adapted": content.strip()}
        finally:
            logger.info(
                "ai_adapt_content platform=%s took %.2fs",
                request.platform,
                time.perf_counter() - start,
            )

    return router
