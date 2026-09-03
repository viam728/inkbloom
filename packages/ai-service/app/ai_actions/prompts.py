"""Prompt templates for AI action endpoints."""

SYSTEM_JSON = (
    "你是专业的中文创作助手。严格按照用户要求输出合法 JSON，"
    "不要输出任何解释、前后缀或 markdown 代码块标记。"
)

SYSTEM_WRITER = (
    "你是一位经验丰富的中文创作助手，文笔自然流畅，擅长小说与自媒体内容创作。"
    "直接输出结果本身，不要附加解释。"
)

# ── 1. 候选生成 ──────────────────────────────────────────────────────────


def candidates_prompt(action: str, context: str, n: int) -> str:
    return (
        f"请针对以下创作操作生成 {n} 条候选内容。\n"
        f"操作类型：{action}\n"
        f"上下文：\n{context}\n\n"
        f"要求：\n"
        f"1. 输出一个 JSON 数组，包含恰好 {n} 条候选字符串；\n"
        f"2. 每条候选风格或角度有所差异，简洁可用；\n"
        f"3. 只输出 JSON 数组本身。"
    )


# ── 2. 章节审阅 ──────────────────────────────────────────────────────────


def review_prompt(chapter_id: int, text: str) -> str:
    return (
        f"请审阅以下章节（chapter_id={chapter_id}）文本，找出情节、逻辑、人物或文字上的问题。\n\n"
        f"正文：\n{text}\n\n"
        "要求：输出一个 JSON 数组，每个元素是一条批注，字段为：\n"
        '- "quote"：从原文中摘录的问题片段（必须与原文一致）；\n'
        '- "comment"：问题说明；\n'
        '- "suggestion"（可选）：修改建议；\n'
        '- "severity"：严重程度，只能是 "low"、"medium" 或 "high" 之一。\n'
        "只输出 JSON 数组本身。如果文本质量良好没有问题，输出空数组 []。"
    )


# ── 3. 灵感激发 ──────────────────────────────────────────────────────────


def inspiration_prompt(category: str, context: str) -> str:
    ctx = f"当前创作背景：\n{context}\n\n" if context else ""
    return (
        f"请围绕创作类别「{category}」提供灵感点子。\n"
        f"{ctx}"
        "要求：\n"
        "1. 输出一个 JSON 数组，包含 5 条具体、有画面感的灵感点子；\n"
        "2. 每条点子为一句话，避免空泛；\n"
        "3. 只输出 JSON 数组本身。"
    )


# ── 4. 大纲扩写成稿 ─────────────────────────────────────────────────────


def expand_outline_prompt(
    outline_title: str,
    summary: str,
    memory_context: str,
    target_words: int | None,
) -> tuple[str, str]:
    words_hint = (
        f"目标篇幅约 {target_words} 字，请控制在该字数附近（允许 ±15%）。"
        if target_words
        else "篇幅自然展开即可。"
    )
    memory_block = (
        f"\n相关设定（人物/世界观等，写作时需保持一致）：\n{memory_context}\n"
        if memory_context
        else ""
    )
    system = (
        "你是一位擅长中文小说创作的写作助手。根据大纲要点扩写成正文，"
        "使用文学化的中文叙事语体，注重场景描写、人物动作与对话，"
        "不要输出标题、章节号或任何解释性文字，直接输出正文。"
    )
    user = (
        f"大纲标题：{outline_title}\n"
        f"情节概要：\n{summary}\n"
        f"{memory_block}\n"
        f"{words_hint}\n\n"
        "请将以上内容扩写为一段完整的小说正文。"
    )
    return system, user


# ── 5/6. 作品分析（共用输出契约） ────────────────────────────────────────

_ANALYSIS_FORMAT = """要求：输出一个 JSON 对象，字段如下：
{
  "score": 0-100 的整数综合评分,
  "summary": "一段 2-3 句的整体评价",
  "dimensions": [
    {"label": "维度名称", "score": 0-100 的整数, "tip": "针对该维度的具体建议"}
  ],
  "suggestions": ["3-5 条可执行的改进建议"]
}
dimensions 给出 3-5 个维度。评分客观、建议具体。只输出 JSON 对象本身。"""


def analyze_story_prompt(
    title: str,
    chapter_count: int,
    total_words: int,
    outline_acts: int,
    outline_nodes: int,
    characters: int,
) -> str:
    return (
        "请以资深小说编辑的视角，分析以下小说作品的整体状态并给出建议。\n\n"
        f"作品标题：《{title}》\n"
        f"章节数：{chapter_count}\n"
        f"总字数：{total_words}\n"
        f"大纲幕数：{outline_acts}\n"
        f"大纲节点数：{outline_nodes}\n"
        f"已建档人物数：{characters}\n\n"
        "可从结构完整度、创作进度、篇幅均衡、人物与设定厚度等维度评估。\n"
        + _ANALYSIS_FORMAT
    )


def analyze_media_prompt(title: str, content: str, platform: str) -> str:
    return (
        f"请以自媒体运营专家的视角，分析以下面向「{platform}」平台的内容，并给出优化建议。\n\n"
        f"标题：{title}\n"
        f"正文：\n{content}\n\n"
        "可从标题吸引力、开头钩子、内容结构、平台调性匹配、互动引导等维度评估。\n"
        + _ANALYSIS_FORMAT
    )


# ── 7/8. 自媒体标题与平台改写 ───────────────────────────────────────────

PLATFORM_STYLES: dict[str, dict[str, str]] = {
    "wechat": {
        "label": "微信公众号",
        "title_style": "标题沉稳有信息量，可用数字或观点式表达，避免过度夸张，控制在 20 字以内",
        "adapt_style": "语气沉稳专业、娓娓道来，段落清晰，适合深度阅读；篇幅 800-1500 字",
    },
    "xiaohongshu": {
        "label": "小红书",
        "title_style": "标题活泼带情绪，多用 emoji、感叹号和关键词标签，控制在 20 字以内",
        "adapt_style": (
            "语气亲切种草、口语化，多用 emoji 和分点列表，"
            "结尾加互动引导；篇幅 300-800 字"
        ),
    },
    "weibo": {
        "label": "微博",
        "title_style": "标题短促有话题点，可带话题标签 #xxx#，控制在 15 字以内",
        "adapt_style": "语气简洁犀利，突出观点与话题性；正文控制在 140-280 字",
    },
    "video": {
        "label": "短视频",
        "title_style": "标题制造悬念或冲突，激发点击欲，控制在 20 字以内",
        "adapt_style": (
            "改写为短视频口播脚本：开头 3 秒抛出钩子，口语化表达，"
            "节奏紧凑；篇幅 200-500 字"
        ),
    },
}

DEFAULT_PLATFORM = {"label": "通用平台", "title_style": "标题简洁有吸引力", "adapt_style": "语气自然流畅"}


def platform_meta(platform: str) -> dict[str, str]:
    return PLATFORM_STYLES.get(platform, DEFAULT_PLATFORM)


def generate_titles_prompt(topic: str, platform: str, count: int) -> str:
    meta = platform_meta(platform)
    return (
        f"请为主题「{topic}」生成适用于{meta['label']}的标题。\n"
        f"平台风格要求：{meta['title_style']}。\n\n"
        f"要求：\n"
        f"1. 输出一个 JSON 数组，包含恰好 {count} 条标题字符串；\n"
        f"2. 标题之间角度、句式有所差异，避免雷同；\n"
        f"3. 只输出 JSON 数组本身。"
    )


def adapt_content_prompt(content: str, platform: str) -> tuple[str, str]:
    meta = platform_meta(platform)
    system = (
        f"你是一位精通{meta['label']}内容运营的自媒体编辑。"
        "按目标平台的风格与篇幅要求改写用户提供的文案，直接输出改写结果，不要附加解释。"
    )
    user = (
        f"请将以下内容改写为适合{meta['label']}发布的文案。\n"
        f"风格与长度要求：{meta['adapt_style']}。\n"
        f"保留原文核心信息，可按平台习惯重新组织结构、调整语气。\n\n"
        f"原文：\n{content}"
    )
    return system, user


# ── 7. 作品概览 AI 生成（书名 / 简介 / 创意 / 文风 / 受众 / 意图） ──────────

# 概览字段的中文标签与生成要求
_STORY_OVERVIEW_FIELDS = {
    "title": "书名：简洁有力、有记忆点，2-12 个字",
    "description": "简介：2-4 句话概括故事内核与看点，80-200 字，有钩子",
    "logline": "一句话创意：用一句话点出核心设定或冲突，20-50 字",
    "style": "文风：2-8 个字概括语言风格（如：冷峻武侠 / 轻松甜宠 / 悬疑暗黑）",
    "audience": "目标受众：描述核心读者画像，如：15-25 岁网文读者 / 都市女性",
    "intent": "创作意图：说明作者想达成的叙事效果，如：爽文爽感优先 / 情感共鸣 / 悬疑反转",
}


def story_overview_prompt(
    existing: dict,
    fields: list[str],
    variant: int,
    clues: list[dict] | None = None,
) -> str:
    """Build the user prompt for story-overview generation.

    ``existing`` carries the current overview (all known fields) so the AI
    generates each requested field *consistent* with the whole picture (req 6:
    single-field generation still sees the entire overview context). ``variant``
    is a random integer injected to diversify outputs across calls (req 5:
    randomness). The prompt explicitly asks for both 热门度 (popularity) and
    创新性 (innovation). ``clues`` carries author-checked clue-library excerpts
    (outline/memory/foreshadow) as hard constraints for ALL overview AIGC.
    """
    want = [f for f in fields if f in _STORY_OVERVIEW_FIELDS] or list(_STORY_OVERVIEW_FIELDS.keys())
    lines = "\n".join(f"- {_STORY_OVERVIEW_FIELDS[f]}" for f in want)

    ctx_parts = []
    for key, label in (
        ("title", "现有书名"),
        ("description", "现有简介"),
        ("logline", "现有创意"),
        ("style", "现有文风"),
        ("audience", "现有受众"),
        ("intent", "现有意图"),
    ):
        val = (existing or {}).get(key)
        if val:
            ctx_parts.append(f"{label}：{val}")
    ctx = "\n".join(ctx_parts) if ctx_parts else "（暂无现有内容）"

    # 线索库摘录段：作者勾选了才注入，未勾选（或作品没有对应库）时不出现
    clue_labels = {"outline": "大纲", "memory": "记忆", "foreshadow": "伏笔"}
    clue_parts = []
    for c in clues or []:
        label = clue_labels.get(c.get("kind", ""), c.get("kind", ""))
        text = " ".join(str(c.get("content", "")).split())
        if label and text:
            clue_parts.append(f"- {label}：{text[:1200]}")
    clue_section = ""
    if clue_parts:
        clue_section = (
            "作者勾选的参考线索（既有设定，生成时必须严格遵循并自然融入，不得与之矛盾）：\n"
            + "\n".join(clue_parts)
            + "\n\n"
        )

    return (
        "你是一位精通网文与泛娱乐内容创作的策划。请基于「作品概览」的已有信息，"
        "为指定字段生成高质量内容。\n\n"
        f"已有概览信息：\n{ctx}\n\n"
        f"{clue_section}"
        "需要生成的字段（必须全部生成，缺一不可）：\n"
        f"{lines}\n\n"
        "硬性要求：\n"
        "1. 输出一个 JSON 对象，键名严格为上述字段英文名（title/description/logline/style/audience/intent），"
        "值为对应字符串；不要输出任何解释、前后缀或 markdown 代码块。\n"
        "2. 各字段内容必须与「已有概览信息」保持世界观、基调、受众一致，互为补充而非矛盾。\n"
        "3. 兼具【热门度】与【创新性】：既贴合当下同类爆款的吸睛规律（标题抓人、简介有钩子），"
        "又要有独到的设定或角度，避免套用烂大街的模板。\n"
        "4. 本次随机变体编号：" + str(variant) + "（请据此在合理范围内调整措辞与切入点，使每次生成都不一样）。\n"
        "只输出 JSON 对象本身。"
    )
