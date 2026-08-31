"""Two-step orchestration pipeline for agent scene generation.

Step 1 asks the LLM for a concise point outline of the intended output;
step 2 expands that outline (plus context) into the final body text.
Any failure — or a scene configured as single-step — falls back to a
direct one-shot generation. Error handling mirrors the ai_actions
paradigm: ``call_llm`` returns (content, err, usage, model) and an err
short-circuits. Usages of all performed steps are merged so the Go
server can bill the full pipeline cost (task #43).
"""

import logging

from app.ai_actions.service import call_llm

logger = logging.getLogger(__name__)

_STEP1_SYSTEM = (
    "你是一位中文创作规划助手。根据任务要求先列出要点提纲，"
    "输出分点文本（每行一个要点），不要输出正文，不要附加解释。"
)

_STEP1_MAX_TOKENS = 800


def _merge_usage(*usages) -> dict | None:
    """Sum prompt/completion token counts across pipeline steps."""
    merged = {"prompt_tokens": 0, "completion_tokens": 0}
    seen = False
    for u in usages:
        if not u:
            continue
        seen = True
        merged["prompt_tokens"] += int(u.get("prompt_tokens") or 0)
        merged["completion_tokens"] += int(u.get("completion_tokens") or 0)
    return merged if seen else None


def _step1_user_prompt(scene_label: str, user_prompt: str) -> str:
    return (
        f"任务类型：{scene_label}\n"
        f"以下是完整的任务描述与上下文：\n{user_prompt}\n\n"
        "请为即将生成的内容列出 4-8 条要点提纲，每行一个要点，"
        "覆盖结构、关键细节与风格要求。"
    )


def _step2_user_prompt(outline_points: str, user_prompt: str) -> str:
    return (
        f"{user_prompt}\n\n"
        f"【要点提纲（生成正文时必须覆盖以下要点）】\n{outline_points}"
    )


async def run(
    llm,
    scene: dict,
    user_prompt: str,
    model: str | None = None,
) -> tuple[str, str | None, dict | None]:
    """Run the scene pipeline; returns (content, error, usage).

    Two-step when ``scene["two_step"]`` is truthy; otherwise (or on any
    step failure) a single direct call. usage aggregates every performed
    step so billing reflects the true cost.
    """
    system = scene["system"]
    temperature = scene.get("temperature", 0.7)
    max_tokens = scene.get("max_tokens", 2048)

    async def _oneshot():
        # High-temperature providers occasionally return an empty body even on
        # a 200. Retry a couple of times with a lower temperature so a blank
        # never reaches the caller.
        for attempt in range(3):
            t = temperature if attempt == 0 else max(temperature - 0.2, 0.3)
            content, err, usage, _model = await call_llm(
                llm, system, user_prompt,
                temperature=t, max_tokens=max_tokens, model=model,
            )
            if err or not (content or "").strip():
                if err:
                    logger.warning("orchestrator one-shot attempt %d failed: %s", attempt+1, err)
                else:
                    logger.warning("orchestrator one-shot attempt %d returned empty", attempt+1)
                continue
            return content, None, usage
        return "", "one-shot generation returned empty after retries", None

    if not scene.get("two_step", False):
        return await _oneshot()

    # Step 1: point outline
    outline, err, usage1, _model1 = await call_llm(
        llm,
        _STEP1_SYSTEM,
        _step1_user_prompt(scene.get("label", ""), user_prompt),
        temperature=0.5,
        max_tokens=_STEP1_MAX_TOKENS,
        model=model,
    )
    if err:
        logger.warning("agent orchestrator step1 failed, fallback to single-step: %s", err)
        content, err2, usage2 = await _oneshot()
        return content, err2, _merge_usage(usage1, usage2)

    outline = outline.strip()
    if not outline:
        logger.warning("agent orchestrator step1 returned empty outline, fallback to single-step")
        content, err2, usage2 = await _oneshot()
        return content, err2, _merge_usage(usage1, usage2)

    # Step 2: body text driven by the outline
    content, err, usage2, _model2 = await call_llm(
        llm,
        system,
        _step2_user_prompt(outline, user_prompt),
        temperature=temperature,
        max_tokens=max_tokens,
        model=model,
    )
    if err or not (content or "").strip():
        # Empty body with no error is a known provider quirk (high-temperature
        # calls occasionally return empty content); treat it as a failure and
        # fall back to a single-step call so the caller never gets a blank.
        if err:
            logger.warning("agent orchestrator step2 failed, fallback to single-step: %s", err)
        else:
            logger.warning("agent orchestrator step2 returned empty content, fallback to single-step")
        fb_content, fb_err, fb_usage = await _oneshot()
        return fb_content, fb_err, _merge_usage(usage1, usage2, fb_usage)

    return content.strip(), None, _merge_usage(usage1, usage2)
