"""InkBloom AI Service entry point: FastAPI + gRPC server."""

import asyncio
import json
import logging
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from grpc import aio as grpc_aio
from pydantic import BaseModel

from app.config import settings
from app.grpc_server.ai_servicer import AIServiceServicer
from app.grpc_server.generated import ai_service_pb2_grpc
from app.knowledge.entity_extractor import EntityExtractor
from app.knowledge.relation_extractor import RelationExtractor
from app.knowledge.consistency_checker import ConsistencyChecker
from app.llm.openai_provider import OpenAIProvider
from app.ai_actions.routes import create_router as create_ai_actions_router
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
_prompt_builder = PromptBuilder()
_image_prompt_builder = ImagePromptBuilder(_llm)

# ── AI action endpoints (candidates / review / analysis / media) ────────
app.include_router(create_ai_actions_router(_llm))


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok"}


@app.post("/api/chat/stream")
async def chat_stream(request: ChatHTTPRequest):
    """Stream chat completion chunks via SSE."""
    messages = [{"role": m.role, "content": m.content} for m in request.messages]
    model = request.model or settings.default_model

    async def generate():
        try:
            async for chunk in _llm.stream(
                messages=messages,
                model=model,
                temperature=request.temperature,
                max_tokens=request.max_tokens,
            ):
                data = json.dumps({"content": chunk.content})
                yield f"data: {data}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as exc:
            err = json.dumps({"content": f"[Error] {exc}"})
            yield f"data: {err}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


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
        return {"content": result.content}
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


@app.post("/api/chat/inline")
async def inline_completion(request: InlineRequest):
    """Inline completion - SSE streaming."""
    messages = [{"role": m.role, "content": m.content} for m in request.messages]
    model = request.model or settings.default_model

    async def generate():
        try:
            async for chunk in _llm.stream(
                messages=messages,
                model=model,
                temperature=request.temperature,
                max_tokens=request.max_tokens,
            ):
                data = json.dumps({"content": chunk.content})
                yield f"data: {data}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as exc:
            err = json.dumps({"content": f"[Error] {exc}"})
            yield f"data: {err}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@app.post("/api/chat/rewrite")
async def rewrite_text(request: RewriteRequest):
    """Text rewrite (polish/expand/condense/humanize) - SSE streaming."""
    messages = [{"role": m.role, "content": m.content} for m in request.messages]
    model = request.model or settings.default_model

    async def generate():
        try:
            async for chunk in _llm.stream(
                messages=messages,
                model=model,
                temperature=request.temperature,
                max_tokens=request.max_tokens,
            ):
                data = json.dumps({"content": chunk.content})
                yield f"data: {data}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as exc:
            err = json.dumps({"content": f"[Error] {exc}"})
            yield f"data: {err}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


# ── Knowledge HTTP endpoints ─────────────────────────────────────────────
class ExtractHTTPRequest(BaseModel):
    text: str
    novel_id: int
    chapter_id: int


class ConsistencyHTTPRequest(BaseModel):
    text: str
    novel_id: int
    entities: list[dict]


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
