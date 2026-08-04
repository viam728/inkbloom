package cache

import "time"

// Key naming convention: ink:{type}:{id}[:{subtype}]
const (
	NovelKey       = "ink:novel:%d"
	NovelOutline   = "ink:novel:%d:outline"
	ChapterContent = "ink:chapter:%d:content"
	AssetsNovel    = "ink:assets:novel:%d"
	NovelListKey   = "ink:novels:list:%d:%d" // page:pageSize
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
