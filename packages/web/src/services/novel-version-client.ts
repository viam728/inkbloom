import apiClient from './api-client';

/**
 * 整本里程碑快照服务（Agent safety work Q3）
 *
 * 端点契约：
 *   GET    /novels/:id/versions                → 摘要列表（不含快照正文）
 *   POST   /novels/:id/versions                → 手动打点 { label }
 *   GET    /novels/:id/versions/:vid           → 单条（含完整快照）
 *   POST   /novels/:id/versions/:vid/restore   → 还原 { mode: conservative|full }
 */

export type NovelVersionKind = 'milestone' | 'rollback';
export type RestoreMode = 'conservative' | 'full';

export interface NovelVersionSummary {
    id: number;
    novel_id: number;
    title: string;
    kind: NovelVersionKind;
    label?: string;
    content_hash: string;
    chapter_count: number;
    word_count: number;
    created_at: string;
}

export interface NovelSnapshotChapter {
    id: number;
    title: string;
    content: string;
    word_count: number;
}

export interface NovelSnapshot {
    chapters: NovelSnapshotChapter[];
    outline: { version?: number };
    memory: { version?: number };
}

export interface NovelVersionDetail extends NovelVersionSummary {
    snapshot?: NovelSnapshot;
}

export interface RestoreResult {
    checkpoint_id: number;
    created: number;
    updated: number;
    deleted: number;
    missing: number;
    extra: number;
    mode: RestoreMode;
}

export interface NovelVersionListResponse {
    versions: NovelVersionSummary[];
    total: number;
    limit: number;
    offset: number;
}

export async function listNovelVersions(
    novelId: number,
    limit = 50,
    offset = 0,
): Promise<NovelVersionListResponse> {
    const data = (await apiClient.get(
        `/novels/${novelId}/versions?limit=${limit}&offset=${offset}`,
    )) as unknown as NovelVersionListResponse;
    return data ?? { versions: [], total: 0, limit, offset };
}

/** 手动存一个整本里程碑；返回新版本摘要。 */
export async function snapshotNovel(
    novelId: number,
    label?: string,
): Promise<NovelVersionSummary | null> {
    try {
        return (await apiClient.post(`/novels/${novelId}/versions`, { label })) as unknown as NovelVersionSummary;
    } catch {
        return null;
    }
}

/** 还原整本到指定里程碑。returning 时先写入一个 rollback 检查点，可再次还原撤销。 */
export async function restoreNovelVersion(
    novelId: number,
    versionId: number,
    mode: RestoreMode = 'conservative',
): Promise<RestoreResult> {
    return (await apiClient.post(`/novels/${novelId}/versions/${versionId}/restore`, {
        mode,
    })) as unknown as RestoreResult;
}