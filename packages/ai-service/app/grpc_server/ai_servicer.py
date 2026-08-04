"""AI Service gRPC servicer implementation."""

import grpc

from app.grpc_server.generated import ai_service_pb2
from app.grpc_server.generated import ai_service_pb2_grpc
from app.knowledge.entity_extractor import EntityExtractor
from app.knowledge.relation_extractor import RelationExtractor
from app.knowledge.consistency_checker import ConsistencyChecker
from app.llm.openai_provider import OpenAIProvider
from app.config import settings


class AIServiceServicer(ai_service_pb2_grpc.AIServiceServicer):
    """gRPC servicer for the AIService."""

    def __init__(self) -> None:
        self._llm = OpenAIProvider()
        self._entity_extractor = EntityExtractor(self._llm)
        self._relation_extractor = RelationExtractor(self._llm)
        self._consistency_checker = ConsistencyChecker(self._llm)

    async def ChatStream(
        self,
        request: ai_service_pb2.ChatRequest,
        context: grpc.aio.ServicerContext,
    ):
        """Stream chat completion chunks to the client."""
        messages = [
            {"role": msg.role, "content": msg.content}
            for msg in request.messages
        ]
        model = request.model or settings.default_model
        temperature = request.temperature if request.temperature > 0 else 0.7
        max_tokens = request.max_tokens if request.max_tokens > 0 else 2048

        try:
            async for chunk in self._llm.stream(
                messages=messages,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
            ):
                yield ai_service_pb2.ChatChunk(
                    content=chunk.content,
                    finish_reason=chunk.finish_reason,
                )
        except Exception as e:
            await context.abort(grpc.StatusCode.INTERNAL, f"LLM stream error: {e}")

    async def ChatComplete(
        self,
        request: ai_service_pb2.ChatRequest,
        context: grpc.aio.ServicerContext,
    ) -> ai_service_pb2.ChatResponse:
        """Return a complete chat response."""
        messages = [
            {"role": msg.role, "content": msg.content}
            for msg in request.messages
        ]
        model = request.model or settings.default_model
        temperature = request.temperature if request.temperature > 0 else 0.7
        max_tokens = request.max_tokens if request.max_tokens > 0 else 2048

        try:
            result = await self._llm.chat(
                messages=messages,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
            )

            return ai_service_pb2.ChatResponse(
                content=result.content,
                usage=ai_service_pb2.Usage(
                    prompt_tokens=result.prompt_tokens,
                    completion_tokens=result.completion_tokens,
                    total_tokens=result.prompt_tokens + result.completion_tokens,
                ),
            )
        except Exception as e:
            await context.abort(grpc.StatusCode.INTERNAL, f"LLM error: {e}")

    async def GenerateImagePrompt(
        self,
        request: ai_service_pb2.ImagePromptRequest,
        context: grpc.aio.ServicerContext,
    ) -> ai_service_pb2.ImagePromptResponse:
        """Generate an image prompt (not yet implemented)."""
        await context.abort(
            grpc.StatusCode.UNIMPLEMENTED,
            "GenerateImagePrompt is not yet implemented",
        )

    async def ExtractEntities(
        self,
        request: ai_service_pb2.ExtractRequest,
        context: grpc.aio.ServicerContext,
    ) -> ai_service_pb2.EntityResponse:
        """Extract entities from text using LLM."""
        try:
            entities = await self._entity_extractor.extract(
                text=request.text,
                novel_id=request.novel_id,
                chapter_id=request.chapter_id,
            )

            pb_entities = [
                ai_service_pb2.Entity(
                    name=e["name"],
                    type=e["type"],
                    description=e.get("description", ""),
                )
                for e in entities
            ]
            return ai_service_pb2.EntityResponse(entities=pb_entities)
        except Exception as e:
            await context.abort(grpc.StatusCode.INTERNAL, f"Entity extraction error: {e}")

    async def ExtractRelations(
        self,
        request: ai_service_pb2.RelationRequest,
        context: grpc.aio.ServicerContext,
    ) -> ai_service_pb2.RelationResponse:
        """Extract relations from text using LLM."""
        try:
            entities = [
                {"name": e.name, "type": e.type, "description": e.description}
                for e in request.entities
            ]
            relations = await self._relation_extractor.extract(
                text=request.text,
                entities=entities,
            )

            pb_relations = [
                ai_service_pb2.Relation(
                    source_name=r["source_name"],
                    target_name=r["target_name"],
                    relation_type=r["relation_type"],
                    description=r.get("description", ""),
                )
                for r in relations
            ]
            return ai_service_pb2.RelationResponse(relations=pb_relations)
        except Exception as e:
            await context.abort(grpc.StatusCode.INTERNAL, f"Relation extraction error: {e}")

    async def CheckConsistency(
        self,
        request: ai_service_pb2.ConsistencyRequest,
        context: grpc.aio.ServicerContext,
    ) -> ai_service_pb2.ConsistencyResponse:
        """Check text consistency against existing entities."""
        try:
            entities = [
                {"name": e.name, "type": e.type, "description": e.description}
                for e in request.entities
            ]
            issues = await self._consistency_checker.check(
                text=request.text,
                entities=entities,
            )

            pb_issues = [
                ai_service_pb2.ConsistencyIssue(
                    description=i["description"],
                    severity=i["severity"],
                    entity_name=i.get("entity_name", ""),
                )
                for i in issues
            ]
            return ai_service_pb2.ConsistencyResponse(issues=pb_issues)
        except Exception as e:
            await context.abort(grpc.StatusCode.INTERNAL, f"Consistency check error: {e}")
