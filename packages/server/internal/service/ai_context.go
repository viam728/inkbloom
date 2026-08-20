package service

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/inkbloom/server/internal/model"
	"github.com/inkbloom/server/internal/repository"
	"github.com/inkbloom/server/internal/scope"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

// AIContext holds the assembled context for an AI request.
type AIContext struct {
	ChapterContent    string             `json:"chapter_content"`
	ChapterSummary    string             `json:"chapter_summary"`
	NovelTitle        string             `json:"novel_title"`
	RelatedSettings   []SettingContext   `json:"related_settings"`
	RelatedCharacters []CharacterContext `json:"related_characters"`
}

// SettingContext is a condensed setting entry for AI context.
type SettingContext struct {
	Title   string `json:"title"`
	Content string `json:"content"`
}

// CharacterContext is a condensed character entry for AI context.
type CharacterContext struct {
	Name        string `json:"name"`
	Role        string `json:"role"`
	Brief       string `json:"brief"`
	Personality string `json:"personality"`
}

// AIContextBuilder assembles contextual information for AI requests.
type AIContextBuilder struct {
	chapterRepo repository.ChapterRepository
	novelRepo   repository.NovelRepository
	db          *gorm.DB
	logger      *zap.Logger
}

// NewAIContextBuilder creates a new AIContextBuilder.
func NewAIContextBuilder(
	chapterRepo repository.ChapterRepository,
	novelRepo repository.NovelRepository,
	db *gorm.DB,
	logger *zap.Logger,
) *AIContextBuilder {
	return &AIContextBuilder{
		chapterRepo: chapterRepo,
		novelRepo:   novelRepo,
		db:          db,
		logger:      logger,
	}
}

// Build assembles AI context from the novel, chapter, and surrounding text,
// scoped to the requesting user. cursorText is the text near the cursor used
// for keyword matching.
func (b *AIContextBuilder) Build(ctx context.Context, userID, novelID, chapterID int64, cursorText string) (*AIContext, error) {
	result := &AIContext{}

	// 1. Fetch current chapter
	chapter, err := b.chapterRepo.GetByID(ctx, userID, chapterID)
	if err != nil {
		b.logger.Warn("failed to fetch chapter", zap.Int64("chapter_id", chapterID), zap.Error(err))
	}
	if chapter != nil {
		result.ChapterContent = extractWindow(chapter.Content, cursorText, 500)
		if chapter.Summary != nil {
			result.ChapterSummary = *chapter.Summary
		}
	}

	// 2. Fetch novel
	novel, err := b.novelRepo.GetByID(ctx, userID, novelID)
	if err != nil {
		b.logger.Warn("failed to fetch novel", zap.Int64("novel_id", novelID), zap.Error(err))
	}
	if novel != nil {
		result.NovelTitle = novel.Title
	}

	// 3. Extract keywords from cursor text for matching
	keywords := extractKeywords(cursorText)

	// 4. Query related settings (LIKE match, max 5)
	result.RelatedSettings = b.findRelatedSettings(ctx, userID, novelID, keywords, 5)

	// 5. Query related characters (LIKE match, max 5)
	result.RelatedCharacters = b.findRelatedCharacters(ctx, userID, novelID, keywords, 5)

	// 6. Token budget enforcement (< 4000 tokens, ~1.5 tokens per CJK char / ~1 per English word)
	truncateContext(result, 4000)

	return result, nil
}

// extractWindow returns a window of ±maxChars around cursorText in content.
// If cursorText is empty or not found, returns the last maxChars*2 of content.
func extractWindow(content *string, cursorText string, maxChars int) string {
	if content == nil {
		return ""
	}
	text := *content
	if cursorText == "" {
		// Return tail of content
		runes := []rune(text)
		limit := maxChars * 2
		if len(runes) > limit {
			return string(runes[len(runes)-limit:])
		}
		return text
	}

	idx := strings.Index(text, cursorText)
	if idx < 0 {
		// Fallback to tail
		runes := []rune(text)
		limit := maxChars * 2
		if len(runes) > limit {
			return string(runes[len(runes)-limit:])
		}
		return text
	}

	start := idx - maxChars
	if start < 0 {
		start = 0
	}
	end := idx + len(cursorText) + maxChars
	runes := []rune(text)
	if end > len(runes) {
		end = len(runes)
	}
	startRune := utf8.RuneCountInString(text[:start])
	if startRune > len(runes) {
		startRune = len(runes)
	}
	endRune := utf8.RuneCountInString(text[:end])
	if endRune > len(runes) {
		endRune = len(runes)
	}
	if startRune >= endRune {
		return text
	}
	return string(runes[startRune:endRune])
}

// extractKeywords extracts simple keywords from text.
// For Chinese text: split into 2-char bigrams.
// For mixed text: also include any words longer than 2 chars.
func extractKeywords(text string) []string {
	if text == "" {
		return nil
	}
	seen := make(map[string]bool)
	var keywords []string

	// Extract Chinese bigrams
	runes := []rune(text)
	for i := 0; i < len(runes)-1; i++ {
		r := runes[i]
		if r >= 0x4e00 && r <= 0x9fff {
			bigram := string(runes[i : i+2])
			if !seen[bigram] {
				seen[bigram] = true
				keywords = append(keywords, bigram)
			}
		}
	}

	// Extract words (non-CJK sequences)
	words := strings.FieldsFunc(text, func(r rune) bool {
		return r < 'A' || (r > 'Z' && r < 'a') || (r > 'z' && r < 0x4e00) || (r > 0x9fff && r < 0x3040)
	})
	for _, w := range words {
		if len(w) >= 2 && !seen[w] {
			seen[w] = true
			keywords = append(keywords, w)
		}
	}

	// Cap at 20 keywords to avoid excessive queries
	if len(keywords) > 20 {
		keywords = keywords[:20]
	}
	return keywords
}

// findRelatedSettings queries settings matching any keyword via LIKE.
func (b *AIContextBuilder) findRelatedSettings(ctx context.Context, userID, novelID int64, keywords []string, limit int) []SettingContext {
	if len(keywords) == 0 {
		return nil
	}

	var settings []model.Setting
	query := b.db.WithContext(ctx).Scopes(scope.ForUser(userID)).Where("novel_id = ?", novelID)

	// Build OR conditions for title/content LIKE match
	conditions := make([]string, 0, len(keywords)*2)
	args := make([]interface{}, 0, len(keywords)*2+1)
	args = append(args, novelID)
	for _, kw := range keywords {
		pattern := "%" + kw + "%"
		conditions = append(conditions, "title LIKE ?", "content LIKE ?")
		args = append(args, pattern, pattern)
	}

	orClause := strings.Join(conditions, " OR ")
	query = query.Where("("+orClause+")", args[1:]...).Limit(limit)

	if err := query.Find(&settings).Error; err != nil {
		b.logger.Warn("findRelatedSettings failed", zap.Error(err))
		return nil
	}

	result := make([]SettingContext, 0, len(settings))
	for _, s := range settings {
		entry := SettingContext{Title: s.Title}
		if s.Content != nil {
			content := *s.Content
			// Truncate long content to ~200 chars
			runes := []rune(content)
			if len(runes) > 200 {
				content = string(runes[:200]) + "..."
			}
			entry.Content = content
		}
		result = append(result, entry)
	}
	return result
}

// findRelatedCharacters queries characters matching any keyword via LIKE.
func (b *AIContextBuilder) findRelatedCharacters(ctx context.Context, userID, novelID int64, keywords []string, limit int) []CharacterContext {
	if len(keywords) == 0 {
		return nil
	}

	var characters []model.Character
	query := b.db.WithContext(ctx).Scopes(scope.ForUser(userID)).Where("novel_id = ?", novelID)

	conditions := make([]string, 0, len(keywords)*3)
	args := make([]interface{}, 0, len(keywords)*3)
	for _, kw := range keywords {
		pattern := "%" + kw + "%"
		conditions = append(conditions, "name LIKE ?", "brief LIKE ?", "personality LIKE ?")
		args = append(args, pattern, pattern, pattern)
	}

	orClause := strings.Join(conditions, " OR ")
	query = query.Where("("+orClause+")", args...).Limit(limit)

	if err := query.Find(&characters).Error; err != nil {
		b.logger.Warn("findRelatedCharacters failed", zap.Error(err))
		return nil
	}

	result := make([]CharacterContext, 0, len(characters))
	for _, c := range characters {
		entry := CharacterContext{Name: c.Name}
		if c.Role != nil {
			entry.Role = *c.Role
		}
		if c.Brief != nil {
			brief := *c.Brief
			runes := []rune(brief)
			if len(runes) > 150 {
				brief = string(runes[:150]) + "..."
			}
			entry.Brief = brief
		}
		if c.Personality != nil {
			p := *c.Personality
			runes := []rune(p)
			if len(runes) > 100 {
				p = string(runes[:100]) + "..."
			}
			entry.Personality = p
		}
		result = append(result, entry)
	}
	return result
}

// truncateContext ensures total context stays within tokenBudget.
// Rough heuristic: 1 token ≈ 1.5 CJK chars or 4 English chars.
func truncateContext(ctx *AIContext, tokenBudget int) {
	estimateTokens := func(s string) int {
		cjk := 0
		ascii := 0
		for _, r := range s {
			if r >= 0x4e00 && r <= 0x9fff {
				cjk++
			} else {
				ascii++
			}
		}
		return cjk + ascii/4
	}

	total := estimateTokens(ctx.ChapterContent) +
		estimateTokens(ctx.ChapterSummary) +
		estimateTokens(ctx.NovelTitle)

	for _, s := range ctx.RelatedSettings {
		total += estimateTokens(s.Title) + estimateTokens(s.Content)
	}
	for _, c := range ctx.RelatedCharacters {
		total += estimateTokens(c.Name) + estimateTokens(c.Role) + estimateTokens(c.Brief) + estimateTokens(c.Personality)
	}

	// If over budget, progressively trim chapter content
	if total > tokenBudget {
		excess := total - tokenBudget
		runes := []rune(ctx.ChapterContent)
		trimChars := excess * 2 // rough conversion
		if trimChars >= len(runes) {
			ctx.ChapterContent = ""
		} else {
			ctx.ChapterContent = string(runes[:len(runes)-trimChars])
		}
	}

	// If still over, drop settings/characters from the end
	for total > tokenBudget && len(ctx.RelatedCharacters) > 0 {
		last := ctx.RelatedCharacters[len(ctx.RelatedCharacters)-1]
		ctx.RelatedCharacters = ctx.RelatedCharacters[:len(ctx.RelatedCharacters)-1]
		total -= estimateTokens(last.Name) + estimateTokens(last.Role) + estimateTokens(last.Brief) + estimateTokens(last.Personality)
	}
	for total > tokenBudget && len(ctx.RelatedSettings) > 0 {
		last := ctx.RelatedSettings[len(ctx.RelatedSettings)-1]
		ctx.RelatedSettings = ctx.RelatedSettings[:len(ctx.RelatedSettings)-1]
		total -= estimateTokens(last.Title) + estimateTokens(last.Content)
	}
}

// FormatContextMessages formats the AIContext into a system message string.
func FormatContextMessages(aiCtx *AIContext) string {
	var sb strings.Builder

	if aiCtx.NovelTitle != "" {
		sb.WriteString("【小说】" + aiCtx.NovelTitle + "\n")
	}
	if aiCtx.ChapterSummary != "" {
		sb.WriteString("【章节摘要】" + aiCtx.ChapterSummary + "\n")
	}

	if len(aiCtx.RelatedSettings) > 0 {
		sb.WriteString("【相关设定】\n")
		for _, s := range aiCtx.RelatedSettings {
			sb.WriteString("- " + s.Title)
			if s.Content != "" {
				sb.WriteString(": " + s.Content)
			}
			sb.WriteString("\n")
		}
	}

	if len(aiCtx.RelatedCharacters) > 0 {
		sb.WriteString("【相关角色】\n")
		for _, c := range aiCtx.RelatedCharacters {
			sb.WriteString("- " + c.Name)
			if c.Role != "" {
				sb.WriteString("(" + c.Role + ")")
			}
			if c.Brief != "" {
				sb.WriteString(": " + c.Brief)
			}
			sb.WriteString("\n")
		}
	}

	if aiCtx.ChapterContent != "" {
		sb.WriteString("【当前章节上下文】\n" + aiCtx.ChapterContent + "\n")
	}

	return sb.String()
}
