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
