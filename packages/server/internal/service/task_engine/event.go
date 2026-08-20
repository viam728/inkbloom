package task_engine

import "strconv"

// taskUserIDString formats the task owner's numeric id for event payloads
// (tech plan v2 §3.2). The WS routing layer (cloud NATS→WS bridge and the
// local-mode LocalBus) keys connections by string user id; 0 (anonymous
// local user / legacy rows) maps to "" which both delivery paths treat as
// broadcast.
func taskUserIDString(uid int64) string {
	if uid <= 0 {
		return ""
	}
	return strconv.FormatInt(uid, 10)
}
