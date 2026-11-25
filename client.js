/**
 * Browser half of `dsh-session-delete`.
 *
 * Adds two surfaces, both sharing the Host half's single deletion path:
 *   - two rows in the Session row menu (`sidebar.workspaces.session.menu.item`):
 *     one deletes that Session, one opens the bulk-delete dialog with that
 *     Session already selected;
 *   - one frame-wide overlay entry (`shell.overlay`) hosting both the transient
 *     Toast and the bulk-delete dialog.
 *
 * Single-row deletion asks for a confirmation, posts the Session id to the route
 * the Host half owns, and reports the outcome in a transient Toast. It never
 * reloads the page: the Host removes the Session from its own list when the
 * files go, so the sidebar row settles by itself, and a reload would only throw
 * away the open conversation and scroll position.
 *
 * When a deleted Session was the one on screen, the main area moves to a fresh
 * Session in the same Workspace (or back to its sessionless home), so the user
 * is not left reading a conversation that no longer exists.
 *
 * The bulk dialog is built from the sidebar's own Session list — that list is
 * the only authority on what the user can actually see disappear — and the Host
 * catalog route supplies just the columns that list does not carry (size,
 * creation time). Sessions whose Agent is running are selectable but skipped at
 * delete time, so one busy conversation cannot abort the whole batch.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const ROUTE = '/plugins/session-delete/delete'
    const BATCH_ROUTE = '/plugins/session-delete/delete-batch'
    const CATALOG_ROUTE = '/plugins/session-delete/sessions'

    /** Shorthand used for every node below; the loader exposes no JSX runtime. */
    const h = React.createElement

    // ---------------------------------------------------------------------
    // Shared inline styles.
    //
    // A bundle client half has no CSS-module pipeline, so the dialog carries its
    // own styles. Every value is a theme token, which keeps the surface correct
    // in both light and dark themes and in third-party skins.
    // ---------------------------------------------------------------------
    const SURFACE = {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      minWidth: 0,
    }
    const TOOLBAR = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      flexWrap: 'wrap',
    }
    const INPUT = {
      flex: '1 1 180px',
      minWidth: 120,
      boxSizing: 'border-box',
      padding: '6px 10px',
      fontSize: 13,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '0.5px solid var(--dsw-alias-border-l2)',
      borderRadius: 'var(--dsw-radius-md)',
      outline: 'none',
    }
    const LIST = {
      maxHeight: '48vh',
      overflowY: 'auto',
      border: '0.5px solid var(--dsw-alias-border-l1)',
      borderRadius: 'var(--dsw-radius-md)',
      background: 'var(--dsw-alias-bg-layer-1)',
    }
    const GROUP_HEAD = {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '4px 10px',
      position: 'sticky',
      top: 0,
      zIndex: 1,
      background: 'var(--dsw-alias-bg-layer-2)',
      borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
      fontSize: 12,
      color: 'var(--dsw-alias-label-secondary)',
    }
    const ROW = {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 8,
      padding: '6px 10px',
      cursor: 'pointer',
      borderBottom: '0.5px solid var(--dsw-alias-border-l1)',
    }
    const CHECK = {
      flex: '0 0 auto',
      width: 15,
      height: 15,
      margin: '3px 0 0',
      cursor: 'pointer',
      accentColor: 'var(--dsw-alias-brand-primary)',
    }
    const ROW_BODY = {
      flex: '1 1 auto',
      minWidth: 0,
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
    }
    const ROW_TITLE = {
      fontSize: 13,
      lineHeight: '19px',
      color: 'var(--dsw-alias-label-primary)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }
    const ROW_META = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      flexWrap: 'wrap',
      fontSize: 11,
      lineHeight: '16px',
      color: 'var(--dsw-alias-label-secondary)',
    }
    const LINK_BUTTON = {
      border: 'none',
      background: 'transparent',
      padding: 0,
      fontSize: 12,
      lineHeight: '18px',
      color: 'var(--dsw-alias-brand-primary)',
      cursor: 'pointer',
    }
    const NOTICE = {
      fontSize: 12,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary)',
    }
    const ERROR_BOX = {
      padding: '6px 8px',
      borderRadius: 'var(--dsw-radius-md)',
      fontSize: 12,
      lineHeight: '18px',
      color: 'var(--dsw-alias-state-error-primary)',
      background: 'var(--dsw-alias-bg-layer-2)',
    }
    const DESTRUCTIVE = {
      color: 'var(--dsw-alias-state-error-primary)',
      borderColor: 'var(--dsw-alias-state-error-primary)',
    }

    // ---------------------------------------------------------------------
    // Module-level state.
    //
    // Both surfaces this plugin adds live inside components that unmount before
    // the outcome exists: the row menu's row disappears with the Session, and the
    // panel More menu closes the instant it dispatches. The state they need to
    // survive therefore lives here, not in component state.
    // ---------------------------------------------------------------------

    /** Current notice, or null when nothing is showing. */
    let notice = null
    /** Monotonic identity; a new value remounts the Toast so its timer restarts. */
    let noticeSeq = 0
    const listeners = new Set()

    /** Whether the bulk-delete dialog is open. */
    let batchOpen = false
    /** Session the dialog opens with already selected, or '' for none. */
    let batchSeed = ''
    const batchListeners = new Set()

    /** Armed id for the row menu's two-step fallback when no `confirm` dialog exists. */
    let armed = { id: '', at: 0 }
    const ARM_MS = 6000

    /** Replace the current notice and wake every subscriber. */
    function publish(next) {
      notice = next
      for (const listener of listeners) listener()
    }

    /** Subscribe one component to the notice store. */
    function useNotice() {
      const [current, setCurrent] = React.useState(notice)
      React.useEffect(() => {
        const listener = () => setCurrent(notice)
        listeners.add(listener)
        listener()
        return () => { listeners.delete(listener) }
      }, [])
      return current
    }

    /** Show one transient notice; `tone` is `success` or `warning`. */
    function notify(text, tone = 'success') {
      publish({ seq: ++noticeSeq, text, tone })
    }

    /** Drop the notice once the Toast finished its own timer. */
    function dismissNotice() {
      publish(null)
    }

    // ---------------------------------------------------------------------
    // Dialog store.
    //
    // The row menu that opens the dialog unmounts the moment the row loses its
    // Session, and the panel row that hosts it closes on dispatch, so neither
    // can own the open flag. It lives here, together with the Session the
    // dialog should open with preselected.
    // ---------------------------------------------------------------------

    /**
     * Open or close the bulk-delete dialog and wake its subscribers.
     *
     * Reopening while already open is allowed and replaces the seed: the dialog
     * is modal, so in practice this only happens when a second row menu is
     * reached from a stale popover, and replacing the seed is what the user
     * just asked for.
     * @param next - open (true) or close (false).
     * @param seed - Session to preselect when opening; ignored on close.
     */
    function setBatchOpen(next, seed = '') {
      if (!next) {
        if (!batchOpen) return
        batchOpen = false
        for (const listener of batchListeners) listener()
        return
      }
      batchSeed = typeof seed === 'string' ? seed : ''
      batchOpen = true
      for (const listener of batchListeners) listener()
    }

    /**
     * Subscribe one component to the dialog's open state.
     * @returns `{ open, seed }`, where `seed` is the Session to preselect.
     */
    function useBatchOpen() {
      const [state, setState] = React.useState({ open: batchOpen, seed: batchSeed })
      React.useEffect(() => {
        const listener = () => setState({ open: batchOpen, seed: batchSeed })
        batchListeners.add(listener)
        listener()
        return () => { batchListeners.delete(listener) }
      }, [])
      return state
    }

    /** The frame-wide notice entry; renders nothing while nothing is pending. */
    function DeleteSessionToast({ notice: current }) {
      if (current === null) return null
      const warning = current.tone === 'warning'
      const icon = warning && typeof primitives.IconWarningOutlineRegular === 'function'
        ? h(primitives.IconWarningOutlineRegular, {})
        : undefined
      return h(
        primitives.Toast,
        {
          // The primitive keys its own show cycle by remount: a new seq must
          // remount it, or a second notice would inherit the first timer.
          key: current.seq,
          text: current.text,
          onDone: dismissNotice,
          ...(warning ? {} : { tone: 'success' }),
          ...(icon === undefined ? {} : { icon }),
        },
      )
    }

    /** Ask the Host to delete one Session; resolves to its answer payload. */
    async function deleteOnHost(sessionId) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: sessionId }),
      })
      return response.json().catch(() => ({ ok: false, text: `删除请求失败：HTTP ${response.status}` }))
    }

    /** Ask the Host to delete every selected Session in one request. */
    async function deleteBatchOnHost(ids) {
      const response = await fetch(BATCH_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      return response.json().catch(() => ({ ok: false, text: `删除请求失败：HTTP ${response.status}` }))
    }

    /** Read the extra columns (size, creation time) the sidebar list omits. */
    async function readCatalog() {
      try {
        const response = await fetch(CATALOG_ROUTE, { headers: { accept: 'application/json' } })
        if (!response.ok) return null
        const payload = await response.json()
        if (payload?.ok !== true || !Array.isArray(payload.sessions)) return null
        const byId = new Map()
        for (const row of payload.sessions) {
          if (typeof row?.id === 'string') byId.set(row.id, row)
        }
        return byId
      }
      catch {
        // Cosmetic columns only: a failed read must not block the dialog.
        return null
      }
    }

    // ---------------------------------------------------------------------
    // Leaving the page that was showing the deleted conversation.
    // ---------------------------------------------------------------------
    /** Client root Context, kept for the navigation service lookup below. */
    let rootContext

    /** One Client service by name, or undefined when this composition lacks it. */
    function service(name) {
      try {
        return rootContext?.get?.(name)
      }
      catch {
        return undefined
      }
    }

    /** The Client `uiWorkspace` navigation service, when the composition has one. */
    function workspaceNavigation() {
      return service('uiWorkspace')
    }

    /** Session id the main area currently shows, when that is knowable. */
    function mainSessionId(navigation) {
      try {
        const selection = navigation?.selection?.getSnapshot?.()
        return typeof selection === 'object' && selection !== null ? selection.sessionId : undefined
      }
      catch {
        return undefined
      }
    }

    /** Workspace holding `sessionId`; read before the Host drops the membership. */
    function workspaceOfSession(navigation, sessionId) {
      try {
        const snapshot = navigation?.workspaces?.list?.getSnapshot?.()
        const items = Array.isArray(snapshot?.items) ? snapshot.items : []
        return items.find((item) => item.sessionIds?.includes(sessionId))?.workspaceId
      }
      catch {
        return undefined
      }
    }

    /**
     * Take the main area off a Session that no longer exists.
     *
     * A fresh Session in the same Workspace keeps the user where they were, in
     * the project they were reading; without one, clearing the selection returns
     * the main area to its sessionless home. Both are better than the alternative
     * — staying on a conversation whose transcript and Agent are gone.
     */
    function leaveDeletedSession(navigation, workspaceId) {
      if (navigation === undefined) return
      try {
        if (typeof navigation.startSession === 'function') {
          navigation.startSession(workspaceId)
          return
        }
      }
      catch (error) {
        console.warn('[session-delete] could not start a new Session:', error)
      }
      try {
        navigation.clearMain?.()
      }
      catch (error) {
        console.warn('[session-delete] could not clear the main view:', error)
      }
    }

    /**
     * Move the main area off the deleted Session, when it is showing one.
     * @param ids - Sessions the Host confirmed as deleted.
     */
    function leaveIfOpen(ids) {
      const navigation = workspaceNavigation()
      const open = mainSessionId(navigation)
      if (open === undefined || !ids.includes(open)) return false
      leaveDeletedSession(navigation, workspaceOfSession(navigation, open))
      return true
    }

    /**
     * Re-pull the Host's Session list after a batch delete.
     *
     * The sidebar renders a client-side snapshot of that list. A single delete is
     * followed by the Host's own list push, which drops the row on its own; a
     * batch of deletes finishes many removals inside one request, and the page can
     * settle with rows whose files are gone but whose summaries are still in the
     * snapshot. Those rows have no Workspace entry any more, so they would show
     * up under "未分组" until the next page load. Asking for a fresh baseline is
     * what makes a batch settle exactly like a single delete.
     *
     * Best-effort: a composition without the service, or a failed pull, only
     * costs the immediate settle, never the deletion.
     */
    async function refreshSessionList() {
      const sessions = service('sessions')
      if (typeof sessions?.refresh !== 'function') return
      try {
        await sessions.refresh()
      }
      catch (error) {
        console.warn('[session-delete] could not refresh the session list:', error)
      }
    }

    // ---------------------------------------------------------------------
    // Formatting helpers for the dialog's columns.
    // ---------------------------------------------------------------------
    /** Human byte size, matching the Host's own formatting. */
    function formatBytes(bytes) {
      const value = Number(bytes) || 0
      if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
      if (value >= 1024) return `${Math.round(value / 1024)} KB`
      return `${Math.round(value)} B`
    }

    /** Short absolute time for one row; empty when the Host has no timestamp. */
    function formatWhen(ms) {
      const value = Number(ms)
      if (!Number.isFinite(value) || value <= 0) return ''
      try {
        return new Date(value).toLocaleString(undefined, {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })
      }
      catch {
        return ''
      }
    }

    /** Why the Host did not delete one selected Session. */
    function skipReason(code) {
      if (code === 'running') return '运行中，已跳过'
      if (code === 'already-gone') return '已不存在'
      return String(code ?? '已跳过')
    }

    /**
     * The rows the dialog can offer: the sidebar's own Sessions.
     *
     * Built from the Session list the sidebar renders, so every row here has a
     * row there to disappear. Subagent children and blank placeholders are
     * projections rather than conversations, and the sidebar never shows them.
     * @param list - the Session list snapshot.
     * @param catalog - optional Host catalog rows, keyed by Session id.
     * @param archived - archive set, for the row tag.
     * @returns one row per selectable Session.
     */
    function buildRows(list, catalog, archived) {
      const ids = Array.isArray(list?.ids) ? list.ids : []
      const byId = list?.byId ?? {}
      const rows = []
      for (const id of ids) {
        const summary = byId[id]
        if (summary === undefined) continue
        if (summary.origin === 'subagent') continue
        if (summary.blank) continue
        const extra = catalog?.get?.(id)
        rows.push({
          id,
          title: summary.displayTitle || extra?.title || id,
          cwd: summary.cwd,
          when: formatWhen(extra?.createdAt),
          bytes: typeof extra?.bytes === 'number' ? extra.bytes : undefined,
          running: summary.running === true,
          archived: archived.has(id),
          updatedAt: Number(summary.updatedAt) || 0,
        })
      }
      return rows
    }

    /**
     * Bucket rows by Workspace, in registry order.
     *
     * Rows go into the Workspace whose `sessionIds` accounts for them; anything
     * left over lands in one explicit "未分组" bucket, which is exactly how the
     * sidebar presents a Session no Workspace claims.
     * @param rows - the selectable rows.
     * @param snapshot - the Workspace snapshot.
     * @returns non-empty groups, each with its label and rows.
     */
    function buildGroups(rows, snapshot) {
      const items = Array.isArray(snapshot?.items) ? snapshot.items : []
      const member = new Map()
      const buckets = new Map()
      for (const item of items) {
        buckets.set(item.workspaceId, { key: item.workspaceId, label: item.title, rows: [] })
        for (const id of item.sessionIds ?? []) {
          if (!member.has(id)) member.set(id, item.workspaceId)
        }
      }
      const loose = { key: '__ungrouped__', label: '未分组', rows: [] }
      for (const row of rows) {
        const key = member.get(row.id)
        const bucket = key === undefined ? loose : buckets.get(key) ?? loose
        bucket.rows.push(row)
      }
      const byRecency = (left, right) => right.updatedAt - left.updatedAt
      const groups = []
      for (const bucket of buckets.values()) {
        if (bucket.rows.length === 0) continue
        bucket.rows.sort(byRecency)
        groups.push(bucket)
      }
      if (loose.rows.length > 0) {
        loose.rows.sort(byRecency)
        groups.push(loose)
      }
      return groups
    }

    // ---------------------------------------------------------------------
    // Bulk-delete dialog.
    // ---------------------------------------------------------------------

    /** One checkbox row: the box, the title, and the facts beneath it. */
    function SessionPickRow({ row, checked, disabled, onToggle }) {
      const meta = []
      if (row.when !== '') meta.push(h('span', { key: 'when' }, row.when))
      if (row.bytes !== undefined) meta.push(h('span', { key: 'bytes' }, formatBytes(row.bytes)))
      if (row.cwd !== undefined && row.cwd !== '') meta.push(h('span', { key: 'cwd' }, row.cwd))
      if (row.archived) meta.push(h(primitives.Tag, { key: 'archived', tone: 'quiet' }, '已归档'))
      if (row.running) meta.push(h(primitives.Tag, { key: 'running', tone: 'info' }, '运行中·将跳过'))
      return h(
        'label',
        { style: ROW },
        h('input', {
          type: 'checkbox',
          style: CHECK,
          checked,
          disabled,
          onChange: () => { onToggle(row.id) },
        }),
        h(
          'span',
          { style: ROW_BODY },
          h('span', { style: ROW_TITLE, title: row.title }, row.title),
          meta.length === 0 ? null : h('span', { style: ROW_META }, ...meta),
        ),
      )
    }

    /** One collapsible Workspace group: its header, its select-all, and its rows. */
    function SessionPickGroup({
      group, rows, selection, collapsed, disabled, onToggleCollapsed, onToggleGroup, onToggleRow,
    }) {
      const picked = rows.filter((row) => selection.has(row.id)).length
      const all = rows.length > 0 && picked === rows.length
      const chevron = collapsed
        ? (typeof primitives.IconChevronRightOutlineRegular === 'function'
          ? h(primitives.IconChevronRightOutlineRegular, { size: 12 })
          : '›')
        : (typeof primitives.IconChevronDownOutlineRegular === 'function'
          ? h(primitives.IconChevronDownOutlineRegular, { size: 12 })
          : '⌄')
      return h(
        'div',
        null,
        h(
          'div',
          { style: GROUP_HEAD },
          h(
            'button',
            {
              type: 'button',
              style: { ...LINK_BUTTON, color: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 4, flex: '1 1 auto', minWidth: 0 },
              'aria-expanded': !collapsed,
              onClick: () => { onToggleCollapsed(group.key) },
            },
            chevron,
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, group.label),
            h('span', null, `（${picked}/${rows.length}）`),
          ),
          h(
            'button',
            {
              type: 'button',
              style: LINK_BUTTON,
              disabled,
              onClick: () => { onToggleGroup(rows, !all) },
            },
            all ? '取消本组' : '全选本组',
          ),
        ),
        collapsed
          ? null
          : rows.map((row) => h(SessionPickRow, {
            key: row.id,
            row,
            checked: selection.has(row.id),
            disabled,
            onToggle: onToggleRow,
          })),
      )
    }

    /** What the Host reported, shown until the user closes the dialog. */
    function BatchResultView({ result }) {
      const skipped = result.skipped ?? []
      const failed = result.failed ?? []
      return h(
        'div',
        { style: SURFACE },
        h('div', { style: { fontSize: 13, lineHeight: '20px' } },
          `已删除 ${result.deleted?.length ?? 0} 条会话`,
          result.bytes > 0 ? `，收回 ${formatBytes(result.bytes)}` : ''),
        result.leftPage ? h('div', { style: NOTICE }, '主区域已切换到同工作区的新会话。') : null,
        skipped.length === 0 ? null : h(
          'div',
          { style: { ...NOTICE, color: 'var(--dsw-alias-state-warn-primary)' } },
          ...skipped.map((item) => h('div', { key: `skip-${item.id}`, style: { overflow: 'hidden', textOverflow: 'ellipsis' } },
            `${item.title ?? item.id}：${skipReason(item.reason)}`)),
        ),
        failed.length === 0 ? null : h(
          'div',
          { style: { ...NOTICE, color: 'var(--dsw-alias-state-error-primary)' } },
          ...failed.map((item) => h('div', { key: `fail-${item.id}`, style: { whiteSpace: 'pre-wrap' } },
            `${item.title ?? item.id}：${item.reason ?? '删除失败'}`)),
        ),
      )
    }

    /**
     * The bulk-delete dialog.
     *
     * Rows come from the sidebar's own Session list, grouped by Workspace, so the
     * selection always names Sessions the user can see. The Host catalog read is
     * best-effort and only decorates those rows with size and creation time.
     *
     * @param props - injected selector hooks (`useSessions`, `useWorkspaces`)
     *   plus the Session the row menu opened the dialog from.
     */
    function BatchDeleteDialog(props) {
      const { useSessions, useWorkspaces, seed } = props
      const list = useSessions((state) => state)
      const workspaceSnapshot = useWorkspaces((state) => state)

      const [catalog, setCatalog] = React.useState(null)
      // The row menu that opens this dialog names a Session; preselecting it is
      // what makes "batch, starting from this one" cheaper than "batch, from
      // scratch". A seeded id that is not a listed row is dropped by `picked`
      // below, so a stale seed can never reach the Host.
      const [selection, setSelection] = React.useState(
        () => new Set(typeof seed === 'string' && seed !== '' ? [seed] : []),
      )
      const [query, setQuery] = React.useState('')
      const [collapsed, setCollapsed] = React.useState(() => new Set())
      const [phase, setPhase] = React.useState('pick')
      const [result, setResult] = React.useState(null)
      const [error, setError] = React.useState(null)

      // One best-effort catalog read per open; the dialog is not a live view of
      // file sizes and re-reading on every list tick would be pure churn.
      React.useEffect(() => {
        let live = true
        void readCatalog().then((value) => { if (live) setCatalog(value) })
        return () => { live = false }
      }, [])

      const busy = phase === 'busy'

      // Every row the dialog can offer, then the same rows grouped by Workspace.
      const rows = React.useMemo(() => buildRows(
        list,
        catalog,
        new Set(workspaceSnapshot?.archivedSessionIds ?? []),
      ), [list, catalog, workspaceSnapshot])

      const groups = React.useMemo(
        () => buildGroups(rows, workspaceSnapshot),
        [rows, workspaceSnapshot],
      )

      // The search narrows what the two select-all controls act on, so "全选"
      // never silently reaches rows the user filtered away.
      const visibleGroups = React.useMemo(() => {
        const needle = query.trim().toLowerCase()
        if (needle === '') return groups
        return groups
          .map((group) => ({
            ...group,
            rows: group.rows.filter((row) =>
              row.title.toLowerCase().includes(needle)
              || String(row.cwd ?? '').toLowerCase().includes(needle)),
          }))
          .filter((group) => group.rows.length > 0)
      }, [groups, query])

      const visibleRows = React.useMemo(
        () => visibleGroups.reduce((all, group) => all.concat(group.rows), []),
        [visibleGroups],
      )

      const rowById = React.useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows])

      // A Session that vanished from the list (deleted elsewhere) must not stay
      // selected, or the request would carry a dead id.
      const picked = React.useMemo(
        () => [...selection].filter((id) => rowById.has(id)),
        [selection, rowById],
      )

      const allVisiblePicked = visibleRows.length > 0 && visibleRows.every((row) => selection.has(row.id))
      const anyRunning = picked.some((id) => rowById.get(id)?.running === true)

      /** Add or remove one row from the selection. */
      const toggleRow = (id) => {
        setSelection((current) => {
          const next = new Set(current)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      /** Add or remove a whole group, leaving rows outside it untouched. */
      const toggleGroup = (groupRows, on) => {
        setSelection((current) => {
          const next = new Set(current)
          for (const row of groupRows) {
            if (on) next.add(row.id)
            else next.delete(row.id)
          }
          return next
        })
      }

      /** Add or remove every row the search left visible. */
      const toggleAllVisible = () => {
        toggleGroup(visibleRows, !allVisiblePicked)
      }

      /** Add or remove one group from the collapsed set. */
      const toggleCollapsed = (key) => {
        setCollapsed((current) => {
          const next = new Set(current)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }

      /** Send the selection, then show what the Host reported. */
      const commit = async () => {
        if (picked.length === 0 || busy) return
        setPhase('busy')
        setError(null)
        let payload
        try {
          payload = await deleteBatchOnHost(picked)
        }
        catch (reason) {
          setPhase('pick')
          setError(`删除请求失败：${reason?.message ?? reason}`)
          return
        }
        if (payload?.ok !== true) {
          setPhase('pick')
          setError(payload?.text ?? '删除失败。')
          return
        }
        const deletedIds = (payload.deleted ?? []).map((item) => item.id)
        const leftPage = leaveIfOpen(deletedIds)
        setResult({ ...payload, leftPage })
        setPhase('done')
        setSelection(new Set())
        if (payload.notice) notify(payload.notice)
        // The Host deleted the files and told the Workspace ledger, but this
        // page's Session list is a client-side snapshot: without a re-pull the
        // removed rows keep their menu-era summaries, and a Session whose ledger
        // entry is now gone renders under "未分组" until the next reload. A
        // single-row delete gets that re-pull from the Host's own list push;
        // a batch of them can outrun the pushes, so ask explicitly.
        await refreshSessionList()
      }

      /** Close the dialog; refused while a batch is in flight. */
      const close = () => {
        if (busy) return
        setBatchOpen(false)
      }

      const footer = phase === 'done'
        ? h(primitives.Button, { variant: 'outline', onClick: close }, '完成')
        : h(
          React.Fragment,
          null,
          h(primitives.Button, { variant: 'outline', disabled: busy, onClick: close }, '取消'),
          h(
            primitives.Button,
            {
              variant: 'outline',
              style: DESTRUCTIVE,
              disabled: busy || picked.length === 0,
              onClick: () => { void commit() },
            },
            busy ? '正在删除…' : `删除选中（${picked.length}）`,
          ),
        )

      const body = phase === 'done' && result !== null
        ? h(BatchResultView, { result })
        : h(
          React.Fragment,
          null,
          h(
            'div',
            { style: TOOLBAR },
            h('input', {
              type: 'search',
              style: INPUT,
              placeholder: '搜索标题或目录',
              'aria-label': '搜索会话',
              value: query,
              disabled: busy,
              onChange: (event) => { setQuery(event.currentTarget.value) },
            }),
            h(
              'button',
              {
                type: 'button',
                style: { ...LINK_BUTTON, whiteSpace: 'nowrap' },
                disabled: busy || visibleRows.length === 0,
                onClick: toggleAllVisible,
              },
              allVisiblePicked ? '取消全选' : `全选（${visibleRows.length}）`,
            ),
            h('span', { style: { ...NOTICE, marginLeft: 'auto' } }, `已选 ${picked.length} 条`),
          ),
          h(
            'div',
            { style: LIST },
            visibleGroups.length === 0
              ? h('div', { style: { ...NOTICE, padding: '14px 10px' } }, rows.length === 0 ? '没有可删除的会话。' : '没有匹配的会话。')
              : visibleGroups.map((group) => h(SessionPickGroup, {
                key: group.key,
                group,
                rows: group.rows,
                selection,
                collapsed: collapsed.has(group.key),
                disabled: busy,
                onToggleCollapsed: toggleCollapsed,
                onToggleGroup: toggleGroup,
                onToggleRow: toggleRow,
              })),
          ),
          anyRunning
            ? h('div', { style: NOTICE }, '标记为「运行中」的会话会在删除时跳过，其余照常删除。')
            : null,
          error === null ? null : h('div', { style: ERROR_BOX, role: 'alert' }, error),
        )

      return h(
        primitives.Modal,
        {
          open: true,
          onClose: close,
          closeLabel: '关闭',
          title: '批量删除会话',
          description: '聊天记录与列表索引都会被删除，无法恢复。',
          footer,
        },
        h('div', { style: SURFACE }, body),
      )
    }

    /**
     * The Session row's `...` menu entry: delete this one, or delete several
     * starting from this one.
     *
     * `sidebar.workspaces.session.menu.item` is a list slot rendered inside one
     * menu, so one registration can contribute both rows. They sit together on
     * purpose — batch deletion is a variation on the delete the user was already
     * looking for, not a separate destination.
     *
     * @param props - the captured row identity and the menu's open-state hook.
     */
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState }) {
      const label = displayTitle ? `「${displayTitle}」` : sessionId
      const trash = (size) => (typeof primitives.IconTrashOutlineRegular === 'function'
        ? h(primitives.IconTrashOutlineRegular, { size })
        : undefined)
      // Closing the menu (as the shipped rows do) keeps the row from unmounting
      // under its own popover once the deletion drops it from the list.
      const [, setMenuOpen] = useMenuOpenState()

      /** Report the outcome; the sidebar drops the row on its own. */
      const remove = async () => {
        // Read both facts first: after the Host answers, the deleted Session is
        // no longer in the Workspace snapshot, and the row that owns this
        // callback may already be unmounting.
        const navigation = workspaceNavigation()
        const wasOpen = mainSessionId(navigation) === sessionId
        const workspaceId = wasOpen ? workspaceOfSession(navigation, sessionId) : undefined

        let payload
        try {
          payload = await deleteOnHost(sessionId)
        }
        catch (error) {
          notify(`删除请求失败：${error?.message ?? error}`, 'warning')
          return
        }
        if (payload?.ok !== true) {
          notify(payload?.text ?? '删除失败。', 'warning')
          return
        }
        notify(payload.notice ?? `已删除「${payload.title ?? displayTitle ?? sessionId}」`)
        if (wasOpen) leaveDeletedSession(navigation, workspaceId)
      }

      const onSelect = () => {
        setMenuOpen(false)
        if (typeof window.confirm === 'function') {
          if (window.confirm(`彻底删除会话${label}？\n\n聊天记录与列表索引都会被删除，无法恢复。`)) {
            void remove()
          }
          return
        }
        // No dialog available: require a second, deliberate click.
        const now = Date.now()
        if (armed.id === sessionId && now - armed.at < ARM_MS) {
          armed = { id: '', at: 0 }
          void remove()
          return
        }
        armed = { id: sessionId, at: now }
        notify('再次点击「删除会话」即可确认删除。', 'warning')
      }

      /** Open the bulk dialog with this row already ticked. */
      const onSelectBatch = () => {
        // Close the menu first: the dialog portals over it, and a menu left open
        // behind a modal is both a focus trap and a visual artifact.
        setMenuOpen(false)
        setBatchOpen(true, sessionId)
      }

      return h(
        React.Fragment,
        null,
        h(
          primitives.MenuItemButton,
          {
            icon: trash(14),
            // The shared menu styles a destructive row (error text/icon, danger
            // hover fill) only when it is told, since component rows bypass data.
            danger: true,
            onSelect,
          },
          '删除会话…',
        ),
        h(
          primitives.MenuItemButton,
          { icon: trash(14), danger: true, onSelect: onSelectBatch },
          '批量删除会话…',
        ),
      )
    }

    /**
     * The frame-wide overlay entry.
     *
     * Hosts both surfaces this plugin raises over the shell: the transient notice
     * and the bulk dialog. One entry keeps their stacking order fixed, and the
     * layer itself is click-through, so keeping both here costs the app nothing.
     * @param props - injected standard selector hooks, forwarded to the dialog.
     */
    function FrameOverlay(props) {
      const current = useNotice()
      const open = useBatchOpen()
      const parts = []
      if (current !== null) parts.push(h(DeleteSessionToast, { key: 'toast', notice: current }))
      if (open.open) parts.push(h(BatchDeleteDialog, { key: 'batch', seed: open.seed, ...props }))
      if (parts.length === 0) return null
      return h(React.Fragment, null, ...parts)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        rootContext = ctx
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'session-delete',
          order: 900,
        }, DeleteSessionMenuItem))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-delete-toast',
          order: 900,
        }, FrameOverlay))
      },
    }
  },
})
