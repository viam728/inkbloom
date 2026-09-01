package model

import (
	"time"

	"gorm.io/datatypes"
)

// VersionKindAgentAuto marks an outline snapshot taken automatically before
// an Agent mutates the outline (plan §七.3.1 "写前自动快照"). It is distinct
// from the chapter VersionKind* constants because outline snapshots live in a
// separate table and carry no content hash.
const VersionKindAgentAuto = "agent_auto"

// OutlineVersion is an immutable snapshot of a novel's outline (acts) taken
// before an Agent write, so an Agent can never permanently overwrite a user's
// outline. Snapshots are append-only; retention (OutlineVersionRepository.
// PruneAuto) deletes only the oldest agent_auto rows beyond a per-novel cap.
//
// The table is created purely via GORM AutoMigrate (contract C1) so it works
// in BOTH cloud PostgreSQL and local SQLite — no raw .sql migration is needed.
type OutlineVersion struct {
	ID      int64          `gorm:"primaryKey;autoIncrement" json:"id"`
	UserID  int64          `gorm:"not null;default:0;index" json:"user_id"`
	NovelID int64          `gorm:"not null;index" json:"novel_id"`
	Acts    datatypes.JSON `gorm:"type:jsonb" json:"acts"`
	Kind    string         `gorm:"type:varchar(20);not null;default:'agent_auto'" json:"kind"`
	Label   string         `gorm:"type:varchar(255)" json:"label"`
	CreatedAt time.Time    `gorm:"autoCreateTime" json:"created_at"`
}

// TableName specifies the table name for OutlineVersion.
func (OutlineVersion) TableName() string {
	return "outline_versions"
}
