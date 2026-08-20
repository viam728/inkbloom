package cache

import "time"

// Key naming convention: ink:{type}:{user_id}:{id}[:{subtype}]
// M1: every per-resource key carries the owning user id so cached views can
// never leak across users.
const (
	NovelKey       = "ink:novel:u%d:%d" // user_id:novel_id
	NovelOutline   = "ink:novel:u%d:%d:outline"
	ChapterContent = "ink:chapter:u%d:%d:content" // user_id:chapter_id
	AssetsNovel    = "ink:assets:novel:u%d:%d"
	NovelListKey   = "ink:novels:list:u%d:%d:%d" // user_id:page:pageSize
	NullValue      = "__NULL__"
)

// TTL constants
const (
	NovelTTL   = 5 * time.Minute
	ChapterTTL = 1 * time.Minute
	AssetsTTL  = 5 * time.Minute
	ListTTL    = 2 * time.Minute
	NullTTL    = 30 * time.Second
)
