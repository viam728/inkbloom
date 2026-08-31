"""InkBloom AI Service entry point: FastAPI + gRPC server."""

import asyncio
import json
import logging
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from grpc import aio as grpc_aio
from prometheus_fastapi_instrumentator import Instrumentator
from pydantic import BaseModel

from app.config import settings
from app.grpc_server.ai_servicer import AIServiceServicer
from app.grpc_server.generated import ai_service_pb2_grpc
from app.knowledge.entity_extractor import EntityExtractor
from app.knowledge.relation_extractor import RelationExtractor
from app.knowledge.consistency_checker import ConsistencyChecker
from app.knowledge.foreshadow_extractor import ForeshadowExtractor
from app.llm.openai_provider import OpenAIProvider
from app.ai_actions.routes import create_router as create_ai_actions_router
from app.agents.routes import create_agent_router
from app.agents.team.routes import create_team_router
from app.aigc.pollinations import PollinationsProvider
from app.aigc.dalle import DallEProvider
from app.prompt.builder import PromptBuilder
from app.prompt.image_prompt import ImagePromptBuilder

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def create_grpc_server() -> grpc_aio.Server:
    """Create and configure the gRPC server."""
    server = grpc_aio.server()
    servicer = AIServiceServicer()
    ai_service_pb2_grpc.add_AIServiceServicer_to_server(servicer, server)
    server.add_insecure_port(f"[::]:{settings.grpc_port}")
    return server


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage gRPC server lifecycle alongside FastAPI."""
    grpc_server = create_grpc_server()
    await grpc_server.start()
    logger.info("gRPC server started on port %d", settings.grpc_port)

    yield

    logger.info("Shutting down gRPC server...")
    await grpc_server.stop(grace=5)
    logger.info("gRPC server stopped")


app = FastAPI(title="InkBloom AI Service", lifespan=lifespan)

# Prometheus metrics for the AI service (tech plan v2 §8.1).
Instrumentator().instrument(app).expose(app, endpoint="/metrics", include_in_schema=False)


# ── HTTP request / response models ──────────────────────────────────────
class ChatMessageHTTP(BaseModel):
    role: str
    content: str


class ChatHTTPRequest(BaseModel):
    messages: list[ChatMessageHTTP]
    model: str | None = None
    temperature: float = 0.7
    max_tokens: int = 2048


# ── Shared LLM provider for HTTP endpoints ──────────────────────────────
_llm = OpenAIProvider()
_entity_extractor = EntityExtractor(_llm)
_relation_extractor = RelationExtractor(_llm)
_consistency_checker = ConsistencyChecker(_llm)
# E2 foreshadow tracking (business plan v3, plan A11)
_foreshadow_extractor = ForeshadowExtractor(_llm)
_prompt_builder = PromptBuilder()
_image_prompt_builder = ImagePromptBuilder(_llm)


def _sse_stream(messages, model, temperature, max_tokens):
    """Shared SSE generator (tech plan v2 §6.3).

    Emits content chunks as `data: {"content": ...}` lines, then a terminal
    usage meta event `data: {"usage": {...}}` right before `[DONE]` so the
    Go proxy can settle token billing against the real upstream usage.
    """

    async def generate():
        usage: dict | None = None
        try:
            async for chunk in _llm.stream(
                messages=messages,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
            ):
                # Terminal usage chunk (finish_reason="usage"): capture and
                # emit as the billing meta event, not as content.
                if chunk.finish_reason == "usage":
                    usage = {
                        "prompt_tokens": chunk.prompt_tokens,
                        "completion_tokens": chunk.completion_tokens,
                    }
                    continue
                data = json.dumps({"content": chunk.content})
                yield f"data: {data}\n\n"
            if usage is not None:
                yield f"data: {json.dumps({'usage': usage})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as exc:
            err = json.dumps({"content": f"[Error] {exc}"})
            yield f"data: {err}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")

# ── AI action endpoints (candidates / review / analysis / media) ────────
app.include_router(create_ai_actions_router(_llm))

# ── Agent scene generation endpoint (character / setting / summary / …) ─
app.include_router(create_agent_router(_llm))

# ── Agent team collaboration endpoint (task routing / pipeline) ─────────
app.include_router(create_team_router())


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok"}


@app.post("/api/chat/stream")
async def chat_stream(request: ChatHTTPRequest):
    """Stream chat completion chunks via SSE."""
    messages = [{"role": m.role, "content": m.content} for m in request.messages]
    model = request.model or settings.default_model
    return _sse_stream(messages, model, request.temperature, request.max_tokens)


@app.post("/api/chat/complete")
async def chat_complete(request: ChatHTTPRequest):
    """Return a complete chat response (non-streaming)."""
    messages = [{"role": m.role, "content": m.content} for m in request.messages]
    model = request.model or settings.default_model

    try:
        result = await _llm.chat(
            messages=messages,
            model=model,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
        )
        # task #43: surface token usage so the Go server can bill it.
        return {
            "content": result.content,
            "usage": {
                "prompt_tokens": int(getattr(result, "prompt_tokens", 0) or 0),
                "completion_tokens": int(getattr(result, "completion_tokens", 0) or 0),
            },
        }
    except Exception as exc:
        return {"content": f"[Error] {exc}"}


# ── Inline & Rewrite endpoints ───────────────────────────────────────────
class InlineRequest(BaseModel):
    messages: list[ChatMessageHTTP]
    model: str | None = None
    temperature: float = 0.7
    max_tokens: int = 2048


class RewriteRequest(BaseModel):
    messages: list[ChatMessageHTTP]
    model: str | None = None
    temperature: float = 0.7
    max_tokens: int = 2048


# ── Agent tool-calling endpoint (conversational creation Agent) ─────────
class AgentToolHTTP(BaseModel):
    type: str = "function"
    function: dict


class AgentMessageHTTP(BaseModel):
    """OpenAI-style message for the Agent loop: role/content plus optional
    tool_calls (assistant), tool_call_id (tool), and reasoning_content
    (DeepSeek thinking mode must be echoed back verbatim)."""

    role: str
    content: str | None = None
    tool_calls: list[dict] | None = None
    tool_call_id: str | None = None
    reasoning_content: str | None = None


class AgentChatHTTPRequest(BaseModel):
    messages: list[AgentMessageHTTP]
    tools: list[AgentToolHTTP] = []
    model: str | None = None
    temperature: float = 0.7
    max_tokens: int = 2048


@app.post("/api/agent/chat")
async def agent_chat(request: AgentChatHTTPRequest):
    """One step of the Agent loop: LLM decides to call a tool or answer.

    Returns {content, tool_calls, usage}. The Go server executes any
    tool_call, appends the result as a tool message, and calls again until
    the model returns final content.
    """
    messages = [
        {k: v for k, v in m.model_dump().items() if v is not None}
        for m in request.messages
    ]
    tools = [t.model_dump() for t in request.tools]
    model = request.model or settings.default_model
    try:
        result = await _llm.chat_with_tools(
            messages=messages,
            tools=tools,
            model=model,
            temperature=request.temperature,
            max_tokens=request.max_tokens,
        )
        return {
            "content": result.get("content", ""),
            "reasoning_content": result.get("reasoning_content", ""),
            "tool_calls": result.get("tool_calls", []),
            "usage": {
                "prompt_tokens": result.get("prompt_tokens", 0),
                "completion_tokens": result.get("completion_tokens", 0),
            },
        }
    except Exception as exc:  # noqa: BLE001
        logger.warning("agent_chat failed: %s", exc)
        return {"content": f"[Error] {exc}", "tool_calls": []}


@app.post("/api/chat/inline")
async def inline_completion(request: InlineRequest):
    """Inline completion - SSE streaming."""
    messages = [{"role": m.role, "content": m.content} for m in request.messages]
    model = request.model or settings.default_model
    return _sse_stream(messages, model, request.temperature, request.max_tokens)


@app.post("/api/chat/rewrite")
async def rewrite_text(request: RewriteRequest):
    """Text rewrite (polish/expand/condense/humanize) - SSE streaming."""
    messages = [{"role": m.role, "content": m.content} for m in request.messages]
    model = request.model or settings.default_model
    return _sse_stream(messages, model, request.temperature, request.max_tokens)


# ── Knowledge HTTP endpoints ─────────────────────────────────────────────
class ExtractHTTPRequest(BaseModel):
    text: str
    novel_id: int
    chapter_id: int


class ConsistencyHTTPRequest(BaseModel):
    text: str
    novel_id: int
    entities: list[dict]


class ForeshadowDetectHTTPRequest(BaseModel):
    """Request body for detecting foreshadow planted in one chapter."""
    text: str
    novel_id: int
    chapter_id: int


class ForeshadowResolveHTTPRequest(BaseModel):
    """Request body for checking which open threads a chapter pays off."""
    text: str
    novel_id: int
    chapter_id: int
    threads: list[dict] = []


@app.post("/api/knowledge/extract")
async def extract_knowledge(request: ExtractHTTPRequest):
    """Extract entities and relations from text."""
    try:
        entities = await _entity_extractor.extract(
            text=request.text,
            novel_id=request.novel_id,
            chapter_id=request.chapter_id,
        )
        relations = await _relation_extractor.extract(
            text=request.text,
            entities=entities,
        )
        return {"entities": entities, "relations": relations}
    except Exception as exc:
        return {"entities": [], "relations": [], "error": str(exc)}


@app.post("/api/knowledge/check")
async def check_consistency(request: ConsistencyHTTPRequest):
    """Check text consistency against existing entities."""
    try:
        issues = await _consistency_checker.check(
            text=request.text,
            entities=request.entities,
        )
        return {"issues": issues}
    except Exception as exc:
        return {"issues": [], "error": str(exc)}


@app.post("/api/knowledge/foreshadows/detect")
async def detect_foreshadow_plants(request: ForeshadowDetectHTTPRequest):
    """Find candidate setups planted in a chapter.

    Returns candidates for author confirmation; nothing is persisted here.
    """
    try:
        candidates = await _foreshadow_extractor.detect_plants(
            text=request.text,
            novel_id=request.novel_id,
            chapter_id=request.chapter_id,
        )
        return {"candidates": candidates}
    except Exception as exc:
        # degraded=true (not an HTTP error) so the caller can tell "AI is
        # down" apart from "this chapter genuinely has no setups". Without it
        # an outage silently renders as an empty list, which reads to the
        # author as "nothing found".
        logger.warning("Foreshadow detect endpoint failed: %s", exc)
        return {"candidates": [], "degraded": True, "error": str(exc)}


@app.post("/api/knowledge/foreshadows/resolve")
async def detect_foreshadow_resolutions(request: ForeshadowResolveHTTPRequest):
    """Decide which open threads this chapter pays off.

    Only high-confidence hits whose id appears in the supplied threads are
    returned, so the caller can safely write them back.
    """
    try:
        resolved = await _foreshadow_extractor.detect_resolutions(
            text=request.text,
            threads=request.threads,
        )
        return {"resolved": resolved}
    except Exception as exc:
        logger.warning("Foreshadow resolve endpoint failed: %s", exc)
        return {"resolved": [], "degraded": True, "error": str(exc)}


# ── Prompt engineering endpoints ─────────────────────────────────────────
class ImagePromptHTTPRequest(BaseModel):
    context_text: str
    novel_genre: str = ""
    style: str = "realistic"


class PromptBuildRequest(BaseModel):
    context: dict = {}
    type: str = "chat"  # chat | continuation | polish


@app.post("/api/prompt/image")
async def generate_image_prompt(request: ImagePromptHTTPRequest):
    """根据上下文生成英文图片 prompt。"""
    try:
        result = await _image_prompt_builder.generate_image_prompt(
            context_text=request.context_text,
            genre=request.novel_genre,
            style=request.style,
        )
        return result
    except Exception as exc:
        logger.exception("Image prompt generation failed")
        return {"prompt": "", "negative_prompt": "", "error": str(exc)}


@app.post("/api/prompt/build")
async def build_prompt(request: PromptBuildRequest):
    """构建带上下文的对话 prompt。"""
    try:
        if request.type == "continuation":
            messages = _prompt_builder.build_continuation_prompt(request.context)
        elif request.type == "polish":
            messages = _prompt_builder.build_polish_prompt(request.context)
        else:
            messages = _prompt_builder.build_chat_prompt(request.context)
        return {"messages": messages}
    except Exception as exc:
        logger.exception("Prompt build failed")
        return {"messages": [], "error": str(exc)}


# ── AIGC image generation ────────────────────────────────────────────────
class ImageGenRequest(BaseModel):
    prompt: str
    width: int = 1024
    height: int = 1024
    provider: str = "pollinations"
    novel_id: int = 0
    seed: int | None = None
    # Output directory scope (task #64): novel | media | memo.
    scope: str = "novel"


_pollinations = PollinationsProvider()
_dalle = DallEProvider()
_IMAGE_PROVIDERS = {
    "pollinations": _pollinations,
    "dalle": _dalle,
}


@app.post("/api/aigc/generate")
async def generate_image(request: ImageGenRequest):
    """Generate an image synchronously (called by Go task engine worker)."""
    prov = _IMAGE_PROVIDERS.get(request.provider)
    if prov is None:
        return {"error": f"unknown provider: {request.provider}"}

    if not await prov.is_available():
        return {"error": f"provider '{request.provider}' is not available"}

    try:
        result = await prov.generate(
            prompt=request.prompt,
            width=request.width,
            height=request.height,
            novel_id=request.novel_id,
            seed=request.seed,
            scope=request.scope,
        )
        return {
            "url": result.url,
            "file_path": result.file_path,
            "thumbnail_path": result.thumbnail_path,
            "width": result.width,
            "height": result.height,
            "provider": result.provider,
            "file_size": result.file_size,
        }
    except Exception as exc:
        logger.exception("Image generation failed")
        return {"error": str(exc)}


async def main():
    """Start both FastAPI (HTTP) and gRPC servers."""
    config = uvicorn.Config(
        app,
        host="0.0.0.0",
        port=settings.http_port,
        log_level="info",
    )
    server = uvicorn.Server(config)
    await server.serve()


if __name__ == "__main__":
    asyncio.run(main())
