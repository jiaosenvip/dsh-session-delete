/**
 * Browser half of `dsh-session-delete`.
 *
 * Adds one row to the Session row menu (`sidebar.workspaces.session.menu.item`)
 * and one frame-wide notice surface (`shell.overlay`).
 *
 * Selecting the row asks for a confirmation, posts the Session id to the route
 * the Host half owns, and reports the outcome in a transient Toast. It never
 * reloads the page: the Host removes the Session from its own list when the
 * files go, so the sidebar row settles by itself, and a reload would only throw
 * away the open conversation and scroll position.
 *
 * When the deleted Session was the one on screen, the main area moves to a fresh
 * Session in the same Workspace (or back to its sessionless home), so the user
 * is not left reading a conversation that no longer exists.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const ROUTE = '/plugins/session-delete/delete'
    /** Armed id for the two-step fallback when the page has no `confirm` dialog. */
    let armed = { id: '', at: 0 }
    const ARM_MS = 6000

    // ---------------------------------------------------------------------
    // Notice store: the row menu lives inside the (soon unmounted) row, so the
    // outcome is published here and rendered by the frame-wide overlay entry.
    // ---------------------------------------------------------------------
    /** Current notice, or null when nothing is showing. */
    let notice = null
    /** Monotonic identity; a new value remounts the Toast so its timer restarts. */
    let noticeSeq = 0
    const listeners = new Set()

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

    /** The frame-wide notice entry; renders nothing while no notice is pending. */
    function DeleteSessionToast() {
      const current = useNotice()
      if (current === null) return null
      const warning = current.tone === 'warning'
      const icon = warning && typeof primitives.IconWarningOutlineRegular === 'function'
        ? React.createElement(primitives.IconWarningOutlineRegular, {})
        : undefined
      return React.createElement(
        primitives.Toast,
        {
          text: current.text,
          onDone: dismissNotice,
          ...(warning ? {} : { tone: 'success' }),
          ...(icon === undefined ? {} : { icon }),
        },
        current.seq,
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

    // ---------------------------------------------------------------------
    // Leaving the page that was showing the deleted conversation.
    // ---------------------------------------------------------------------

    /** Client root Context, kept for the navigation service lookup below. */
    let rootContext

    /** The Client `uiWorkspace` navigation service, when the composition has one. */
    function workspaceNavigation() {
      try {
        return rootContext?.get?.('uiWorkspace')
      }
      catch {
        return undefined
      }
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

    /** Report the outcome; the sidebar drops the row on its own. */
    async function remove(sessionId, displayTitle) {
      // Read both facts first: after the Host answers, the deleted Session is no
      // longer in the Workspace snapshot, and the row that owns this callback may
      // already be unmounting.
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

    /** One Session row inside its `...` menu. */
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState }) {
      const label = displayTitle ? `「${displayTitle}」` : sessionId
      // Same mark the shipped rows use for a destructive action.
      const icon = typeof primitives.IconTrashOutlineRegular === 'function'
        ? React.createElement(primitives.IconTrashOutlineRegular, { size: 14 })
        : undefined
      // Closing the menu (as the shipped rows do) keeps the row from unmounting
      // under its own popover once the deletion drops it from the list.
      const [, setMenuOpen] = useMenuOpenState()
      const onSelect = () => {
        setMenuOpen(false)
        if (typeof window.confirm === 'function') {
          if (window.confirm(`彻底删除会话${label}？\n\n聊天记录与列表索引都会被删除，无法恢复。`)) {
            void remove(sessionId, displayTitle)
          }
          return
        }
        // No dialog available: require a second, deliberate click.
        const now = Date.now()
        if (armed.id === sessionId && now - armed.at < ARM_MS) {
          armed = { id: '', at: 0 }
          void remove(sessionId, displayTitle)
          return
        }
        armed = { id: sessionId, at: now }
        notify('再次点击「删除会话」即可确认删除。', 'warning')
      }

      return React.createElement(
        primitives.MenuItemButton,
        { icon, onSelect },
        '删除会话…',
      )
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
        }, DeleteSessionToast))
      },
    }
  },
})
