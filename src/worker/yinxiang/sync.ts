import { deriveExcerpt, countText } from '@shared/markdown-utils'
import { buildNoteDerivedStatements } from '../db/writes'
import { persistAttachmentWithinQuota } from '../attachments/storage'
import { decryptYinxiangCredential } from '../lib/crypto'
import { acquireLease } from '../lib/lease'
import { newId } from '../lib/id'
import { sha256Hex } from '../lib/encoding'
import type { Env } from '../env'
import { convertEnmlToMarkdown } from './enml'
import { YinxiangClient, type YinxiangNoteRecord } from './client'
import { loadYinxiangAppConfig } from './config'

const SYNC_PAGE_SIZE = 50
const JOB_BUDGET_MS = 20_000

export interface YinxiangConnectionRow {
  id: string
  user_id: string
  environment: 'sandbox' | 'production'
  note_store_url: string | null
  token_ciphertext: string | null
  selected_notebook_guids: string
  root_folder_id: string | null
  include_attachments: number
  frequency: 'manual' | 'hourly' | 'daily'
  status: string
  cursor: number
  full_sync_before: number | null
  last_success_at: number | null
  next_run_at: number | null
  last_error: string | null
  paused_at: number | null
  active_job_id: string | null
  authorized_scopes: string
  notebooks_json: string
  account_id: string | null
  account_label: string | null
  token_expires_at: number | null
  updated_at: number
}

export interface YinxiangSyncJobResult {
  id: string
  status: 'success' | 'partial' | 'failed' | 'paused'
  processed: number
  created: number
  updated: number
  skipped: number
  conflicts: number
  failed: number
  attachmentFailed: number
}

export async function enqueueYinxiangSync(env: Env, userId: string, connectionId: string, trigger: 'manual' | 'cron' | 'retry' = 'manual'): Promise<string> {
  const connection = await loadConnection(env.DB, userId, connectionId)
  if (!connection || connection.status === 'disconnected' || connection.paused_at) throw new Error('Yinxiang sync is paused or disconnected')
  const active = await env.DB.prepare(`SELECT id FROM sync_jobs WHERE connection_id = ?1 AND status IN ('queued', 'running') LIMIT 1`).bind(connectionId).first<{ id: string }>()
  if (active) return active.id
  const id = newId()
  const now = Date.now()
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO sync_jobs (id, user_id, connection_id, trigger, status, cursor_before, created_at) VALUES (?1, ?2, ?3, ?4, 'queued', ?5, ?6)`).bind(id, userId, connectionId, trigger, connection.cursor, now),
    env.DB.prepare(`UPDATE source_connections SET status = 'queued', active_job_id = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4 AND status <> 'disconnected'`).bind(id, now, connectionId, userId),
  ])
  return id
}

export async function runYinxiangSync(env: Env, jobId: string): Promise<YinxiangSyncJobResult> {
  const job = await env.DB.prepare(`SELECT * FROM sync_jobs WHERE id = ?1`).bind(jobId).first<{ id: string; user_id: string; connection_id: string; cursor_before: number }>()
  if (!job) throw new Error('Yinxiang sync job not found')
  const lease = await acquireLease(env.DB, `yinxiang-sync:${job.connection_id}`, 60_000, 'Another Yinxiang sync is already running')
  const leaseToken = newId()
  const started = Date.now()
  try {
    const claimed = await env.DB.prepare(`UPDATE sync_jobs SET status = 'running', lease_token = ?1, lease_until = ?2, started_at = ?3 WHERE id = ?4 AND status = 'queued'`).bind(leaseToken, started + 60_000, started, jobId).run()
    if (!claimed.meta.changes) return await readJobResult(env.DB, jobId)
    const connection = await loadConnection(env.DB, job.user_id, job.connection_id)
    if (!connection || connection.status === 'disconnected' || connection.paused_at) return await finish(env.DB, jobId, 'paused', { error: 'Sync was paused or disconnected' })
    const config = await loadYinxiangAppConfig(env)
    if (!config || !connection.note_store_url || !connection.token_ciphertext) return await finish(env.DB, jobId, 'failed', { error: 'Yinxiang server configuration or credentials are missing' })
    const credential = await decryptYinxiangCredential(env, job.user_id, connection.token_ciphertext)
    if (!credential) return await finish(env.DB, jobId, 'failed', { error: 'Yinxiang credentials could not be decrypted; reauthorization is required' })
    const client = new YinxiangClient({ environment: connection.environment, consumerKey: config.consumerKey, consumerSecret: config.consumerSecret, token: credential.oauthToken, tokenSecret: credential.oauthTokenSecret, noteStoreUrl: connection.note_store_url })
    const state = await client.getSyncState()
    let cursor = connection.cursor
    if (connection.full_sync_before !== null && connection.full_sync_before > cursor) cursor = 0
    const selected = parseJson<string[]>(connection.selected_notebook_guids, [])
    const chunk = await client.getFilteredSyncChunk(cursor, SYNC_PAGE_SIZE)
    const stats = { processed: 0, created: 0, updated: 0, skipped: 0, conflicts: 0, failed: 0, attachmentFailed: 0 }
    const deadline = Date.now() + JOB_BUDGET_MS
    for (const note of chunk.notes.filter((item) => selected.length > 0 && selected.includes(item.notebookGuid ?? ''))) {
      if (Date.now() >= deadline) break
      try {
        const result = await importNote(env, client, connection, note)
        stats[result]++
        stats.processed++
      } catch (error) {
        stats.failed++
        console.warn('[inkstone] Yinxiang note import failed:', error instanceof Error ? error.message : error)
      }
    }
    const nextCursor = chunk.chunkHighUSN > cursor ? chunk.chunkHighUSN : cursor
    const syncBoundary = connection.full_sync_before ?? state.updateCount
    const hasMore = nextCursor < syncBoundary && chunk.notes.length > 0
    const fullSyncBefore = connection.full_sync_before !== null && nextCursor < connection.full_sync_before ? connection.full_sync_before : null
    const status = stats.failed || stats.attachmentFailed ? 'partial' : 'success'
    const connectionStatus = hasMore ? 'queued' : status === 'partial' ? 'partial' : 'connected'
    await env.DB.batch([
      env.DB.prepare(`UPDATE source_connections SET cursor = ?1, full_sync_before = ?2, last_success_at = CASE WHEN ?3 = 'success' THEN ?4 ELSE last_success_at END, next_run_at = ?5, status = ?6, active_job_id = NULL, last_error = ?7, updated_at = ?4 WHERE id = ?8 AND user_id = ?9 AND active_job_id = ?10`).bind(nextCursor, fullSyncBefore, status, Date.now(), nextRunAt(connection.frequency, hasMore), connectionStatus, stats.failed ? 'Some notes failed and can be retried' : null, connection.id, connection.user_id, jobId),
      env.DB.prepare(`UPDATE sync_jobs SET status = ?1, stage = 'complete', cursor_after = ?2, processed = ?3, created_count = ?4, updated_count = ?5, skipped_count = ?6, conflict_count = ?7, failed_count = ?8, attachment_failed_count = ?9, finished_at = ?10, lease_until = NULL WHERE id = ?11 AND lease_token = ?12`).bind(status, nextCursor, stats.processed, stats.created, stats.updated, stats.skipped, stats.conflicts, stats.failed, stats.attachmentFailed, Date.now(), jobId, leaseToken),
    ])
    return { id: jobId, status, ...stats }
  } catch (error) {
    await finish(env.DB, jobId, 'failed', { error: error instanceof Error ? error.message : 'Yinxiang sync failed' })
    throw error
  } finally { await lease() }
}

export async function runScheduledYinxiangSync(env: Env): Promise<void> {
  const now = Date.now()
  const { results } = await env.DB.prepare(`SELECT id, user_id FROM source_connections WHERE provider = 'yinxiang' AND status IN ('connected', 'partial', 'queued') AND paused_at IS NULL AND frequency <> 'manual' AND (next_run_at IS NULL OR next_run_at <= ?1) ORDER BY updated_at LIMIT 20`).bind(now).all<{ id: string; user_id: string }>()
  for (const row of results) {
    try {
      const jobId = await enqueueYinxiangSync(env, row.user_id, row.id, 'cron')
      await runYinxiangSync(env, jobId)
    } catch (error) {
      console.warn('[inkstone] Scheduled Yinxiang sync failed:', error)
    }
  }
}

async function importNote(env: Env, client: YinxiangClient, connection: YinxiangConnectionRow, source: YinxiangNoteRecord): Promise<'created' | 'updated' | 'skipped' | 'conflicts'> {
  let resources = source.resources
  const resourceHashes = new Map<string, string>()
  if (connection.include_attachments) {
    resources = await Promise.all(resources.map(async (resource) => resource.data ? resource : client.getResource(resource.guid)))
    for (const resource of resources) if (resource.bodyHash) resourceHashes.set(resource.bodyHash, resource.bodyHash)
  }
  const converted = convertEnmlToMarkdown(source.content, resourceHashes)
  let content = converted.markdown
  for (const resource of resources) {
    if (!connection.include_attachments || !resource.data) continue
    const sourceHash = resource.bodyHash ?? await sha256Hex(resource.data)
    const existing = await env.DB.prepare(`SELECT target_attachment_id FROM source_resources WHERE connection_id = ?1 AND source_id = ?2 AND source_hash = ?3`).bind(connection.id, resource.guid, sourceHash).first<{ target_attachment_id: string | null }>()
    const attachmentId = existing?.target_attachment_id ?? (await persistAttachmentWithinQuota(env, { id: newId(), userId: connection.user_id, noteId: null, filename: resource.fileName, reportedMime: resource.mime, bytes: resource.data, createdAt: Date.now() })).id
    if (!existing?.target_attachment_id) await env.DB.prepare(`INSERT OR REPLACE INTO source_resources (connection_id, user_id, source_id, note_source_id, target_attachment_id, source_hash, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`).bind(connection.id, connection.user_id, resource.guid, source.guid, attachmentId, sourceHash, Date.now()).run()
    content = content.replaceAll(`/api/files/by-source/${encodeURIComponent(resource.bodyHash ?? '')}`, `/api/files/${attachmentId}`)
  }
  const hash = await sha256Hex(content)
  const mapping = await env.DB.prepare(`SELECT target_id, synced_target_hash, conflict_target_id FROM source_items WHERE connection_id = ?1 AND source_type = 'note' AND source_id = ?2`).bind(connection.id, source.guid).first<{ target_id: string | null; synced_target_hash: string | null; conflict_target_id: string | null }>()
  if (mapping?.conflict_target_id) return 'skipped'
  if (!mapping?.target_id) {
    const noteId = newId(); const now = Date.now(); const title = source.title.slice(0, 512) || 'Untitled'
    const counts = countText(content)
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO notes (id, user_id, folder_id, title, title_key, content, excerpt, rev, word_count, char_count, position, content_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, '', ?5, ?6, 1, ?7, ?8, 0, ?9, ?10, ?10)`).bind(noteId, connection.user_id, connection.root_folder_id, title, content, deriveExcerpt(content), counts.words, counts.chars, hash, now),
      ...buildNoteDerivedStatements({ db: env.DB, userId: connection.user_id, noteId, title, content, ftsEnabled: true, expectedRev: 1, expectedContentHash: hash, expectedTitle: title, expectedUpdatedAt: now }).statements,
      env.DB.prepare(`INSERT INTO changes (user_id, entity, entity_id, op, at) VALUES (?1, 'note', ?2, 'upsert', ?3)`).bind(connection.user_id, noteId, now),
      env.DB.prepare(`INSERT INTO source_items (connection_id, user_id, source_type, source_id, target_id, source_version, source_hash, synced_target_hash, updated_at) VALUES (?1, ?2, 'note', ?3, ?4, ?5, ?6, ?6, ?7)`).bind(connection.id, connection.user_id, source.guid, noteId, source.updateSequenceNum, hash, now),
    ])
    return 'created'
  }
  const row = await env.DB.prepare(`SELECT rev, title, content, content_hash FROM notes WHERE id = ?1 AND user_id = ?2`).bind(mapping.target_id, connection.user_id).first<{ rev: number; title: string; content: string; content_hash: string }>()
  if (!row) return 'skipped'
  if (mapping.synced_target_hash && row.content_hash !== mapping.synced_target_hash) {
    const conflictId = newId(); const now = Date.now(); const title = `[Conflict] ${source.title}`.slice(0, 512); const counts = countText(content)
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO notes (id, user_id, folder_id, title, title_key, content, excerpt, rev, word_count, char_count, position, content_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, '', ?5, ?6, 1, ?7, ?8, 0, ?9, ?10, ?10)`).bind(conflictId, connection.user_id, connection.root_folder_id, title, content, deriveExcerpt(content), counts.words, counts.chars, hash, now),
      ...buildNoteDerivedStatements({ db: env.DB, userId: connection.user_id, noteId: conflictId, title, content, ftsEnabled: true, expectedRev: 1, expectedContentHash: hash, expectedTitle: title, expectedUpdatedAt: now }).statements,
      env.DB.prepare(`INSERT INTO changes (user_id, entity, entity_id, op, at) VALUES (?1, 'note', ?2, 'upsert', ?3)`).bind(connection.user_id, conflictId, now),
      env.DB.prepare(`UPDATE source_items SET conflict_target_id = ?1, updated_at = ?2 WHERE connection_id = ?3 AND source_type = 'note' AND source_id = ?4`).bind(conflictId, now, connection.id, source.guid),
    ])
    return 'conflicts'
  }
  if (row.content_hash === hash && row.title === source.title) return 'skipped'
  const now = Date.now(); const nextRev = row.rev + 1; const counts = countText(content)
  await env.DB.batch([
    env.DB.prepare(`UPDATE notes SET title = ?1, content = ?2, excerpt = ?3, word_count = ?4, char_count = ?5, content_hash = ?6, rev = ?7, updated_at = ?8 WHERE id = ?9 AND user_id = ?10 AND rev = ?11 AND content_hash = ?12`).bind(source.title.slice(0, 512) || row.title, content, deriveExcerpt(content), counts.words, counts.chars, hash, nextRev, now, mapping.target_id, connection.user_id, row.rev, row.content_hash),
    env.DB.prepare(`INSERT INTO note_versions (id, note_id, user_id, title, content, size, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`).bind(newId(), mapping.target_id, connection.user_id, row.title, row.content, new TextEncoder().encode(row.content).byteLength, now),
    ...buildNoteDerivedStatements({ db: env.DB, userId: connection.user_id, noteId: mapping.target_id, title: source.title.slice(0, 512) || row.title, content, ftsEnabled: true, expectedRev: nextRev, expectedContentHash: hash, expectedTitle: source.title.slice(0, 512) || row.title, expectedUpdatedAt: now }).statements,
    env.DB.prepare(`UPDATE source_items SET source_version = ?1, source_hash = ?2, synced_target_hash = ?2, updated_at = ?3 WHERE connection_id = ?4 AND source_type = 'note' AND source_id = ?5`).bind(source.updateSequenceNum, hash, now, connection.id, source.guid),
    env.DB.prepare(`INSERT INTO changes (user_id, entity, entity_id, op, at) VALUES (?1, 'note', ?2, 'upsert', ?3)`).bind(connection.user_id, mapping.target_id, now),
  ])
  return 'updated'
}

async function loadConnection(db: D1Database, userId: string, id: string): Promise<YinxiangConnectionRow | null> {
  return db.prepare(`SELECT sc.*, u.id AS account_id FROM source_connections sc LEFT JOIN users u ON u.id = sc.user_id WHERE sc.id = ?1 AND sc.user_id = ?2`).bind(id, userId).first<YinxiangConnectionRow>()
}

async function finish(db: D1Database, jobId: string, status: 'failed' | 'paused', detail: { error: string }): Promise<YinxiangSyncJobResult> {
  await db.prepare(`UPDATE sync_jobs SET status = ?1, error = ?2, finished_at = ?3 WHERE id = ?4`).bind(status, detail.error, Date.now(), jobId).run()
  return readJobResult(db, jobId)
}

async function readJobResult(db: D1Database, id: string): Promise<YinxiangSyncJobResult> {
  const row = await db.prepare(`SELECT id, status, processed, created_count, updated_count, skipped_count, conflict_count, failed_count, attachment_failed_count FROM sync_jobs WHERE id = ?1`).bind(id).first<any>()
  return { id, status: row?.status ?? 'failed', processed: row?.processed ?? 0, created: row?.created_count ?? 0, updated: row?.updated_count ?? 0, skipped: row?.skipped_count ?? 0, conflicts: row?.conflict_count ?? 0, failed: row?.failed_count ?? 0, attachmentFailed: row?.attachment_failed_count ?? 0 }
}

function parseJson<T>(raw: string, fallback: T): T { try { const value = JSON.parse(raw); return value as T } catch { return fallback } }
function nextRunAt(frequency: YinxiangConnectionRow['frequency'], hasMore: boolean): number | null { if (hasMore || frequency === 'manual') return hasMore ? Date.now() : null; return Date.now() + (frequency === 'daily' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000) }
