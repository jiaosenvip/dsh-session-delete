/**
 * Smoke test for the Host half of `dsh-session-delete`.
 *
 * Runs the real `entry.js` against a throwaway `DSH_HOME` holding fabricated
 * Session directories, projection-cache rows and a fake Workspace registry, then
 * drives the three HTTP handlers exactly as the browser does. Nothing here mocks
 * the deletion path itself: the point is to prove that the files really go, that
 * a running Session is skipped instead of aborting the batch, and that the
 * Workspace ledger is told.
 *
 * Run with: node test/host-smoke.mjs
 *
 * This directory is not in package.json `files`, so it never ships.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** One fabricated Session plus everything the plugin reads about it. */
function sessionFixture({ id, title, cwd, createdAt, bytes = 128 }) {
  return { id, title, cwd, createdAt, bytes }
}

/** Materialize one Session the way DSH lays it out on disk. */
async function writeSession(home, fixture) {
  const projectDir = path.join(home, 'sessions', encodeURIComponent(fixture.cwd))
  const dir = path.join(projectDir, fixture.id)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(fixture.bytes, 7))

  const metaDir = path.join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(metaDir, { recursive: true })
  await writeFile(path.join(metaDir, `${fixture.id}.json`), JSON.stringify({
    record: {
      rows: { title: { val: fixture.title }, sessionStats: { val: { turns: 2 } } },
      identity: { cwd: fixture.cwd, createdAt: fixture.createdAt },
    },
  }))
}

/** Whether a filesystem entry exists. */
async function exists(target) {
  try {
    await stat(target)
    return true
  }
  catch {
    return false
  }
}

/**
 * One fake request: an async iterable body plus the headers the handlers read.
 * @param options - method and JSON body.
 * @returns the request object.
 */
function fakeRequest({ method, body }) {
  const text = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    headers: { 'content-type': 'application/json' },
    setEncoding() {},
    async* [Symbol.asyncIterator]() {
      if (text !== '') yield text
    },
  }
}

/** One fake response capturing status, headers and body. */
function fakeResponse() {
  const captured = { status: 0, headers: {}, body: '' }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(chunk) {
      captured.body = chunk ?? ''
    },
    /** Parsed JSON body. */
    get json() {
      return JSON.parse(captured.body)
    },
  }
}

/**
 * A Workspace registry stand-in: records what the plugin asks it to forget.
 *
 * The shape mirrors the real entity closely enough for `forgetInWorkspaces`: it
 * reads `workspace.record.sessionIds` to decide whether a Workspace accounts for
 * the Session, then calls `detachSession`, and it exposes the two flag sets so
 * the archive and pin cleanup is observable rather than assumed.
 * @param membership - Sessions the fake Workspace accounts for.
 * @param flags - ids to seed into the archive and pin sets.
 * @returns the registry plus live views of its state.
 */
function fakeRegistry(membership, flags = { archived: [], pinned: [] }) {
  const state = { sessionIds: [...membership] }
  const archived = new Set(flags.archived)
  const pinned = new Set(flags.pinned)
  const workspace = {
    get record() { return { sessionIds: state.sessionIds } },
    async detachSession(id) {
      state.sessionIds = state.sessionIds.filter((value) => value !== id)
    },
  }
  return {
    registry: {
      list: () => [workspace],
      archivedSessionIds: archived,
      pinnedSessionIds: pinned,
      async unarchiveSession(id) { archived.delete(id) },
      async unpinSession(id) { pinned.delete(id) },
    },
    get sessionIds() { return [...state.sessionIds] },
    get archivedSessionIds() { return [...archived] },
    get pinnedSessionIds() { return [...pinned] },
  }
}

/**
 * Load the plugin's `apply` against a stub context and collect its routes.
 * @param options - the Workspace registry and the running Agent ids.
 * @returns `{ routes, commands }` keyed by route path.
 */
async function loadPlugin({ registry, running = [] }) {
  const entry = await import(pathToFileURL(path.resolve('entry.js')).href)
  const routes = new Map()
  const commands = []
  const ctx = {
    // The command surface was removed; keep the stub so a re-introduced
    // `ctx.commands.register` is caught by the assertion below instead of
    // silently succeeding.
    commands: { register: (definition) => { commands.push(definition); return () => {} } },
    get(name) {
      if (name === 'webServer') {
        return { register: (route) => { routes.set(route.path, route.handler); return () => {} } }
      }
      if (name === 'workspaceRegistry') return registry
      if (name === 'agents') {
        return {
          get: (id) => (running.includes(id) ? { status: 'running', cancel: async () => {} } : undefined),
        }
      }
      return undefined
    },
    effect(callback, label) {
      const iterator = callback()
      for (const disposer of iterator) void disposer
      void label
    },
  }
  entry.apply(ctx)
  return { routes, commands }
}

/** Drive one handler and return its captured response. */
async function call(routes, routePath, options) {
  const handler = routes.get(routePath)
  assert.ok(handler !== undefined, `route ${routePath} was not registered`)
  const res = fakeResponse()
  await handler(fakeRequest(options), res)
  return res
}

// ---------------------------------------------------------------------------

const home = await mkdtemp(path.join(tmpdir(), 'dsh-session-delete-test-'))
process.env.DSH_HOME = home

const cwdA = path.join(home, 'workspace-a')
const cwdB = path.join(home, 'workspace-b')
await mkdir(cwdA, { recursive: true })
await mkdir(cwdB, { recursive: true })

const fixtures = [
  sessionFixture({ id: 'session-keep-0001', title: '保留的会话', cwd: cwdA, createdAt: 1_700_000_001_000, bytes: 64 }),
  sessionFixture({ id: 'session-drop-0002', title: '要删的甲', cwd: cwdA, createdAt: 1_700_000_002_000, bytes: 2048 }),
  sessionFixture({ id: 'session-drop-0003', title: '要删的乙', cwd: cwdB, createdAt: 1_700_000_003_000, bytes: 4096 }),
  sessionFixture({ id: 'session-busy-0004', title: '正在跑的', cwd: cwdB, createdAt: 1_700_000_004_000, bytes: 512 }),
]
for (const fixture of fixtures) await writeSession(home, fixture)

const membership = fixtures.map((fixture) => fixture.id)
// Not spread: `sessionIds` is a getter, and spreading would snapshot it. The
// seeded flags make the archive/pin cleanup path observable below.
const fake = fakeRegistry(membership, {
  archived: ['session-drop-0002'],
  pinned: ['session-drop-0003'],
})
const { routes, commands } = await loadPlugin({ registry: fake.registry, running: ['session-busy-0004'] })

// 1. No command surface: both delete entries are browser UI, so the plugin
//    must not register any slash command.
assert.equal(commands.length, 0)

// 2. The catalog route lists every indexed Session with its cosmetic columns.
{
  const res = await call(routes, '/plugins/session-delete/sessions', { method: 'GET' })
  assert.equal(res.captured.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.sessions.length, fixtures.length)
  const dropB = res.json.sessions.find((row) => row.id === 'session-drop-0003')
  assert.equal(dropB.title, '要删的乙')
  assert.equal(dropB.bytes, 4096)
  assert.equal(dropB.createdAt, 1_700_000_003_000)
  assert.equal(res.captured.headers['cache-control'], 'no-store')
}

// 3. The bulk route refuses a non-JSON media type (the anti-CSRF fence).
{
  const handler = routes.get('/plugins/session-delete/delete-batch')
  const res = fakeResponse()
  await handler({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    setEncoding() {},
    async* [Symbol.asyncIterator]() { yield 'ids=session-drop-0002' },
  }, res)
  assert.equal(res.captured.status, 415)
}

// 4. The bulk route refuses an id that could escape the store.
{
  const res = await call(routes, '/plugins/session-delete/delete-batch', {
    method: 'POST',
    body: { ids: ['../../etc/passwd'] },
  })
  assert.equal(res.captured.status, 400)
  assert.match(res.json.text, /不合法/)
}

// 5. The bulk route refuses an empty selection.
{
  const res = await call(routes, '/plugins/session-delete/delete-batch', { method: 'POST', body: { ids: [] } })
  assert.equal(res.captured.status, 400)
}

// 5b. The bulk route refuses more than its per-request cap, and says so plainly
//     instead of reporting the body as malformed.
{
  const ids = Array.from({ length: 501 }, (_, index) => `session-over-${index}`)
  const res = await call(routes, '/plugins/session-delete/delete-batch', { method: 'POST', body: { ids } })
  assert.equal(res.captured.status, 400)
  assert.match(res.json.text, /一次最多删除 500 条/)
  assert.doesNotMatch(res.json.text, /无法解析请求/)
}

// 5c. A body that is not an object at all is still reported as unparseable.
{
  const handler = routes.get('/plugins/session-delete/delete-batch')
  const res = fakeResponse()
  await handler({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    setEncoding() {},
    async* [Symbol.asyncIterator]() { yield '[]' },
  }, res)
  assert.equal(res.captured.status, 400)
  assert.match(res.json.text, /无法解析请求/)
}

// 6. The real thing: two deletable Sessions and one running one.
{
  const res = await call(routes, '/plugins/session-delete/delete-batch', {
    method: 'POST',
    body: { ids: ['session-drop-0002', 'session-drop-0003'] },
  })
  assert.equal(res.captured.status, 200)
  assert.equal(res.json.ok, true)
  assert.deepEqual(res.json.deleted.map((item) => item.id).sort(), ['session-drop-0002', 'session-drop-0003'])
  assert.equal(res.json.skipped.length, 0)
  assert.equal(res.json.failed.length, 0)
  // 2048 + 4096, the two transcripts the Host reported deleting.
  assert.equal(res.json.bytes, 2048 + 4096)
  assert.match(res.json.notice, /已删除 2 条会话/)
  assert.match(res.json.notice, /收回/)

  // The transcript directories and the cache rows are actually gone …
  for (const id of ['session-drop-0002', 'session-drop-0003']) {
    const meta = path.join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`)
    assert.equal(await exists(meta), false, `${id} cache row survived`)
  }
  assert.equal(await exists(path.join(home, 'sessions', encodeURIComponent(cwdA), 'session-drop-0002')), false)
  assert.equal(await exists(path.join(home, 'sessions', encodeURIComponent(cwdB), 'session-drop-0003')), false)

  // … and the untouched Session is still there.
  assert.equal(await exists(path.join(home, 'sessions', encodeURIComponent(cwdA), 'session-keep-0001')), true)

  // … and the Workspace ledger was told, archive and pin flags included.
  assert.deepEqual(fake.sessionIds.sort(), ['session-busy-0004', 'session-keep-0001'])
  assert.deepEqual(fake.archivedSessionIds, [])
  assert.deepEqual(fake.pinnedSessionIds, [])
}

// 7. A running Session is skipped, not cancelled, and not fatal.
{
  const before = await exists(path.join(home, 'sessions', encodeURIComponent(cwdB), 'session-busy-0004'))
  assert.equal(before, true)
  const res = await call(routes, '/plugins/session-delete/delete-batch', {
    method: 'POST',
    body: { ids: ['session-busy-0004', 'session-keep-0001'] },
  })
  assert.equal(res.captured.status, 200)
  assert.deepEqual(res.json.deleted.map((item) => item.id), ['session-keep-0001'])
  assert.deepEqual(res.json.skipped.map((item) => item.id), ['session-busy-0004'])
  assert.equal(res.json.skipped[0].reason, 'running')
  assert.equal(res.json.skipped[0].title, '正在跑的')
  // The skipped Session's files are untouched.
  assert.equal(await exists(path.join(home, 'sessions', encodeURIComponent(cwdB), 'session-busy-0004')), true)
}

// 8. An id the store no longer knows is reported as already-gone, not as failure.
{
  const res = await call(routes, '/plugins/session-delete/delete-batch', {
    method: 'POST',
    body: { ids: ['session-never-existed'] },
  })
  assert.equal(res.captured.status, 200)
  assert.equal(res.json.deleted.length, 0)
  assert.equal(res.json.skipped[0].reason, 'already-gone')
  assert.equal(res.json.failed.length, 0)
}

// 9. The single-row route still refuses a running Session with 409.
{
  const res = await call(routes, '/plugins/session-delete/delete', {
    method: 'POST',
    body: { id: 'session-busy-0004' },
  })
  assert.equal(res.captured.status, 409)
  assert.match(res.json.text, /正在运行/)
}

// 10. Duplicate ids in one request are collapsed, not deleted twice.
{
  await writeSession(home, sessionFixture({
    id: 'session-dup-0005', title: '重复提交', cwd: cwdA, createdAt: 1_700_000_005_000, bytes: 32,
  }))
  const res = await call(routes, '/plugins/session-delete/delete-batch', {
    method: 'POST',
    body: { ids: ['session-dup-0005', 'session-dup-0005'] },
  })
  assert.equal(res.json.deleted.length, 1)
  assert.equal(res.json.failed.length, 0)
}

await rm(home, { recursive: true, force: true })
console.log('host-smoke: all checks passed')
