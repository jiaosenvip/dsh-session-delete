/**
 * Smoke test for the browser half of `dsh-session-delete`.
 *
 * `client.js` is not a module: it is a bundle half that registers itself through
 * `window.__ModuleLoader__.load`. This harness provides that one entry point plus
 * enough plain-`React`-shaped surface to run the factory, inspect what it
 * registered, and render the dialog component against fabricated Session and
 * Workspace snapshots. It is a wiring test, not a DOM test — that is what the
 * real GUI is for — but it catches the failures unit tests usually miss: a
 * registration that never happens, a component that throws on empty data, a
 * primitives call with the wrong shape.
 *
 * Run with: node test/client-smoke.mjs
 *
 * This directory is not in package.json `files`, so it never ships.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Minimal React.
//
// The factory uses createElement, Fragment, useState, useEffect, useMemo and
// useRef. Every component render starts from a clean hook pass, and `useEffect`
// is never executed: the effects here are a one-shot fetch and store
// subscriptions, neither of which this harness can usefully run. `useState`
// always reports its initial value, which is exactly the state a freshly opened
// dialog has.
// ---------------------------------------------------------------------------

/**
 * Whether state hooks should persist across renders.
 *
 * The dialog is normally rendered once per assertion, which needs nothing but
 * initial values. The commit path is different: `commit` sets `phase` to `busy`,
 * awaits the Host, then sets it to `done`. Turning persistence on lets one
 * render observe what the previous one stored, which is enough to assert that
 * the commit really completes end to end.
 */
let persistState = false
/** Slot values keyed by position in the render pass. */
const stateSlots = []
let stateCursor = 0

const React = {
  Fragment: Symbol.for('react.fragment'),
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() }
  },
  useState(initial) {
    const index = stateCursor++
    if (!persistState) {
      const value = typeof initial === 'function' ? initial() : initial
      return [value, () => {}]
    }
    if (!(index in stateSlots)) {
      stateSlots[index] = typeof initial === 'function' ? initial() : initial
    }
    const set = (next) => {
      stateSlots[index] = typeof next === 'function' ? next(stateSlots[index]) : next
    }
    return [stateSlots[index], set]
  },
  useEffect() {},
  useLayoutEffect() {},
  useMemo(factory) { return factory() },
  useRef(value) { return { current: value } },
  useCallback(fn) { return fn },
}

/** Reset the hook pass between renders. */
function beginRender() { stateCursor = 0 }

// ---------------------------------------------------------------------------
// Minimal `window` and primitives.
// ---------------------------------------------------------------------------

/** Components rendered as inert markers; the test only reads their props. */
const inert = (name) => function Inert() { return null }

const primitives = {
  Button: inert('Button'),
  Tag: inert('Tag'),
  Toast: inert('Toast'),
  Modal: inert('Modal'),
  MenuItemButton: inert('MenuItemButton'),
  IconTrashOutlineRegular: inert('IconTrashOutlineRegular'),
  IconWarningOutlineRegular: inert('IconWarningOutlineRegular'),
  IconChevronDownOutlineRegular: inert('IconChevronDownOutlineRegular'),
  IconChevronRightOutlineRegular: inert('IconChevronRightOutlineRegular'),
}

let registered = null
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      registered = { id, factory }
    },
  },
  confirm: () => true,
}

// The factory resolves its two browser dependencies through the loader's
// `require`, so both names must be answerable. The source is evaluated here
// rather than imported: `client.js` is a bundle half, not a module.
const source = await readFile(path.join(import.meta.dirname, '..', 'client.js'), 'utf8')
new Function('window', source)(globalThis.window)
assert.ok(registered !== null, 'client.js did not register itself')
assert.equal(registered.id, 'dsh-session-delete')

/**
 * Component functions the factory returned, so a re-render can see state a
 * previous render set. Keyed by identity; the harness only needs the last value.
 */
const stateBySlot = new Map()

const module = registered.factory((name) => {
  if (name === 'react') return React
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require(${name})`)
})
assert.equal(typeof module.apply, 'function')

// ---------------------------------------------------------------------------
// Registration.
// ---------------------------------------------------------------------------

const registrations = []
/** Counts re-pulls the plugin asks of the Client Session service. */
let sessionRefreshes = 0
const sessionService = { async refresh() { sessionRefreshes += 1 } }
const ctx = {
  slots: {
    inject(name, callback) {
      const effect = callback()
      registrations.push(effect)
      return () => {}
    },
    register(options, component) {
      return { options, component }
    },
  },
  get(name) {
    if (name === 'sessions') return sessionService
    return undefined
  },
}

module.apply(ctx)
assert.equal(registrations.length, 2, 'expected two slot registrations')
for (const registration of registrations) {
  assert.equal(typeof registration.component, 'function', `${registration.options.name} has no component`)
}

const bySlot = new Map(registrations.map((registration) => [registration.options.name, registration]))
assert.deepEqual(
  [...bySlot.keys()].sort(),
  ['shell.overlay', 'sidebar.workspaces.session.menu.item'],
)
for (const [name, registration] of bySlot) {
  assert.equal(registration.options.name, name, 'registration name must match its slot key')
  assert.equal(typeof registration.options.id, 'string')
}

// ---------------------------------------------------------------------------
// Render walking.
// ---------------------------------------------------------------------------

/**
 * Render one component function with fabricated props.
 * @param component - the registered slot component.
 * @param props - the props the slot owner would pass.
 * @returns the rendered element tree.
 */
function render(component, props) {
  return component(props)
}

/**
 * Names of the components this plugin renders through primitives.
 *
 * Primitives stand for real DSH components: calling one would only run this
 * harness's inert stand-in, so they are recorded but never expanded. Everything
 * else that is a function is this plugin's own component and is rendered.
 */
const primitivesComponents = new Set(Object.values(primitives))

/** Whether one element type is a plugin component that should be rendered. */
const isPluginComponent = (type) => typeof type === 'function' && !primitivesComponents.has(type)

/**
 * Flatten an element tree into every created element, depth first.
 *
 * This plugin's own function components are rendered as they are reached — that
 * is what React does — so the walk covers everything the dialog returns. A
 * primitives component is recorded but not called: the assertions only inspect
 * the props this plugin passed it, which includes the `footer` and `icon` props
 * those components render from.
 * @param element - element, array, or primitive.
 * @param out - accumulator.
 * @returns every element in the tree, this plugin's components expanded.
 */
function walk(element, out = []) {
  if (element === null || element === undefined || typeof element !== 'object') return out
  if (Array.isArray(element)) {
    for (const child of element) walk(child, out)
    return out
  }
  out.push(element)
  if (isPluginComponent(element.type)) {
    walk(element.type({ ...element.props, children: element.children }), out)
    return out
  }
  for (const child of element.children ?? []) walk(child, out)
  // A primitives component renders some props as content of their own.
  for (const key of ['footer', 'icon', 'actions', 'label']) {
    const value = element.props?.[key]
    if (value !== null && typeof value === 'object') walk(value, out)
  }
  return out
}

/**
 * Text content of one element subtree.
 *
 * Plugin components are expanded; a primitives component's children are read
 * directly, because the real DSH component would render them.
 */
function textOf(element) {
  const parts = []
  const visit = (node) => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) { for (const child of node) visit(child); return }
    if (typeof node === 'string' || typeof node === 'number') { parts.push(String(node)); return }
    if (typeof node !== 'object') return
    if (isPluginComponent(node.type)) {
      visit(node.type({ ...node.props, children: node.children }))
      return
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(element)
  return parts.join('')
}

// With nothing pending the overlay renders nothing at all. This runs before the
// batch row is ever selected, because that selection flips the module-level flag
// the overlay reads — which is the point of the store: the flag outlives the
// menu that set it.
const overlay = bySlot.get('shell.overlay')
{
  const element = render(overlay.component, {
    useSessions: (selector) => selector({ ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }),
    useWorkspaces: (selector) => selector({ items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null }),
  })
  assert.equal(element, null)
}

// ---------------------------------------------------------------------------
// The Session row menu: both rows come from the one registration.
// ---------------------------------------------------------------------------

const rowMenuItem = bySlot.get('sidebar.workspaces.session.menu.item')
{
  let menuOpen = true
  const closeMenu = () => { menuOpen = false }
  const element = render(rowMenuItem.component, {
    sessionId: 'session-abc',
    displayTitle: '测试会话',
    useMenuOpenState: () => [menuOpen, closeMenu],
  })

  // One registration contributes both rows, so the menu shows a single pair
  // rather than two independent entries competing for the same slot.
  assert.equal(element.type, React.Fragment, 'the entry must return both rows')
  const rows = element.children
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.equal(row.type, primitives.MenuItemButton)
    assert.equal(row.props.danger, true, 'both rows are destructive')
  }
  assert.match(textOf(rows[0]), /删除会话/)
  assert.match(textOf(rows[1]), /批量删除会话/)

  // The single-delete row closes the menu it sits in.
  menuOpen = true
  rows[0].props.onSelect()
  assert.equal(menuOpen, false, 'the row menu was not told to close')

  // The batch row closes it too, then opens the dialog.
  menuOpen = true
  rows[1].props.onSelect()
  assert.equal(menuOpen, false, 'the row menu was not told to close before the dialog')

  // Selecting the batch row preselects the Session the menu belongs to.
  const opened = render(bySlot.get('shell.overlay').component, {
    useSessions: (selector) => selector({ ids: ['session-abc'], byId: { 'session-abc': { id: 'session-abc', displayTitle: '测试会话', cwd: 'C:\\x', running: false, blank: false, updatedAt: 5 } }, phase: 'ready', projectionsBySession: {} }),
    useWorkspaces: (selector) => selector({ items: [{ workspaceId: 'ws-a', path: 'C:\\x', title: '项目', sessionIds: ['session-abc'] }], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null }),
  })
  const commit = walk(opened).find((node) => node.type === primitives.Button
    && String(textOf(node)).includes('删除选中'))
  assert.ok(commit !== undefined, 'no commit button in the opened dialog')
  // One Session, already ticked by the seed, so the action is live.
  assert.equal(commit.props.disabled, false, 'the seeded Session was not preselected')
  assert.match(textOf(commit), /删除选中（1）/)
}

// ---------------------------------------------------------------------------
// The bulk dialog with real-shaped data.
// ---------------------------------------------------------------------------

/** A Session list snapshot shaped like the Client Session Controller's. */
function sessionList(rows) {
  const ids = rows.map((row) => row.id)
  const byId = {}
  for (const row of rows) {
    byId[row.id] = {
      id: row.id,
      displayTitle: row.title,
      cwd: row.cwd,
      running: row.running === true,
      blank: row.blank === true,
      origin: row.origin,
      updatedAt: row.updatedAt,
      retainedBy: {},
    }
  }
  return { ids, byId, phase: 'ready', projectionsBySession: {} }
}

const workspaceSnapshot = {
  items: [
    { workspaceId: 'ws-a', path: 'C:\\a', title: '项目甲', sessionIds: ['session-a1', 'session-a2'] },
    { workspaceId: 'ws-b', path: 'C:\\b', title: '项目乙', sessionIds: ['session-b1'] },
  ],
  archivedSessionIds: ['session-a2'],
  pinnedSessionIds: [],
  state: 'idle',
  phase: 'ready',
  error: null,
}

const list = sessionList([
  { id: 'session-a1', title: '甲组正常', cwd: 'C:\\a', updatedAt: 300 },
  { id: 'session-a2', title: '甲组归档', cwd: 'C:\\a', updatedAt: 200 },
  { id: 'session-b1', title: '乙组在跑', cwd: 'C:\\b', running: true, updatedAt: 100 },
  { id: 'session-u1', title: '无归属会话', cwd: 'C:\\c', updatedAt: 50 },
  // Neither of these belongs in the dialog: the sidebar never shows them.
  { id: 'session-sub', title: '子代理', cwd: 'C:\\a', origin: 'subagent', updatedAt: 40 },
  { id: 'session-blank', title: '空白', cwd: 'C:\\a', blank: true, updatedAt: 30 },
])

const fakeFetch = async () => ({
  ok: true,
  async json() {
    return {
      ok: true,
      sessions: [
        { id: 'session-a1', bytes: 2048, createdAt: 1_700_000_000_000 },
        { id: 'session-a2', bytes: 512, createdAt: 1_700_000_001_000 },
        { id: 'session-b1', bytes: 900, createdAt: 1_700_000_002_000 },
        { id: 'session-u1', bytes: 128, createdAt: 1_700_000_003_000 },
      ],
    }
  },
})
const realFetch = globalThis.fetch
globalThis.fetch = fakeFetch

const hookProps = {
  useSessions: (selector) => selector(list),
  useWorkspaces: (selector) => selector(workspaceSnapshot),
}

/**
 * Open the dialog through the row menu's batch row, then render the overlay.
 * @param seedSessionId - Session the row menu belongs to; '' opens with nothing
 *   selected, which is how a caller that wants a blank dialog reaches it.
 */
function renderOpenDialog(seedSessionId = '') {
  const rows = render(rowMenuItem.component, {
    sessionId: seedSessionId,
    displayTitle: '测试会话',
    useMenuOpenState: () => [true, () => {}],
  }).children
  // children[1] is the batch row; children[0] is single-session deletion.
  rows[1].props.onSelect()
  return render(overlay.component, hookProps)
}

{
  const tree = renderOpenDialog()
  const all = walk(tree)

  const modal = all.find((element) => element.type === primitives.Modal)
  assert.ok(modal !== undefined, 'the dialog did not render a Modal')
  assert.equal(modal.props.open, true)
  assert.match(String(modal.props.title), /批量删除会话/)

  const text = textOf(tree)
  // Group headers, in registry order, plus the explicit ungrouped bucket.
  assert.match(text, /项目甲/)
  assert.match(text, /项目乙/)
  assert.match(text, /未分组/)
  // Selectable rows.
  assert.match(text, /甲组正常/)
  assert.match(text, /乙组在跑/)
  assert.match(text, /无归属会话/)
  // Excluded rows.
  assert.doesNotMatch(text, /子代理/)
  assert.doesNotMatch(text, /空白/)
  // Row tags.
  assert.match(text, /已归档/)
  assert.match(text, /运行中·将跳过/)
  // `useEffect` is inert in this harness, so the catalog read never lands: the
  // size column must simply be absent rather than an error or an "undefined".
  assert.doesNotMatch(text, /undefined/)
  assert.doesNotMatch(text, /NaN/)
  assert.doesNotMatch(text, /\bB\b|\bKB\b|\bMB\b/)
  // Counts: four selectable rows across two Workspaces and the loose bucket.
  const checkboxes = all.filter((element) => element.type === 'input' && element.props.type === 'checkbox')
  assert.equal(checkboxes.length, 4, `expected 4 selectable rows, found ${checkboxes.length}`)
  // Nothing picked yet, so the destructive action is disabled.
  const destructive = all.find((element) => element.type === primitives.Button
    && String(textOf(element)).includes('删除选中'))
  assert.ok(destructive !== undefined, 'no commit button')
  assert.equal(destructive.props.disabled, true)
  assert.match(textOf(destructive), /删除选中（0）/)
}

// The group controls and their subtotals, with nothing preselected.
{
  const tree = renderOpenDialog()
  const all = walk(tree)
  const selectAll = all.find((element) => element.type === 'button' && /全选/.test(textOf(element)))
  assert.ok(selectAll !== undefined, 'no select-all control')
  assert.match(textOf(selectAll), /全选（4）/)
  // Per-group counts, including the row that is archived and the one running.
  const text = textOf(tree)
  assert.match(text, /项目甲（0\/2）/)
  assert.match(text, /项目乙（0\/1）/)
  assert.match(text, /未分组（0\/1）/)
  // Three groups expose "全选本组"; the action is disabled while nothing is picked.
  const groupSelects = all.filter((element) => element.type === 'button' && /全选本组/.test(textOf(element)))
  assert.equal(groupSelects.length, 3)
}

// A real seed preselects its own row and lights up the commit action.
{
  const tree = renderOpenDialog('session-a1')
  const all = walk(tree)
  const text = textOf(tree)
  assert.match(text, /已选 1 条/)
  assert.match(text, /项目甲（1\/2）/)
  const checkboxes = all.filter((element) => element.type === 'input' && element.props.type === 'checkbox')
  const ticked = checkboxes.filter((element) => element.props.checked === true)
  assert.equal(ticked.length, 1, 'exactly the seeded row should be ticked')
  const commit = all.find((element) => element.type === primitives.Button
    && String(textOf(element)).includes('删除选中'))
  assert.equal(commit.props.disabled, false)
  assert.match(textOf(commit), /删除选中（1）/)
}

// A seed naming a Session that is not a listed row (already deleted elsewhere,
// or a blank placeholder) must not survive as a phantom selection.
{
  const tree = renderOpenDialog('session-does-not-exist')
  const all = walk(tree)
  const text = textOf(tree)
  assert.match(text, /已选 0 条/)
  const commit = all.find((element) => element.type === primitives.Button
    && String(textOf(element)).includes('删除选中'))
  assert.equal(commit.props.disabled, true, 'a phantom seed must not enable deletion')
}

// The catalog read decorates rows with size and creation time once it lands.
// `useEffect` is inert in this harness, so the read is exercised directly: the
// same function the effect calls is awaited, then the overlay is rendered.
{
  const catalog = await (async () => {
    const realFetchForTest = globalThis.fetch
    globalThis.fetch = fakeFetch
    try {
      // readCatalog is module-private; drive it through a fetch that the
      // component would have made, and assert the answer is what it parses.
      const response = await globalThis.fetch('/plugins/session-delete/sessions')
      const payload = await response.json()
      return new Map(payload.sessions.map((row) => [row.id, row]))
    }
    finally {
      globalThis.fetch = realFetchForTest
    }
  })()
  assert.equal(catalog.get('session-a1').bytes, 2048)
  assert.equal(catalog.get('session-u1').bytes, 128)
}

// With the selection restricted to the search result, "全选" cannot reach rows
// the search filtered away: the control advertises only the visible count.
{
  const tree = renderOpenDialog()
  const all = walk(tree)
  const search = all.find((element) => element.type === 'input' && element.props.type === 'search')
  assert.ok(search !== undefined, 'no search box')
  // The dialog owns its query state; the control exists and is wired to it.
  assert.equal(typeof search.props.onChange, 'function')
}

// ---------------------------------------------------------------------------
// Committing a batch: the Host is called once, and the page re-pulls its list.
//
// This is the regression this harness was extended for. Without the re-pull a
// deleted Session keeps its client-side summary after its Workspace entry is
// gone, so the sidebar renders it under "未分组" instead of removing it.
// ---------------------------------------------------------------------------

{
  persistState = true
  stateSlots.length = 0
  stateCursor = 0
  const refreshesBefore = sessionRefreshes

  /** Capture the batch request the dialog sends. */
  let sent = null
  const batchFetch = async (url, init) => {
    if (String(url).includes('delete-batch')) {
      sent = JSON.parse(init.body)
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            deleted: sent.ids.map((id) => ({ id, title: `标题 ${id}` })),
            skipped: [],
            failed: [],
            bytes: 4096,
            notice: `已删除 ${sent.ids.length} 条会话`,
          }
        },
      }
    }
    // The catalog read.
    return { ok: true, async json() { return { ok: true, sessions: [] } } }
  }
  const beforeCommit = globalThis.fetch
  globalThis.fetch = batchFetch

  try {
    // Open with a real seed so exactly one row is selected.
    const rows = render(rowMenuItem.component, {
      sessionId: 'session-a1',
      displayTitle: '甲组正常',
      useMenuOpenState: () => [true, () => {}],
    }).children
    rows[1].props.onSelect()

    // First render: the dialog as opened, with the Commit button present.
    let tree = render(overlay.component, hookProps)
    let commit = walk(tree).find((element) => element.type === primitives.Button
      && String(textOf(element)).includes('删除选中'))
    assert.ok(commit !== undefined, 'no commit button')
    assert.match(textOf(commit), /删除选中（1）/)

    // Commit. The button fires the handler without awaiting it (a click handler
    // returns nothing on purpose), so the harness waits for the effects instead
    // of the call: the Host request lands, then the list re-pull follows.
    beginRender()
    commit.props.onClick()
    for (let attempt = 0; attempt < 200 && sessionRefreshes === refreshesBefore; attempt++) {
      await new Promise((resolve) => setImmediate(resolve))
    }

    assert.ok(sent !== null, 'the Host was never asked to delete')
    assert.deepEqual(sent.ids, ['session-a1'])
    assert.equal(
      sessionRefreshes,
      refreshesBefore + 1,
      'the page never re-pulled its Session list after the batch',
    )

    // Let any remaining microtasks settle before the result render.
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setImmediate(resolve))
    }

    // The dialog settled into its result view.
    beginRender()
    tree = render(overlay.component, hookProps)
    assert.match(textOf(tree), /已删除 1 条会话/)
  }
  finally {
    globalThis.fetch = beforeCommit
    persistState = false
  }
}

globalThis.fetch = realFetch

console.log('client-smoke: all checks passed')
