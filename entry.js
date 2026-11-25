/**
 * dsh-session-delete — permanently delete DSH sessions, one at a time or in bulk.
 *
 * !!! DANGER !!!
 * This plugin deliberately works around the documented persistence rule
 * "不删除会话文件 —— seam 无删除接口" (dsh-session-persistence-jsonl):
 * it removes the transcript directory and the projection-cache index entry
 * itself, from the host process, with no undo.
 *
 * Scope of a delete:
 *   ~/.dsh/sessions/<cwd-encoded>/<session-id>/     (transcript, .jsonl.zstd)
 *   ~/.dsh/storages/session_projcache/sessions/<session-id>.json  (list index)
 *   the Workspace ledger entry (workspace.json `sessionIds`)
 *   the archive and pin flags for the same id
 *   the live Host objects, when the Session is still resident (see below)
 *
 * Why the live objects matter: `session/list` is built from persistence plus
 * `ctx.sessions.list()`, so a Session that is still resident in the Host —
 * every Session the user opened in this app run — keeps producing a sidebar
 * row even after its files are gone. A page refresh does not restart the
 * Host, so the row survived until the whole app restarted. Deletion therefore
 * stops and detaches the resident Agent/Session first, which is what makes
 * the row disappear on the next refresh.
 *
 * Two browser surfaces share the one deletion path below (`deleteOne`), so they
 * cannot drift apart:
 *   - the Session row menu   POST /plugins/session-delete/delete        one id
 *   - the bulk-delete dialog POST /plugins/session-delete/delete-batch  many ids
 * The bulk dialog also reads GET /plugins/session-delete/sessions for the size
 * and creation-time columns the sidebar projection does not carry.
 *
 * Attachment objects under ~/.dsh/attachments are content addressed and are
 * intentionally left alone.
 *
 * Design notes:
 *   - No imports beyond Node builtins, so the plugin cannot fail to resolve
 *     anything from the DSH install's dependency tree.
 *   - `apply` never throws: a broken plugin must not be able to stop the host
 *     from booting. With DSH_SESSION_DELETE_DEBUG=1 set, a boot marker is
 *     written to the OS temp dir so a load can be verified from outside the app.
 *   - There is no command surface: both entries are browser UI, so a session
 *     that is mid-turn is refused by the single-row route and skipped by the
 *     batch route rather than being cancelled from a terminal.
 *   - Teardown only uses documented service objects plus a guarded fallback to
 *     their internal entry maps; every step is optional and logged, so a
 *     composition that lacks one still deletes the files.
 *
 * @module dsh-session-delete
 */
import { appendFile, readdir, readFile, rm, stat } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

export const name = 'session-delete'
// The service must be declared: cordis then holds apply() until it exists.
// Resolving `webServer` lazily instead made boot order matter — on a cold start
// apply() ran before the server was registered, the routes were skipped, and the
// menu buttons silently answered 404.
export const inject = ['webServer']

/** Route the sidebar row menu posts to; owned by this plugin, nothing else. */
const ROUTE_PATH = '/plugins/session-delete/delete'

/** Route the bulk-delete dialog posts its whole selection to, in one request. */
const ROUTE_BATCH_PATH = '/plugins/session-delete/delete-batch'

/** Route the bulk-delete dialog reads its size and creation-time columns from. */
const ROUTE_CATALOG_PATH = '/plugins/session-delete/sessions'

/** Upper bound on one bulk request, so a single call cannot stall the Host. */
const BATCH_LIMIT = 500

/** This plugin's context, kept so late lookups see services registered after apply(). */
let hostContext

/** The web server service of the running composition. */
function resolveWebServer(ctx = hostContext) {
  try {
    if (typeof ctx?.get === 'function') {
      const resolved = ctx.get('webServer')
      if (resolved !== undefined) return resolved
    }
  }
  catch {
    /* service not registered in this composition */
  }
  return ctx?.webServer
}

/**
 * The Workspace registry of the running composition, resolved at call time.
 *
 * It is deliberately not part of `inject`: a composition without it must still
 * get deletion, and a missing service must never keep apply() from running.
 */
function resolveWorkspaceRegistry(ctx = hostContext) {
  try {
    if (typeof ctx?.get === 'function') {
      const resolved = ctx.get('workspaceRegistry')
      if (resolved !== undefined) return resolved
    }
  }
  catch {
    /* service not registered in this composition */
  }
  return ctx?.workspaceRegistry
}

/** A named service, or undefined when the composition does not provide it. */
function service(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') {
      const resolved = ctx.get(name)
      if (resolved !== undefined) return resolved
    }
  }
  catch {
    /* service not registered in this composition */
  }
  return ctx?.[name]
}

// Module-scope trace: proves this entry's import succeeded even when a missing
// service keeps apply() from ever being called. Off by default so an ordinary
// install writes nothing outside the Harness home; set DSH_SESSION_DELETE_DEBUG=1
// to opt in.
const DEBUG = process.env.DSH_SESSION_DELETE_DEBUG !== undefined && process.env.DSH_SESSION_DELETE_DEBUG !== ''
const MARKER = path.join(tmpdir(), 'dsh-session-delete.applied')
if (DEBUG) {
  try {
    appendFileSync(
      MARKER,
      `${new Date().toISOString()} imported pid=${process.pid} home=${process.env.DSH_HOME ?? '?'}\n`,
    )
  }
  catch {
    /* diagnostic only */
  }
}

/** Host home directory: the same value the persistence seam resolves. */
function dshHome() {
  const configured = (process.env.DSH_HOME ?? '').trim()
  return configured.length > 0 ? configured : path.join(homedir(), '.dsh')
}

function paths() {
  const home = dshHome()
  return {
    home,
    sessionsRoot: path.join(home, 'sessions'),
    metaRoot: path.join(home, 'storages', 'session_projcache', 'sessions'),
  }
}

/** Best-effort marker so an external observer can tell the plugin was applied. */
async function writeBootMarker() {
  if (!DEBUG) return
  try {
    const file = path.join(tmpdir(), 'dsh-session-delete.applied')
    await appendFile(file, `${new Date().toISOString()} applied pid=${process.pid} home=${dshHome()}\n`)
  }
  catch {
    /* the marker is diagnostic only */
  }
}

/** Append one diagnostic line; never throws. */
function trace(text) {
  if (!DEBUG) return
  try {
    appendFileSync(MARKER, `${new Date().toISOString()} ${text}\n`)
  }
  catch {
    /* diagnostic only */
  }
}

/** Map session id -> transcript directory, one filesystem walk. */
async function indexTranscriptDirs(sessionsRoot) {
  const found = new Map()
  let projects
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  }
  catch {
    return found
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = path.join(sessionsRoot, project.name)
    let entries
    try {
      entries = await readdir(projectDir, { withFileTypes: true })
    }
    catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('session-')) {
        found.set(entry.name, path.join(projectDir, entry.name))
      }
    }
  }
  return found
}

/** Read every projection-cache entry, tolerating unreadable ones. */
async function readSessions() {
  const { metaRoot, sessionsRoot } = paths()
  const dirs = await indexTranscriptDirs(sessionsRoot)
  let names
  try {
    names = await readdir(metaRoot)
  }
  catch {
    return []
  }
  const sessions = []
  for (const fileName of names) {
    if (!fileName.startsWith('session-') || !fileName.endsWith('.json')) continue
    const id = fileName.slice(0, -'.json'.length)
    const metaPath = path.join(metaRoot, fileName)
    let record
    try {
      record = JSON.parse(await readFile(metaPath, 'utf8'))
    }
    catch {
      continue
    }
    const rows = record?.record?.rows ?? {}
    const title = rows?.title?.val
      ?? rows?.titleInput?.val?.first?.text
      ?? '(空会话)'
    const dirPath = dirs.get(id) ?? null
    let bytes = 0
    if (dirPath) {
      try {
        const inner = await readdir(dirPath, { withFileTypes: true })
        for (const file of inner) {
          if (file.isFile()) bytes += (await stat(path.join(dirPath, file.name))).size
        }
      }
      catch {
        /* size is cosmetic */
      }
    }
    sessions.push({
      id,
      title: String(title),
      cwd: record?.record?.identity?.cwd ?? '?',
      createdAt: Number(record?.record?.identity?.createdAt) || 0,
      turns: Number(rows?.sessionStats?.val?.turns) || 0,
      bytes,
      metaPath,
      dirPath,
    })
  }
  sessions.sort((a, b) => a.createdAt - b.createdAt)
  return sessions
}

/**
 * Human byte size, shared by the single-row route's notice and the bulk
 * route's one-line notice.
 * @param bytes - byte count, possibly zero.
 * @returns a short human-readable size.
 */
function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${Math.round(bytes)} B`
}

/** The live Session object of this Host, when the id is still resident. */
function liveSession(id) {
  try {
    return service(hostContext, 'sessions')?.get?.(id)
  }
  catch {
    return undefined
  }
}

/** The live Agent of this Host, when the id is still resident. */
function liveAgent(id) {
  try {
    return service(hostContext, 'agents')?.get?.(id)
  }
  catch {
    return undefined
  }
}

/** Best-effort display title for a live Session, read from its projections. */
function liveTitle(session) {
  try {
    const snapshot = service(hostContext, 'sessionProjections')?.snapshot?.(session)
    const title = snapshot?.values?.title
    if (typeof title === 'string' && title.trim().length > 0) return title.trim()
  }
  catch {
    /* projection service absent */
  }
  return '(标题未知)'
}

/** Resolve one deletable target, including a Session whose cache row is gone. */
async function findTarget(id) {
  const listed = (await readSessions()).find((session) => session.id === id)
  if (listed !== undefined) return listed
  const session = liveSession(id) ?? liveAgent(id)?.session
  if (session === undefined) return undefined
  const header = session?.header ?? {}
  const dirs = await indexTranscriptDirs(paths().sessionsRoot)
  return {
    id,
    title: liveTitle(session),
    cwd: header.cwd ?? '?',
    createdAt: Number(header.createdAt) || 0,
    turns: 0,
    bytes: 0,
    metaPath: path.join(paths().metaRoot, `${id}.json`),
    dirPath: dirs.get(id) ?? null,
  }
}

/**
 * Stop and detach one resident Session so the Host stops listing it.
 *
 * The transcript directory can be removed while the Session is live, but the
 * Host keeps rebuilding the row from memory: `session/list` merges persistence
 * with `ctx.sessions.list()`. A page refresh never restarts the Host, so the
 * row came back. This closes the write handle, cancels running work, and
 * detaches both registry entries — the same removals the loop's own teardown
 * performs, minus the parts only its owner holds.
 * @param id - the Session being deleted.
 * @returns a short description of what was torn down, for the reply text.
 */
async function teardownLive(id) {
  const done = []
  const agent = liveAgent(id)
  if (agent !== undefined) {
    try {
      if (agent.status === 'running') {
        await agent.cancel({ kind: 'user' })
        done.push('已停止运行')
      }
      if (typeof agent.whenIdle === 'function') {
        await Promise.race([
          agent.whenIdle(),
          new Promise((resolve) => { setTimeout(resolve, 5000).unref?.() }),
        ])
      }
    }
    catch (error) {
      trace(`cancel-failed ${id} ${String(error?.message ?? error)}`)
    }
  }

  // Close the write handle first: a live writer would otherwise recreate the
  // transcript (and its projection row) after the files are gone.
  try {
    const persistence = service(hostContext, 'sessionPersistence')
    const writer = persistence?.tracker?.writers?.get?.(id)
    // The tracker stores `null` while a write is claimed; only a real handle closes.
    if (writer != null && typeof writer.close === 'function') {
      await writer.close()
      done.push('已关闭写入')
    }
  }
  catch (error) {
    trace(`close-failed ${id} ${String(error?.message ?? error)}`)
  }

  // Drop the Agent registry entry (emits `agent/disposed`, which the Session
  // controller uses to retire list summaries).
  try {
    const agents = service(hostContext, 'agents')
    const entry = agents?.store?.get?.(id) ?? agents?.entries?.get?.(id)
    if (entry !== undefined) {
      if (typeof agents.detachEntered === 'function') agents.detachEntered(entry)
      else if (typeof entry.detach === 'function') entry.detach()
      done.push('已卸载 Agent')
    }
  }
  catch (error) {
    trace(`detach-agent-failed ${id} ${String(error?.message ?? error)}`)
  }

  // Drop the Session store entry: this is the step that removes the row.
  try {
    const sessions = service(hostContext, 'sessions')
    const session = sessions?.get?.(id)
    let entry
    if (session !== undefined && typeof sessions.liveEntryFor === 'function') {
      try { entry = sessions.liveEntryFor(session) } catch { /* not live */ }
    }
    entry ??= sessions?.store?.get?.(id)
    if (entry !== undefined) {
      if (typeof sessions.detachEntered === 'function') sessions.detachEntered(entry)
      else if (typeof entry.detach === 'function') entry.detach()
      done.push('已移出会话表')
    }
  }
  catch (error) {
    trace(`detach-session-failed ${id} ${String(error?.message ?? error)}`)
  }

  if (done.length > 0) trace(`teardown ${id} ${done.join(',')}`)
  return done
}

/** Whether the Host would still list this Session after the teardown. */
async function stillListed(id) {
  try {
    const query = service(hostContext, 'sessionQuery')
    if (typeof query?.listSessions !== 'function') return undefined
    const records = await query.listSessions()
    return records.some((record) => record?.header?.id === id)
  }
  catch {
    return undefined
  }
}

/**
 * Drop a removed session from the Workspace ledger.
 *
 * The sidebar reads each Workspace's recorded `sessionIds`, not the disk, so the
 * transcript disappearing is not enough: the ledger entry has to go too, or the
 * row survives a page reload and only vanishes on the next Host restart.
 * @param registry - the Workspace registry, when the composition provides it.
 * @param sessionId - the session that no longer exists on disk.
 * @returns whether a ledger entry was actually removed.
 */
async function forgetInWorkspaces(registry, sessionId) {
  if (registry === undefined || registry === null) {
    trace(`forget-skipped ${sessionId} registry=missing`)
    return false
  }
  let detached = false

  try {
    for (const workspace of registry.list()) {
      const ids = workspace?.record?.sessionIds
      if (Array.isArray(ids) && ids.includes(sessionId)) {
        await workspace.detachSession(sessionId)
        detached = true
      }
    }
  }
  catch (error) {
    trace(`detach-failed ${sessionId} ${String(error?.message ?? error)}`)
  }

  // No header-index rebuild here on purpose: `detachSession` above already drops
  // the id from the durable account, which is what the `sessionIds` getter reads.
  // `replaceHeaderIndex` is an internal startup helper without the registry's
  // write lock, and it clears the live-session path index, so sessions created
  // before their first flush could disappear from their Workspace until restart.

  // A removed session must not keep its archive or pin flag in the same record.
  const flagged = (value) => {
    if (value === undefined || value === null) return false
    try {
      return typeof value.has === 'function' ? value.has(sessionId) : Array.from(value).includes(sessionId)
    }
    catch {
      return false
    }
  }
  for (const [flag, method] of [['archivedSessionIds', 'unarchiveSession'], ['pinnedSessionIds', 'unpinSession']]) {
    if (!flagged(registry[flag])) continue
    try {
      if (typeof registry[method] === 'function') await registry[method](sessionId)
    }
    catch (error) {
      trace(`${method}-failed ${sessionId} ${String(error?.message ?? error)}`)
    }
  }

  trace(`forgot ${sessionId} detached=${detached}`)
  return detached
}

/** Remove one session's transcript directory and list index, then read them back. */
async function deleteOne(target, registry) {
  // Stop the resident copies first, so nothing rewrites what is about to go.
  const teardown = await teardownLive(target.id)

  const removed = []
  try {
    if (target.dirPath) {
      await rm(target.dirPath, { recursive: true, force: true })
      removed.push(target.dirPath)
    }
    await rm(target.metaPath, { force: true })
    removed.push(target.metaPath)
  }
  catch (error) {
    return {
      kind: 'error',
      text: `删除失败（可能被运行中的进程占用）：${error?.message ?? error}\n已删除：${removed.join('\n') || '（无）'}`,
    }
  }

  // Read back: never claim success without confirming the bytes are gone.
  const remaining = []
  for (const file of [target.dirPath, target.metaPath]) {
    if (!file) continue
    try {
      await stat(file)
      remaining.push(file)
    }
    catch {
      /* gone, as intended */
    }
  }
  if (remaining.length > 0) {
    return { kind: 'error', text: `删除未完成，仍存在：\n${remaining.join('\n')}` }
  }

  // The files are gone; the Workspace ledger still lists the session until it is
  // told, and the sidebar reads that ledger.
  const forgotten = await forgetInWorkspaces(registry, target.id)

  // Detaching a resident Session flushes its projections one last time, which
  // can write the cache row back. Sweep once more after every observer is gone.
  for (const file of [target.dirPath, target.metaPath]) {
    if (file) await rm(file, { recursive: true, force: true }).catch(() => {})
  }

  // Ask the Host what it would list now: that is exactly what the sidebar shows.
  const listed = await stillListed(target.id)

  const lines = [
    `已彻底删除「${target.title}」（${target.id}）。`,
    `  收回空间：${formatSize(target.bytes)}`,
  ]
  if (teardown.length > 0) lines.push(`  ${teardown.join('，')}。`)
  if (listed === false) lines.push('  已从会话列表移除。')
  else if (listed === true) lines.push('  文件已删除，但 Host 仍把它留在内存里；重启 DeepSeek Harness 后侧栏才会消失。')
  else lines.push(forgotten ? '  已从项目列表中移除。' : '  文件已删除；若侧栏仍在，重启 DeepSeek Harness。')

  // `text` is the multi-line detail; `notice` is the one-line form the browser
  // shows in its transient toast. The batch route reports its own summary.
  const notice = listed === true
    ? `已删除「${target.title}」，重启后从会话列表消失`
    : `已删除「${target.title}」`

  return { kind: 'success', text: lines.join('\n'), notice }
}

// ---------------------------------------------------------------------------
// HTTP plumbing shared by the three routes below.
//
// None of these routes is fenced by the `/api` Connection admission, so each one
// protects itself: a JSON media type is the anti-CSRF fence (simple form posts
// cannot set it, and a cross-origin `application/json` request needs a preflight
// this server never approves), and every id is checked against the path-safe
// shape below before it is ever joined into a path.
// ---------------------------------------------------------------------------

/** Session ids are single path-safe tokens; nothing else may reach `path.join`. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Whether one string may be used verbatim as a Session id in a filesystem path. */
function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value) && !value.includes('..')
}

/** Complete one JSON response with the headers these routes always send. */
function answerJson(res, status, payload, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(JSON.stringify(payload))
}

/**
 * Read and parse one JSON request body.
 * @param req - the incoming request.
 * @param limit - maximum accepted body size in bytes.
 * @returns the parsed object, or an error message for the caller to answer.
 */
async function readJsonBody(req, limit) {
  let body = ''
  req.setEncoding?.('utf8')
  for await (const chunk of req) {
    body += chunk
    if (Buffer.byteLength(body, 'utf8') > limit) throw new Error('请求体过大')
  }
  const parsed = JSON.parse(body || '{}')
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  return parsed
}

/** Answer a method or media-type rejection; both routes answer identically. */
function rejectUnlessWritable(req, res) {
  if (req.method !== 'POST') {
    answerJson(res, 405, { ok: false, text: '只接受 POST。' }, { allow: 'POST' })
    return true
  }
  const contentType = String(req.headers?.['content-type'] ?? '')
  if (!/^application\/json\s*(?:;|$)/i.test(contentType)) {
    answerJson(res, 415, { ok: false, text: '请求必须使用 application/json。' })
    return true
  }
  return false
}

/**
 * Answer `POST /plugins/session-delete/delete` for the sidebar row menu.
 *
 * The handler accepts one JSON body `{ id }`, matches it as an exact session id
 * only, and answers `{ ok, text, title? }`.
 * @param req - the incoming request.
 * @param res - the response to complete.
 */
async function handleDeleteRequest(req, res) {
  if (rejectUnlessWritable(req, res)) return

  let id = ''
  try {
    const body = await readJsonBody(req, 4096)
    id = String(body.id ?? '').trim()
  }
  catch (error) {
    answerJson(res, 400, { ok: false, text: `无法解析请求：${error?.message ?? error}` })
    return
  }
  if (id.length === 0) {
    answerJson(res, 400, { ok: false, text: '缺少会话 id。' })
    return
  }
  if (!isSessionId(id)) {
    answerJson(res, 400, { ok: false, text: '会话 id 不合法。' })
    return
  }

  try {
    const target = await findTarget(id)
    if (target === undefined) {
      answerJson(res, 404, { ok: false, text: '这条会话已经不存在了，刷新页面即可。' })
      return
    }
    // Refuse a turn in flight: tearing the Agent down mid-request would leave
    // the conversation it is answering in a half-written state.
    if (liveAgent(id)?.status === 'running') {
      answerJson(res, 409, { ok: false, text: '这条会话正在运行，请先停止再删除。' })
      return
    }
    const result = await deleteOne(target, resolveWorkspaceRegistry())
    answerJson(res, result.kind === 'success' ? 200 : 500, {
      ok: result.kind === 'success',
      text: result.text,
      ...(result.notice === undefined ? {} : { notice: result.notice }),
      title: target.title,
      id: target.id,
    })
  }
  catch (error) {
    answerJson(res, 500, { ok: false, text: `删除失败：${error?.message ?? error}` })
  }
}

/**
 * Answer `POST /plugins/session-delete/delete-batch` for the bulk dialog.
 *
 * The body is `{ ids: string[] }`. Entries are deleted one at a time on purpose:
 * every delete ends with a Workspace-ledger write, and two of those racing would
 * interleave read-modify-write cycles on the same `workspace.json`.
 *
 * A Session whose Agent is running is *skipped*, not cancelled and not fatal:
 * the rest of the selection still goes, and the caller reports the skip. That is
 * the one place bulk and single-row deletion differ — the row menu refuses a
 * running Session outright, because there the user named exactly that one.
 *
 * The answer is `{ ok, deleted, skipped, failed, bytes, notice }`. `ok` means
 * the request itself was well formed and processed; per-item truth lives in the
 * three arrays, so a partial success is never flattened into a 500.
 * @param req - the incoming request.
 * @param res - the response to complete.
 */
async function handleDeleteBatchRequest(req, res) {
  if (rejectUnlessWritable(req, res)) return

  let ids = []
  try {
    // 500 ids of ~40 bytes each, with room for JSON punctuation.
    const body = await readJsonBody(req, 64 * 1024)
    if (!Array.isArray(body.ids)) throw new Error('缺少 ids 数组')
    ids = [...new Set(body.ids.map((value) => String(value ?? '').trim()).filter(Boolean))]
  }
  catch (error) {
    answerJson(res, 400, { ok: false, text: `无法解析请求：${error?.message ?? error}` })
    return
  }

  // Checked after parsing, so the message names the limit instead of being
  // reported as a malformed body.
  if (ids.length > BATCH_LIMIT) {
    answerJson(res, 400, { ok: false, text: `一次最多删除 ${BATCH_LIMIT} 条会话，请分批操作。` })
    return
  }

  const malformed = ids.filter((id) => !isSessionId(id))
  if (malformed.length > 0) {
    answerJson(res, 400, { ok: false, text: `会话 id 不合法：${malformed[0]}` })
    return
  }
  if (ids.length === 0) {
    answerJson(res, 400, { ok: false, text: '没有选中任何会话。' })
    return
  }

  const registry = resolveWorkspaceRegistry()
  const deleted = []
  const skipped = []
  const failed = []
  let bytes = 0

  for (const id of ids) {
    try {
      const target = await findTarget(id)
      if (target === undefined) {
        skipped.push({ id, title: id, reason: 'already-gone' })
        continue
      }
      if (liveAgent(id)?.status === 'running') {
        trace(`batch-skip-running ${id}`)
        skipped.push({ id, title: target.title, reason: 'running' })
        continue
      }
      const result = await deleteOne(target, registry)
      if (result.kind === 'success') {
        deleted.push({ id, title: target.title })
        bytes += Number(target.bytes) || 0
      }
      else failed.push({ id, title: target.title, reason: result.text })
    }
    catch (error) {
      // One bad Session must never abandon the rest of the selection.
      trace(`batch-failed ${id} ${String(error?.message ?? error)}`)
      failed.push({ id, title: id, reason: String(error?.message ?? error) })
    }
  }

  trace(`batch done deleted=${deleted.length} skipped=${skipped.length} failed=${failed.length}`)

  const parts = [`已删除 ${deleted.length} 条会话`]
  if (bytes > 0) parts[0] += `，收回 ${formatSize(bytes)}`
  if (skipped.length > 0) parts.push(`跳过 ${skipped.length} 条`)
  if (failed.length > 0) parts.push(`失败 ${failed.length} 条`)

  answerJson(res, 200, {
    ok: true,
    deleted,
    skipped,
    failed,
    bytes,
    notice: parts.join('，'),
  })
}

/**
 * Answer `GET /plugins/session-delete/sessions` for the bulk dialog's columns.
 *
 * The dialog shows what the Host lists, and this route only supplies the facts
 * the sidebar projection does not carry — creation time, size and turn count.
 * A read, so it accepts GET, and it never mutates anything.
 * @param req - the incoming request.
 * @param res - the response to complete.
 */
async function handleCatalogRequest(req, res) {
  if (req.method !== 'GET') {
    answerJson(res, 405, { ok: false, text: '只接受 GET。' }, { allow: 'GET' })
    return
  }
  try {
    const sessions = await readSessions()
    answerJson(res, 200, {
      ok: true,
      sessions: sessions.map((session) => ({
        id: session.id,
        title: session.title,
        cwd: session.cwd,
        createdAt: session.createdAt,
        turns: session.turns,
        bytes: session.bytes,
      })),
    })
  }
  catch (error) {
    answerJson(res, 500, { ok: false, text: `读取会话列表失败：${error?.message ?? error}` })
  }
}

/**
 * Register the three routes the browser halves post to.
 * @param ctx - context carrying the web server.
 */
export function apply(ctx) {
  try {
    hostContext = ctx
    void writeBootMarker()
    const webServer = resolveWebServer(ctx)
    const routes = [
      { kind: 'exact', path: ROUTE_PATH, handler: handleDeleteRequest },
      { kind: 'exact', path: ROUTE_BATCH_PATH, handler: handleDeleteBatchRequest },
      { kind: 'exact', path: ROUTE_CATALOG_PATH, handler: handleCatalogRequest },
    ]
    // A lifecycle effect yielding the disposers, so unload unregisters every
    // route instead of leaving handlers behind on a dead context.
    if (typeof ctx.effect === 'function') {
      ctx.effect(function* registerSurface() {
        if (webServer !== undefined) {
          for (const route of routes) yield webServer.register(route)
        }
      }, 'dsh-session-delete lifecycle')
    }
    else if (webServer !== undefined) {
      for (const route of routes) webServer.register(route)
    }
    trace(`registered pid=${process.pid} routes=${webServer === undefined ? 'none' : routes.map(route => route.path).join(',')}`)
  }
  catch (error) {
    // Never take the host down over a convenience plugin.
    trace(`apply-failed pid=${process.pid} ${String(error?.message ?? error)}`)
    console.error('[dsh-session-delete] apply failed:', error)
  }
}
