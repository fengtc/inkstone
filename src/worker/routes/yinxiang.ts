import { Hono } from 'hono'
import type { YinxiangConnectionInfo, YinxiangNotebook } from '@shared/types'
import type { AppBindings } from '../env'
import { requireAuth } from '../middleware/auth'
import { ApiError } from '../lib/errors'
import { sha256Hex } from '../lib/encoding'
import { newId } from '../lib/id'
import { encryptYinxiangCredential } from '../lib/crypto'
import { readJson } from '../lib/request'
import { authorizeEndpoint, oauthEndpoint, requestOAuthEndpoint, YinxiangClient, assertNoteStoreUrl } from '../yinxiang/client'
import { enqueueYinxiangSync, runYinxiangSync, runScheduledYinxiangSync, type YinxiangConnectionRow } from '../yinxiang/sync'

export const yinxiangRoutes = new Hono<AppBindings>()

yinxiangRoutes.get('/', requireAuth, async (c) => c.json(await loadInfo(c.env, c.get('userId'))))

yinxiangRoutes.post('/connect', requireAuth, async (c) => {
  const environment = c.env.YINXIANG_ENVIRONMENT === 'production' ? 'production' : 'sandbox'
  const consumerKey = c.env.YINXIANG_CONSUMER_KEY?.trim()
  const consumerSecret = c.env.YINXIANG_CONSUMER_SECRET?.trim()
  if (!consumerKey || !consumerSecret) return c.json({ configured: false, status: 'not_configured' as const })
  const origin = new URL(c.req.url).origin
  const state = newId()
  const callback = new URL(c.env.YINXIANG_CALLBACK_URL?.trim() || `${origin}/oauth/yinxiang/callback`)
  callback.searchParams.set('state', state)
  const stateHash = await sha256Hex(state)
  const temporary = await requestOAuthEndpoint(oauthEndpoint(environment), { consumerKey, consumerSecret }, { oauth_callback: callback.toString() }, fetch)
  if (!temporary.oauth_token) throw new ApiError(502, 'internal', 'Yinxiang did not return an OAuth request token')
  const now = Date.now()
  await c.env.DB.prepare(`INSERT INTO yinxiang_oauth_states (id, user_id, session_id, environment, callback_url, request_token, request_token_secret, state_hash, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`).bind(newId(), c.get('userId'), c.get('sessionId'), environment, callback.toString(), temporary.oauth_token, temporary.oauth_token_secret ?? '', stateHash, now + 10 * 60 * 1000, now).run()
  const redirect = new URL(authorizeEndpoint(environment))
  redirect.searchParams.set('oauth_token', temporary.oauth_token)
  return c.json({ configured: true, authorizationUrl: redirect.toString(), expiresAt: now + 10 * 60 * 1000 })
})

yinxiangRoutes.post('/settings', requireAuth, async (c) => {
  const body = await readJson<{ selectedNotebookGuids?: unknown; rootFolderId?: unknown; includeAttachments?: unknown; frequency?: unknown }>(c, 16 * 1024)
  const connection = await currentConnection(c.env.DB, c.get('userId'))
  if (!connection) throw ApiError.notFound('Yinxiang is not connected')
  const notebooks = parseJson<YinxiangNotebook[]>(connection.notebooks_json, [])
  const selected = body.selectedNotebookGuids === undefined ? parseJson<string[]>(connection.selected_notebook_guids, []) : validateSelected(body.selectedNotebookGuids, notebooks)
  const selectionChanged = JSON.stringify(selected) !== connection.selected_notebook_guids
  const rootFolderId = body.rootFolderId === undefined ? connection.root_folder_id : body.rootFolderId === null ? null : String(body.rootFolderId)
  if (rootFolderId) {
    const folder = await c.env.DB.prepare(`SELECT id FROM folders WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`).bind(rootFolderId, c.get('userId')).first()
    if (!folder) throw ApiError.badRequest('The target folder does not exist')
  }
  const includeAttachments = body.includeAttachments === undefined ? connection.include_attachments : body.includeAttachments === true ? 1 : body.includeAttachments === false ? 0 : (() => { throw ApiError.badRequest('includeAttachments must be a boolean') })()
  const frequency = body.frequency === undefined ? connection.frequency : body.frequency
  if (frequency !== 'manual' && frequency !== 'hourly' && frequency !== 'daily') throw ApiError.badRequest('frequency must be manual, hourly, or daily')
  await c.env.DB.prepare(`UPDATE source_connections SET selected_notebook_guids = ?1, root_folder_id = ?2, include_attachments = ?3, frequency = ?4, full_sync_before = CASE WHEN ?5 = 1 AND cursor > 0 THEN cursor ELSE full_sync_before END, next_run_at = CASE WHEN ?4 = 'manual' THEN NULL ELSE COALESCE(next_run_at, ?6) END, updated_at = ?6 WHERE id = ?7 AND user_id = ?8`).bind(JSON.stringify(selected), rootFolderId, includeAttachments, frequency, selectionChanged ? 1 : 0, Date.now(), connection.id, c.get('userId')).run()
  return c.json(await loadInfo(c.env, c.get('userId')))
})

yinxiangRoutes.post('/sync', requireAuth, async (c) => {
  const connection = await currentConnection(c.env.DB, c.get('userId'))
  if (!connection || connection.status === 'disconnected') throw ApiError.notFound('Yinxiang is not connected')
  const jobId = await enqueueYinxiangSync(c.env, c.get('userId'), connection.id, 'manual')
  c.executionCtx.waitUntil(runYinxiangSync(c.env, jobId).catch((error) => console.error('[inkstone] Yinxiang manual sync failed:', error)))
  return c.json({ jobId, status: 'queued' as const })
})

yinxiangRoutes.post('/pause', requireAuth, async (c) => { await setPaused(c.env.DB, c.get('userId'), true); return c.json(await loadInfo(c.env, c.get('userId'))) })
yinxiangRoutes.post('/resume', requireAuth, async (c) => { await setPaused(c.env.DB, c.get('userId'), false); return c.json(await loadInfo(c.env, c.get('userId'))) })
yinxiangRoutes.post('/retry', requireAuth, async (c) => {
  const connection = await currentConnection(c.env.DB, c.get('userId'))
  if (!connection) throw ApiError.notFound('Yinxiang is not connected')
  const jobId = await enqueueYinxiangSync(c.env, c.get('userId'), connection.id, 'retry')
  c.executionCtx.waitUntil(runYinxiangSync(c.env, jobId).catch(() => {}))
  return c.json({ jobId, status: 'queued' as const })
})

yinxiangRoutes.delete('/', requireAuth, async (c) => {
  await c.env.DB.prepare(`UPDATE source_connections SET status = 'disconnected', token_ciphertext = NULL, active_job_id = NULL, paused_at = ?1, updated_at = ?1 WHERE user_id = ?2 AND provider = 'yinxiang' AND status <> 'disconnected'`).bind(Date.now(), c.get('userId')).run()
  await c.env.DB.prepare(`UPDATE sync_jobs SET status = 'paused', finished_at = ?1, error = 'Connection disconnected' WHERE user_id = ?2 AND status IN ('queued', 'running')`).bind(Date.now(), c.get('userId')).run()
  return c.json({ ok: true })
})

export const yinxiangCallbackRoutes = new Hono<AppBindings>()
yinxiangCallbackRoutes.get('/', async (c) => {
  const token = c.req.query('oauth_token')
  const verifier = c.req.query('oauth_verifier')
  const stateParam = c.req.query('state')
  if (!token || !c.get('userId') || !c.get('sessionId')) return new Response('Yinxiang authorization session expired. Return to Inkstone and try again.', { status: 400 })
  const state = await c.env.DB.prepare(`SELECT * FROM yinxiang_oauth_states WHERE request_token = ?1 AND expires_at > ?2 AND consumed_at IS NULL`).bind(token, Date.now()).first<{ id: string; user_id: string; session_id: string; environment: 'sandbox' | 'production'; callback_url: string; request_token_secret: string; state_hash: string }>()
  if (!state || state.user_id !== c.get('userId') || state.session_id !== c.get('sessionId') || !stateParam || !(await sha256Hex(stateParam) === state.state_hash)) return new Response('Yinxiang authorization binding is invalid.', { status: 400 })
  await c.env.DB.prepare(`UPDATE yinxiang_oauth_states SET consumed_at = ?1 WHERE id = ?2 AND consumed_at IS NULL`).bind(Date.now(), state.id).run()
  if (!verifier) return Response.redirect(`${new URL(c.req.url).origin}/?yinxiang=authorization-denied`, 303)
  const consumerKey = c.env.YINXIANG_CONSUMER_KEY?.trim(); const consumerSecret = c.env.YINXIANG_CONSUMER_SECRET?.trim()
  if (!consumerKey || !consumerSecret) return Response.redirect(`${new URL(c.req.url).origin}/?yinxiang=not-configured`, 303)
  const access = await requestOAuthEndpoint(oauthEndpoint(state.environment), { consumerKey, consumerSecret, token, tokenSecret: state.request_token_secret }, { oauth_verifier: verifier }, fetch)
  if (!access.oauth_token || !access.edam_userId || !access.edam_noteStoreUrl) return new Response('Yinxiang authorization response is incomplete.', { status: 502 })
  assertNoteStoreUrl(access.edam_noteStoreUrl, state.environment)
  const encrypted = await encryptYinxiangCredential(c.env, state.user_id, { oauthToken: access.oauth_token, oauthTokenSecret: access.oauth_token_secret ?? '' })
  const existing = await c.env.DB.prepare(`SELECT id FROM source_connections WHERE user_id = ?1 AND provider = 'yinxiang' AND environment = ?2 AND source_account_id = ?3`).bind(state.user_id, state.environment, access.edam_userId).first<{ id: string }>()
  const connectionId = existing?.id ?? newId(); const now = Date.now()
  const client = new YinxiangClient({ environment: state.environment, consumerKey, consumerSecret, token: access.oauth_token, tokenSecret: access.oauth_token_secret ?? '', noteStoreUrl: access.edam_noteStoreUrl })
  let notebooks: YinxiangNotebook[] = []; let scopes = ['notes.read']
  let status = 'connected'; let error: string | null = null
  try { await client.getSyncState(); scopes = ['notes.read']; notebooks = (await client.listNotebooks()).map((item) => ({ ...item, canRead: true })); scopes.push('notebooks.read') } catch (probeError) { status = 'reauthorization_required'; error = probeError instanceof Error ? probeError.message : 'Unable to verify Yinxiang access scope' }
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE source_connections SET status = 'disconnected', token_ciphertext = NULL, active_job_id = NULL, updated_at = ?1 WHERE user_id = ?2 AND provider = 'yinxiang' AND id <> ?3 AND status NOT IN ('disconnected', 'not_connected')`).bind(now, state.user_id, connectionId),
    existing
      ? c.env.DB.prepare(`UPDATE source_connections SET note_store_url = ?1, authorized_scopes = ?2, notebooks_json = ?3, token_ciphertext = ?4, token_expires_at = ?5, account_label = ?6, status = ?7, last_error = ?8, paused_at = NULL, updated_at = ?9 WHERE id = ?10 AND user_id = ?11`).bind(access.edam_noteStoreUrl, JSON.stringify(scopes), JSON.stringify(notebooks), encrypted, Number(access.edam_expires) || null, access.edam_userId, status, error, now, connectionId, state.user_id)
      : c.env.DB.prepare(`INSERT INTO source_connections (id, user_id, provider, environment, source_account_id, account_label, note_store_url, authorized_scopes, notebooks_json, token_ciphertext, token_expires_at, status, created_at, updated_at) VALUES (?1, ?2, 'yinxiang', ?3, ?4, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`).bind(connectionId, state.user_id, state.environment, access.edam_userId, access.edam_noteStoreUrl, JSON.stringify(scopes), JSON.stringify(notebooks), encrypted, Number(access.edam_expires) || null, status, now),
  ])
  return Response.redirect(`${new URL(c.req.url).origin}/?yinxiang=connected`, 303)
})

export async function runYinxiangScheduledTasks(env: AppBindings['Bindings']): Promise<void> { await runScheduledYinxiangSync(env) }

async function loadInfo(env: AppBindings['Bindings'], userId: string): Promise<{ configured: boolean; connection: YinxiangConnectionInfo | null }> {
  const configured = Boolean(env.YINXIANG_CONSUMER_KEY && env.YINXIANG_CONSUMER_SECRET)
  const row = await currentConnection(env.DB, userId)
  return { configured, connection: row ? toInfo(row) : null }
}

async function currentConnection(db: D1Database, userId: string): Promise<YinxiangConnectionRow | null> { return db.prepare(`SELECT * FROM source_connections WHERE user_id = ?1 AND provider = 'yinxiang' AND status <> 'disconnected' ORDER BY updated_at DESC LIMIT 1`).bind(userId).first<YinxiangConnectionRow>() }
async function setPaused(db: D1Database, userId: string, paused: boolean): Promise<void> { await db.prepare(`UPDATE source_connections SET status = ?1, paused_at = ?2, updated_at = ?3 WHERE user_id = ?4 AND provider = 'yinxiang' AND status <> 'disconnected'`).bind(paused ? 'paused' : 'connected', paused ? Date.now() : null, Date.now(), userId).run() }
function validateSelected(value: unknown, notebooks: YinxiangNotebook[]): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw ApiError.badRequest('selectedNotebookGuids must be an array of strings'); const allowed = new Set(notebooks.filter((item) => item.canRead).map((item) => item.guid)); const selected = value as string[]; if (selected.some((guid) => !allowed.has(guid))) throw ApiError.badRequest('A selected notebook is outside the authorized scope'); return [...new Set(selected)] }
function toInfo(row: YinxiangConnectionRow): YinxiangConnectionInfo { return { id: row.id, provider: 'yinxiang', environment: row.environment, status: row.status as YinxiangConnectionInfo['status'], accountId: row.account_id, accountLabel: row.account_label, tokenExpiresAt: row.token_expires_at, authorizedScopes: parseJson(row.authorized_scopes, []), notebooks: parseJson(row.notebooks_json, []), selectedNotebookGuids: parseJson(row.selected_notebook_guids, []), rootFolderId: row.root_folder_id, includeAttachments: row.include_attachments === 1, frequency: row.frequency, lastSuccessAt: row.last_success_at, nextRunAt: row.next_run_at, lastError: row.last_error, syncStats: { discovered: 0, processed: 0, created: 0, updated: 0, skipped: 0, conflicts: 0, failed: 0, attachmentFailed: 0 }, activeJobId: row.active_job_id, pausedAt: row.paused_at, updatedAt: row.updated_at } }
function parseJson<T>(raw: string, fallback: T): T { try { return JSON.parse(raw) as T } catch { return fallback } }
