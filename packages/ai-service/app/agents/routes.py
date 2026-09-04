"""HTTP routes for the agent-based scene generation endpoint."""

import logging
import time

from fastapi import APIRouter

from app.agents import orchestrator, scenes
from app.agents.models import AgentGenerateRequest
from app.config import settings
from app.llm.base import BaseLLMProvider

logger = logging.getLogger(__name__)


def create_agent_router(llm: BaseLLMProvider) -> APIRouter:
    """Create the agent generation router bound to the given LLM provider."""
    router = APIRouter()

    @router.post("/api/agents/generate")
    async def agent_generate(request: AgentGenerateRequest):
        """Generate content for a scene (character/setting/summary/...)."""
        start = time.perf_counter()
        scene = request.scene

        scene_cfg = scenes.get_scene(scene)
        if scene_cfg is None:
            return {
                "content": "",
                "scene": scene,
                "model": None,
                "elapsed_ms": 0,
                "error": (
                    f"unknown scene: {scene}; "
                    f"expected one of {scenes.known_scene_keys()}"
                ),
            }

        try:
            user_prompt = scene_cfg["user_prompt"](request.context, request.instruction)
            content, err, usage = await orchestrator.run(
                llm, scene_cfg, user_prompt, model=request.model
            )
            elapsed_ms = int((time.perf_counter() - start) * 1000)
            if err:
                return {
                    "content": "",
                    "scene": scene,
                    "model": request.model or settings.default_model,
                    "elapsed_ms": elapsed_ms,
                    "error": err,
                }
            return {
                "content": content,
                "scene": scene,
                "model": request.model or settings.default_model,
                "elapsed_ms": elapsed_ms,
                "usage": usage,
            }
        except Exception as exc:  # noqa: BLE001 - never leak 500 to caller
            logger.exception("agent_generate failed scene=%s", scene)
            return {
                "content": "",
                "scene": scene,
                "model": None,
                "elapsed_ms": int((time.perf_counter() - start) * 1000),
                "error": str(exc),
            }
        finally:
            logger.info(
                "agent_generate scene=%s took %.2fs",
                scene,
                time.perf_counter() - start,
            )

    return router
