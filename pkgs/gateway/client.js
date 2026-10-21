window.__ModuleLoader__.load({
  id: '@yiln-dsh/dsh-gateway',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const NS = 'gateway'
    const h = React.createElement

    const ZH = {
      title: '联邦网关',
      hint: '一个入口，多个环境。每个环境是另一台机器上的完整 dsh：它自己跑工具、自己存会话，所以没有网络延迟。',
      refresh: '刷新',
      unreachable: '无法读取守护状态（管理接口只接受已登录的请求）。',
      empty: '还没有环境。创建一个，把 token 填到那台机器的 dsh 配置里。',
      online: '在线', offline: '离线',
      open: '打开', rotate: '换令牌', remove: '移除',
      labelLabel: '名称', labelPlaceholder: '例如 6.13',
      rename: '改名', renamePrompt: '新的名称', renamed: '已改名',
      sectionEnvironments: '环境',
      create: '创建环境', creating: '创建中…',
      tokenOnce: '这个令牌只显示一次，请现在复制',
      tokenHint: '把它填到那台机器 dsh 的 daemon 配置：role=edge，并填上主节点地址。',
      confirmRemove: '移除环境 {id}？那台机器上的 dsh 不会被删除，只是不再连进来。',
      confirmRotate: '为 {id} 换一个新令牌？旧令牌立即失效，那台机器要改成新令牌才能重连。',
      removed: '已移除 {id}。', rotated: '已为 {id} 换令牌。',
      actionFailed: '操作失败：{message}',
      edgeNote: '这台 dsh 是边端：它连向主节点，自己不管理其它环境。要在这里管理环境，把 role 改成 main。',
      switcherLabel: '当前环境：',
      switcherLocal: '本机',
      switcherOffline: '（离线）',
      switcherTitle: '切换环境：打开另一台机器上的 dsh',
      tabEnvironment: '环境',
      tabCredential: '凭据',
      tabSessions: '会话',
      credentialSection: '更换配对凭据',
      credentialHint: '凭据是进入这台 dsh 的钥匙。更换后，除当前会话外的其它会话都会退出登录。',
      credentialCurrent: '当前凭据',
      credentialNew: '新凭据',
      credentialConfirm: '确认新凭据',
      credentialSubmit: '更换凭据',
      credentialSubmitting: '更换中…',
      credentialChanged: '凭据已更换，其它会话已退出登录。',
      credentialCurrentRequired: '请先填写当前凭据。',
      credentialEmpty: '新凭据不能为空。',
      credentialTooShort: '新凭据至少 {count} 个字符。',
      credentialMismatch: '两次输入的新凭据不一致。',
      credentialWrongCurrent: '当前凭据不正确。',
      credentialFailed: '更换失败：{message}',
      sessionsSection: '跨节点会话',
      sessionsPartial: '有节点没有应答，下表不完整。',
      sessionsLoading: '读取会话中…',
      sessionsUnreachable: '无法读取会话列表。',
      sessionsUnreadable: '这个节点没有应答，它的会话未知。',
      sessionsEmptyNode: '这个节点上没有会话。',
      sessionCurrent: '当前会话',
      colNode: '节点', colAddress: '客户端地址', colClient: '客户端类型',
      colLastSeen: '最后活动', colIssued: '签发时间', colExpires: '过期时间', colSessionId: '标识',
      nodeSelf: '本机', nodeTimeout: '超时', nodeError: '报错',
    }

    const EN = {
      title: 'Federation gateway',
      hint: 'One entry, many environments. Each is a complete dsh on another machine: it runs its own tools and keeps its own sessions, so there is no network latency.',
      refresh: 'Refresh',
      unreachable: 'Could not read daemon state (the admin API only answers authenticated requests).',
      empty: 'No environments yet. Create one and put its token in that machine\'s dsh config.',
      online: 'online', offline: 'offline',
      open: 'Open', rotate: 'Rotate token', remove: 'Remove',
      labelLabel: 'Name', labelPlaceholder: 'e.g. 6.13',
      rename: 'Rename', renamePrompt: 'New name', renamed: 'Renamed',
      sectionEnvironments: 'Environments',
      create: 'Create environment', creating: 'Creating…',
      tokenOnce: 'This token is shown once — copy it now',
      tokenHint: 'Put it in that machine\'s dsh daemon config: role=edge, plus this node\'s address.',
      confirmRemove: 'Remove environment {id}? The dsh on that machine stays; it just stops connecting here.',
      confirmRotate: 'Give {id} a new token? The old one stops working immediately, and that machine must be updated before it can reconnect.',
      removed: 'Removed {id}.', rotated: 'New token issued for {id}.',
      actionFailed: 'Failed: {message}',
      edgeNote: 'This dsh is an edge: it connects to a main node and manages no environments itself. Set role to main to manage them here.',
      switcherLabel: 'Current environment:',
      switcherLocal: 'This host',
      switcherOffline: ' (offline)',
      switcherTitle: 'Switch environment: open the dsh on another machine',
      tabEnvironment: 'Environments',
      tabCredential: 'Credential',
      tabSessions: 'Sessions',
      credentialSection: 'Change the pairing credential',
      credentialHint: 'The credential is the key to this dsh. Changing it signs out every session except this one.',
      credentialCurrent: 'Current credential',
      credentialNew: 'New credential',
      credentialConfirm: 'Confirm the new credential',
      credentialSubmit: 'Change credential',
      credentialSubmitting: 'Changing…',
      credentialChanged: 'Credential changed. Other sessions were signed out.',
      credentialCurrentRequired: 'Enter the current credential first.',
      credentialEmpty: 'The new credential must not be empty.',
      credentialTooShort: 'The new credential must be at least {count} characters.',
      credentialMismatch: 'The two new entries do not match.',
      credentialWrongCurrent: 'The current credential is not correct.',
      credentialFailed: 'Could not change the credential: {message}',
      sessionsSection: 'Sessions across nodes',
      sessionsPartial: 'Some nodes did not answer, so this table is incomplete.',
      sessionsLoading: 'Reading sessions…',
      sessionsUnreachable: 'Could not read the session list.',
      sessionsUnreadable: 'This node did not answer, so its sessions are unknown.',
      sessionsEmptyNode: 'No sessions on this node.',
      sessionCurrent: 'this session',
      colNode: 'Node', colAddress: 'Client address', colClient: 'Client type',
      colLastSeen: 'Last activity', colIssued: 'Issued', colExpires: 'Expires', colSessionId: 'ID',
      nodeSelf: 'This host', nodeTimeout: 'timed out', nodeError: 'error',
    }

    /**
     * Panel styles.
     *
     * Every value here is taken from the Plugin Market's own stylesheet
     * (`dshmarket/src/client/Market.module.css`), not inferred from the rendered page:
     *
     *   .root   container-type:inline-size, so the panel is a query container
     *   .head   flex column, gap 12, padding 4px 4px 6px
     *   .title  16px / 24px / 500
     *   .sub    12px / 18px / label-tertiary
     *   .body   padding 12px 4px 64px
     *   .card   bg layer-1, 1px border-l2, radius 12, padding 12px 14px,
     *           flex COLUMN with gap 12
     *   .nm     15px / 22px / 600
     *   .desc   12px / 18px / label-tertiary
     *   .meta   11px
     *   .tag    11px / 16px, padding 1px 6px, radius 4
     *
     * Reading the source is why the earlier attempts kept missing: the values visible
     * in the DOM at one viewport width are the *computed* result of container queries,
     * so they were right for that width and wrong for the design.
     */
    const INK = '#1f2328'
    const SECONDARY = '#5c6570'
    const TERTIARY = '#8b93a1'
    const HAIRLINE = '#e5e7eb'
    const styles = {
      /** `.root`: a query container, so the panel measures against itself. */
      root: {
        height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0,
        color: INK, position: 'relative', containerType: 'inline-size',
        // One column for the head and the body. The market's host surface holds this
        // width by growing padding; standing alone, the panel sets it here so the two
        // regions cannot disagree about where their content starts.
        maxWidth: 968, width: '100%', margin: '0 auto', boxSizing: 'border-box',
        // `.panelHost` in the market's stylesheet: the 28px clears the window frame's top
        // controls. The CSS variable lets a host add to it; absent one, it is 28px.
        paddingTop: 'calc(28px + var(--dsh-frame-top-clearance, 0px))',
      },
      /** `.head`: title and sub share one column with a 12px gap. */
      head: { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0 6px' },
      /** `.titleRow`: heading and its actions on one baseline. */
      titleRow: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px 10px' },
      titleText: { fontSize: 16, lineHeight: '24px', fontWeight: 500, margin: 0, whiteSpace: 'nowrap' },
      /** `.sub`: the description under the title. */
      hint: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, lineHeight: '18px', color: TERTIARY, margin: 0 },
      /**
       * `.body`: the scrolling region.
       *
       * The market's own `.body` has only 4px of side padding because the surface that
       * hosts it keeps the content at 960px by growing padding instead of setting a
       * width — its computed padding is `4px 185.5px 6px` at this viewport. Standing
       * alone here, the panel has to hold that width itself, or the content stretches
       * to the full window and stops matching at any width past ~1300px.
       */
      wrap: { flex: 1, padding: '12px 0 64px', minWidth: 0 },
      /** `.sectionTitle`: an h3-sized heading inside the body. */
      sectionTitle: { fontSize: 13, fontWeight: 600, color: INK, lineHeight: '20px', margin: '0 0 8px', padding: '0 4px' },
      /** `.card`: a COLUMN — content first, then its footer. */
      card: {
        background: '#fff', border: `1px solid ${HAIRLINE}`, borderRadius: 12,
        padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12,
        alignSelf: 'start', minWidth: 0,
      },
      /** `.row1`: name and the action cluster on one line. */
      cardRow: { display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0 },
      cardMain: { flex: '1 1 auto', minWidth: 0 },
      /** `.nm`: the name carries the card, so it is the one thing sized up. */
      cardName: {
        fontWeight: 600, fontSize: 15, lineHeight: '22px',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      /** `.byline`: the row under the name. */
      cardMeta: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, marginTop: 2, flexWrap: 'wrap' },
      cardActions: { flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      /** `.meta`: 11px, not 12. */
      detail: { fontSize: 11, color: TERTIARY, marginTop: 2 },
      mono: { fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 11, color: SECONDARY },
      dim: { fontSize: 12, color: TERTIARY },
      ok: { color: '#16a34a', fontSize: 12 },
      error: { color: '#dc2626', fontSize: 12 },
      /** `.tag`: 1px 6px, radius 4, 11px over a 16px line. */
      tag: {
        border: '1px solid #d9dde3', color: SECONDARY, borderRadius: 4,
        flexShrink: 0, padding: '1px 6px', fontSize: 11, lineHeight: '16px', whiteSpace: 'nowrap',
      },
      tagOk: {
        border: '1px solid #d9dde3', color: '#16a34a', borderRadius: 4,
        flexShrink: 0, padding: '1px 6px', fontSize: 11, lineHeight: '16px', whiteSpace: 'nowrap',
      },
      note: {
        padding: '12px 14px', borderRadius: 12, border: `1px solid ${HAIRLINE}`,
        background: '#fff', color: TERTIARY, fontSize: 12,
      },
      /** The market's pill: 28px tall, 8px radius. */
      button: {
        height: 28, padding: '0 10px', fontSize: 12, cursor: 'pointer', borderRadius: 8,
        border: `1px solid ${HAIRLINE}`, background: 'transparent', color: INK,
        display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap',
      },
      buttonPrimary: {
        height: 28, padding: '0 12px', fontSize: 12, cursor: 'pointer', borderRadius: 8,
        border: 'none', background: INK, color: '#fff',
        display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap',
      },
      buttonDanger: {
        height: 28, padding: '0 10px', fontSize: 12, cursor: 'pointer', borderRadius: 8,
        border: '1px solid rgba(220,38,38,.3)', background: 'transparent', color: '#dc2626',
        display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap',
      },
      input: {
        height: 28, padding: '0 10px', fontSize: 12, borderRadius: 8,
        border: `1px solid ${HAIRLINE}`, background: '#fff', color: INK, boxSizing: 'border-box',
      },
      form: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' },
      formLabel: { fontSize: 12, color: SECONDARY, whiteSpace: 'nowrap' },
      /** `.grid`: exactly two columns, as the market defines it. */
      grid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', alignItems: 'start', gap: 10 },
      tokenBox: {
        padding: '12px 14px', borderRadius: 12,
        background: '#fdf3e3', border: '1px solid #f3e3c3',
      },
      tokenTitle: { fontSize: 12, fontWeight: 600, color: INK, marginBottom: 6 },
      tokenCode: {
        display: 'block', fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 11,
        wordBreak: 'break-all', userSelect: 'all', color: INK,
      },
      // The seat container (`sidebar.footer.action`) is `display: contents`, so it has no
      // width to inherit: a flex row there sizes to its content and the select would
      // collapse to its text. Stretching to the parent's content box is what gives the
      // select the remaining horizontal space.
      switcher: {
        display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px', fontSize: 12,
        width: '100%', boxSizing: 'border-box',
      },
      switcherLabel: { flex: 'none', opacity: 0.65, fontSize: 11, whiteSpace: 'nowrap' },
      // `flex: 1` with `minWidth: 0` is what lets it take the remaining width: without the
      // zero minimum a flex item refuses to shrink below its content, so a long
      // environment label would push the row wider instead of truncating.
      switcherSelect: {
        flex: '1 1 auto', minWidth: 0, padding: '3px 6px', fontSize: 12, borderRadius: 5,
        border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit',
        textOverflow: 'ellipsis',
      },
      /** The tab strip: one underline under the open page. */
      tabs: { display: 'flex', alignItems: 'center', gap: 4, borderBottom: `1px solid ${HAIRLINE}` },
      tab: {
        height: 28, padding: '0 10px', fontSize: 12, cursor: 'pointer', borderRadius: 0,
        border: 'none', borderBottom: '2px solid transparent', background: 'transparent',
        color: SECONDARY, display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap',
      },
      tabActive: {
        height: 28, padding: '0 10px', fontSize: 12, cursor: 'pointer', borderRadius: 0,
        border: 'none', borderBottom: `2px solid ${INK}`, background: 'transparent',
        color: INK, fontWeight: 600, display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap',
      },
      /** The credential form: one labelled field per line, nothing beside it. */
      fieldColumn: { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 360 },
      field: { display: 'flex', flexDirection: 'column', gap: 6 },
      fieldLabel: { fontSize: 12, color: SECONDARY },
      /** The session table: hairline rows on the same white surface as the cards. */
      tableBox: { background: '#fff', border: `1px solid ${HAIRLINE}`, borderRadius: 12, overflow: 'auto' },
      table: { width: '100%', borderCollapse: 'collapse' },
      th: {
        textAlign: 'left', fontSize: 11, fontWeight: 600, color: SECONDARY, padding: '8px 10px',
        borderBottom: `1px solid ${HAIRLINE}`, background: '#fafbfc', whiteSpace: 'nowrap',
      },
      td: {
        fontSize: 11, color: INK, padding: '8px 10px',
        borderBottom: `1px solid ${HAIRLINE}`, verticalAlign: 'top',
      },
      /** A node that did not answer: red like the error text, but a tag, not a sentence. */
      tagDanger: {
        border: '1px solid rgba(220,38,38,.3)', color: '#dc2626', borderRadius: 4,
        flexShrink: 0, padding: '1px 6px', fontSize: 11, lineHeight: '16px', whiteSpace: 'nowrap',
      },
      warn: { fontSize: 12, color: '#b45309' },
    }

    /**
     * Request one of this daemon's own routes.
     *
     * The path is resolved against `document.baseURI`, not the origin: the GUI is
     * served under an environment prefix (`/main/`, `/env-6-13/`), and a
     * root-absolute path escapes it — the request lands on the prefix-less route,
     * which is answered by the login page instead of the admin API. The leading
     * slash is stripped before resolving because `new URL('/admin/state', base)`
     * resolves against the *origin root* and would put the bug straight back.
     *
     * Resolving here rather than at each call site is what covers every one of them,
     * including the ones that build the path from an environment id.
     */
    const call = async (path, options) => {
      const response = await fetch(new URL(path.replace(/^\//u, ''), document.baseURI), {
        credentials: 'same-origin',
        ...options,
      })
      const text = await response.text()
      try {
        const parsed = JSON.parse(text)
        // The status is not in the body, and the credential form has to tell a wrong
        // current credential (403) from a rejected new one (400) without reading the
        // daemon's English prose. Annotating the parsed object keeps one helper.
        return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? { ...parsed, status: response.status }
          : parsed
      } catch {
        return { ok: false, status: response.status, error: `HTTP ${response.status}: ${text.slice(0, 200)}` }
      }
    }

    /**
     * The three pages the panel offers.
     *
     * Ids, not indices: the open tab is component state, and reordering the strip must
     * never silently change which page is showing.
     */
    const PANEL_TABS = [
      { id: 'environment', labelKey: 'tabEnvironment' },
      { id: 'credential', labelKey: 'tabCredential' },
      { id: 'sessions', labelKey: 'tabSessions' },
    ]

    /** The page the panel opens on: the environment list, unchanged. */
    const DEFAULT_TAB = 'environment'

    /**
     * The shortest new credential the daemon will accept.
     *
     * `PAIRING_CREDENTIAL_MIN_LENGTH` on the daemon is the authority; the form repeats
     * the number only so an obviously short entry is refused without a round trip.
     * `panel-tabs.test.js` holds the two equal, so this copy cannot drift from the rule.
     */
    const CREDENTIAL_MIN_LENGTH = 12

    /**
     * What is wrong with the credential form, as a dictionary key; `null` when it is
     * worth submitting.
     *
     * Judged here, before anything is sent: a mismatch or a short entry is a typo, not
     * a question for the server, and the answer belongs next to the field. Nothing is
     * compared against the credential in force — the page does not have it.
     *
     * @param form - `{ current, password, confirm }` as typed.
     * @returns a key of the panel's dictionary, or `null`.
     */
    const credentialProblem = (form) => {
      const current = String(form?.current ?? '')
      const password = String(form?.password ?? '')
      const confirm = String(form?.confirm ?? '')
      if (current === '') return 'credentialCurrentRequired'
      if (password === '') return 'credentialEmpty'
      if (password.length < CREDENTIAL_MIN_LENGTH) return 'credentialTooShort'
      if (confirm !== password) return 'credentialMismatch'
      return null
    }

    /**
     * Ask the daemon to replace the pairing credential.
     *
     * The form is judged first, so an invalid entry never reaches the network. The
     * answer is reduced to what the page shows: success, or which refusal it was. No
     * part of the credential is read back, because the endpoint returns none.
     *
     * @param form - `{ current, password, confirm }` as typed.
     * @param post - sends one change; resolved with the parsed answer.
     * @returns `{ phase: 'invalid' | 'done' | 'failed', problem?, status?, error? }`.
     */
    const changeCredential = async (form, post) => {
      const problem = credentialProblem(form)
      if (problem !== null) return { phase: 'invalid', problem }
      const answer = await post({
        current: form.current,
        password: form.password,
        confirm: form.confirm,
      })
      if (answer?.ok === true) return { phase: 'done' }
      return { phase: 'failed', status: answer?.status, error: answer?.error }
    }

    /**
     * The line under the credential form, for one outcome.
     *
     * The status is what separates a wrong current credential (403) from a rejected
     * new one (400) without reading the daemon's prose, which is English whatever the
     * reader's language is. The carried message is kept for the cases the panel has no
     * copy for, because a reason in the wrong language beats no reason.
     */
    const credentialOutcomeText = (t, outcome) => {
      if (outcome?.phase === 'done') return t('credentialChanged')
      if (outcome?.phase === 'invalid') {
        return t(outcome.problem).replace('{count}', String(CREDENTIAL_MIN_LENGTH))
      }
      if (outcome?.status === 403) return t('credentialWrongCurrent')
      return t('credentialFailed').replace('{message}', outcome?.error ?? '')
    }

    /** The dictionary key for a node state that stopped it answering. */
    const nodeStateKey = (state) => (
      state === 'offline' ? 'offline' : state === 'timeout' ? 'nodeTimeout' : 'nodeError'
    )

    /**
     * The name a node is shown under.
     *
     * The registry's label wins. A node that answered without one — this host, whose id
     * is the reserved `self` — gets the panel's own name for it rather than an id that
     * means nothing to a reader.
     */
    const nodeDisplayName = (node, selfLabel) => {
      if (typeof node?.label === 'string' && node.label !== '') return node.label
      if (node?.id === 'self') return selfLabel
      return String(node?.id ?? '')
    }

    /** A timestamp in the reader's locale, or an em dash when there is none. */
    const formatTime = (value) => (
      typeof value === 'number' && Number.isFinite(value) ? new Date(value).toLocaleString() : '—'
    )

    /**
     * Turn a `/admin/sessions` answer into the rows the table draws.
     *
     * One entry per session, plus one entry for every node that produced no rows. That
     * second kind is the point of this function: the answer omits `sessions` entirely
     * on a node that did not answer, so a renderer that only walked the session lists
     * would draw an offline machine exactly like a machine nobody is signed in on.
     * Unreadable nodes therefore become `unreadable` entries carrying their state and
     * error, and a node that answered with nothing becomes an `empty` entry — two
     * different things, said differently.
     *
     * @param payload - the parsed `/admin/sessions` body.
     * @returns `{ partial, entries }`; `partial` is true when any node did not answer.
     */
    const sessionView = (payload) => {
      const nodes = Array.isArray(payload?.nodes) ? payload.nodes : []
      const entries = []
      for (const node of nodes) {
        const id = String(node?.id ?? '')
        const label = typeof node?.label === 'string' ? node.label : undefined
        // A node that is not `ok` has no session list at all, whatever else the answer
        // carries: its rows are unknown, not empty.
        if (node?.state !== 'ok' || !Array.isArray(node?.sessions)) {
          entries.push({
            kind: 'unreadable',
            node: {
              id,
              label,
              state: String(node?.state ?? 'error'),
              error: String(node?.error ?? ''),
            },
          })
          continue
        }
        if (node.sessions.length === 0) {
          entries.push({ kind: 'empty', node: { id, label, state: 'ok' } })
          continue
        }
        for (const session of node.sessions) {
          entries.push({
            kind: 'session',
            node: { id, label, state: 'ok' },
            session: {
              id: String(session?.id ?? ''),
              address: String(session?.address ?? ''),
              userAgent: String(session?.userAgent ?? ''),
              issuedAt: session?.issuedAt,
              lastSeenAt: session?.lastSeenAt,
              expiresAt: session?.expiresAt,
              current: session?.current === true,
            },
          })
        }
      }
      return {
        // The daemon's flag is trusted, but an unreadable node is proof on its own: an
        // incomplete table that claims to be complete is the failure this view exists
        // to prevent.
        partial: payload?.partial === true || entries.some((entry) => entry.kind === 'unreadable'),
        entries,
      }
    }

    /** Rail icon for the global panel list. */
    const PanelIcon = () => h('svg', {
      width: 18,
      height: 18,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
    h('rect', { key: 'a', x: 3, y: 4, width: 18, height: 6, rx: 2 }),
    h('rect', { key: 'b', x: 3, y: 14, width: 18, height: 6, rx: 2 }),
    h('circle', { key: 'c', cx: 7, cy: 7, r: 0.9, fill: 'currentColor', stroke: 'none' }),
    h('circle', { key: 'd', cx: 7, cy: 17, r: 0.9, fill: 'currentColor', stroke: 'none' }))

    /** Panel page: the environment list, the credential form and the session table. */
    const makePanelPage = (t) => function DaemonPanelPage() {
      // Which page is open. Component state only: a reload opens on the environment
      // list again, and the address bar never learns about it.
      const [tab, setTab] = useState(DEFAULT_TAB)
      const [state, setState] = useState({ phase: 'loading', self: undefined, environments: [] })
      const [busy, setBusy] = useState('')
      const [flash, setFlash] = useState('')
      const [token, setToken] = useState('')
      const [label, setLabel] = useState('')
      // The credential form and its outcome. Nothing about the credential in force is
      // held here: the page never receives it, so it cannot show it.
      const [form, setForm] = useState({ current: '', password: '', confirm: '' })
      const [credential, setCredential] = useState({ phase: 'idle' })
      // The session table. `idle` means "not asked yet": the request is made the first
      // time the page is opened, so a panel nobody opens costs no node a probe.
      const [sessions, setSessions] = useState({ phase: 'idle', partial: false, entries: [] })

      const load = useCallback(async () => {
        try {
          const result = await call('/admin/state')
          if (result.ok) setState({ phase: 'ready', self: result.self, environments: result.environments ?? [] })
          else setState({ phase: 'failed', self: undefined, environments: [], error: result.error })
        } catch (error) {
          setState({ phase: 'failed', self: undefined, environments: [], error: String(error) })
        }
      }, [])

      useEffect(() => { void load() }, [load])

      const create = useCallback(async () => {
        setBusy('create')
        setFlash('')
        setToken('')
        try {
          const result = await call('/admin/environments', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ label: label.trim() }),
          })
          if (result.ok) {
            // Shown once: the token is the edge's credential, not a display value.
            setToken(result.token)
            setLabel('')
            await load()
          } else {
            setFlash(t('actionFailed').replace('{message}', result.error ?? ''))
          }
        } finally {
          setBusy('')
        }
      }, [label, load, t])

        /**
         * Rename one environment.
         *
         * Only the label changes. The id is the node identifier and the URL is built from
         * it, so renaming must never move the address a bookmark points at.
         */
        const rename = useCallback(async (entry) => {
          const next = window.prompt(t("renamePrompt"), entry.label)
          if (next === null) return
          const label = next.trim()
          if (label === "" || label === entry.label) return
          setBusy(entry.id)
          setFlash("")
          try {
            const result = await call(`/admin/environments/${entry.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ label }),
            })
            setFlash(result.ok ? `${t("renamed")}: ${label}` : t("actionFailed").replace("{message}", result.error ?? ""))
            if (result.ok) await load()
          } finally {
            setBusy("")
          }
        }, [load, t])

      const remove = useCallback(async (entry) => {
        if (!confirm(t('confirmRemove').replace('{id}', entry.id))) return
        setBusy(entry.id)
        try {
          const result = await call(`/admin/environments/${entry.id}`, { method: 'DELETE' })
          setFlash(result.ok ? t('removed').replace('{id}', entry.id) : t('actionFailed').replace('{message}', result.error ?? ''))
          await load()
        } finally {
          setBusy('')
        }
      }, [load, t])

      const rotate = useCallback(async (entry) => {
        if (!confirm(t('confirmRotate').replace('{id}', entry.id))) return
        setBusy(entry.id)
        try {
          const result = await call(`/admin/environments/${entry.id}/token`, { method: 'POST' })
          if (result.ok) {
            setToken(result.token)
            setFlash(t('rotated').replace('{id}', entry.id))
            await load()
          } else {
            setFlash(t('actionFailed').replace('{message}', result.error ?? ''))
          }
        } finally {
          setBusy('')
        }
      }, [load, t])

      /**
       * Read the session table.
       *
       * Read-only, and asked once per panel: the fan-out is parallel, so an unreachable
       * node costs one relay timeout in total rather than one per machine — still long
       * enough that the request is made when the page is opened and on an explicit
       * refresh, never on a timer.
       */
      const loadSessions = useCallback(async () => {
        setSessions((previous) => ({ ...previous, phase: 'loading' }))
        try {
          const result = await call('/admin/sessions')
          if (result?.ok === true) setSessions({ phase: 'ready', ...sessionView(result) })
          else setSessions({ phase: 'failed', partial: false, entries: [], error: result?.error })
        } catch (error) {
          setSessions({ phase: 'failed', partial: false, entries: [], error: String(error) })
        }
      }, [])

      // The table is fetched the first time its page is opened: a panel nobody opens
      // must not cost every node a probe.
      useEffect(() => {
        if (tab === 'sessions' && sessions.phase === 'idle') void loadSessions()
      }, [tab, sessions.phase, loadSessions])

      /**
       * Submit the credential form.
       *
       * `changeCredential` refuses an invalid form before `post` is called, so a typo
       * never becomes a request. On success the fields are cleared: what was typed is
       * the credential, and it does not stay on screen after it has been accepted.
       */
      const submitCredential = useCallback(async () => {
        setCredential({ phase: 'sending' })
        try {
          const outcome = await changeCredential(form, (body) => call('/admin/credential', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }))
          if (outcome.phase === 'done') setForm({ current: '', password: '', confirm: '' })
          setCredential(outcome)
        } catch (error) {
          setCredential({ phase: 'failed', error: String(error) })
        }
      }, [form])

      const role = state.self?.role ?? 'main'

      /**
       * The environment page, exactly as it was before the tabs existed: the list, the
       * create form and the one-time token box.
       */
      const environmentPage = () => {
        const parts = []
        if (flash !== '') parts.push(h('div', { key: 'flash', style: styles.ok }, flash))

        if (token !== '') {
          parts.push(h('div', { key: 'token', style: styles.tokenBox },
            h('div', { style: styles.tokenTitle }, t('tokenOnce')),
            h('code', { style: styles.tokenCode }, token),
            h('p', { style: styles.hint }, t('tokenHint'))))
        }

        if (state.phase === 'failed') parts.push(h('div', { key: 'error', style: styles.error }, t('unreachable')))

        if (role !== 'main') {
          parts.push(h('div', { key: 'edge', style: styles.note }, t('edgeNote')))
          return parts
        }

        // One card per environment, matching how the Plugin Market draws its records:
        // name and metadata on the left, actions as pills on the right.
        const cards = state.environments.map((entry) => h('div', { key: entry.id, style: styles.card },
          // `.row1`: the name (and what it is) on the left, its actions on the right.
          h('div', { style: styles.cardRow },
            h('div', { style: styles.cardMain },
              h('div', { style: styles.cardName }, entry.label),
              h('div', { style: styles.cardMeta },
                h('span', { style: entry.online ? styles.tagOk : styles.tag },
                  entry.online ? t('online') : t('offline')),
                // Status and path only: the token prefix that used to sit here is
                // still part of a credential, and nothing on this card needs it.
                  h('span', { style: styles.tag }, `/${entry.id}/`))),
            h('div', { style: styles.cardActions },
            entry.online
              ? h('button', { key: 'open', style: styles.button, onClick: () => window.open(`/${entry.id}/`, '_blank') }, t('open'))
              : null,
            // The name is the only thing an operator can change: the id is the node's
            // identity and its URL is built from it.
            h('button', { key: 'rename', style: styles.button, disabled: busy !== '', onClick: () => void rename(entry) }, t('rename')),
            h('button', { key: 'rot', style: styles.button, disabled: busy !== '', onClick: () => void rotate(entry) }, t('rotate')),
            h('button', { key: 'rm', style: styles.buttonDanger, disabled: busy !== '', onClick: () => void remove(entry) }, t('remove')))),
          // `.meta`: the quiet second line, when there is one.
          entry.hostname === undefined && entry.online
            ? null
            : h('div', { style: styles.detail },
              [entry.hostname, entry.online || entry.lastSeen === undefined
                ? null
                : new Date(entry.lastSeen).toLocaleString()].filter(Boolean).join(' · '))))

        parts.push(h('div', { key: 'list' },
          h('div', { style: styles.sectionTitle }, t('sectionEnvironments')),
          state.environments.length === 0
            ? h('div', { style: styles.note }, t('empty'))
            : h('div', { style: styles.grid }, cards),
          h('div', { key: 'form', style: styles.form },
            h('label', { key: 'l', style: styles.formLabel }, t('labelLabel')),
            h('input', {
              key: 'i', style: styles.input, value: label,
              placeholder: t('labelPlaceholder'),
              onChange: (event) => setLabel(event.target.value),
            }),
            h('button', { key: 'b', style: styles.buttonPrimary, disabled: busy !== '', onClick: () => void create() },
              busy === 'create' ? t('creating') : t('create')))))
        return parts
      }

      /** One labelled credential field. Password inputs: what is typed is a secret. */
      const credentialField = (name, labelKey) => h('label', { key: name, style: styles.field },
        h('span', { style: styles.fieldLabel }, t(labelKey)),
        h('input', {
          style: styles.input,
          type: 'password',
          name,
          autoComplete: name === 'current' ? 'current-password' : 'new-password',
          value: form[name],
          disabled: credential.phase === 'sending',
          onChange: (event) => setForm((previous) => ({ ...previous, [name]: event.target.value })),
        }))

      /**
       * The credential page: three fields and their outcome, and nothing about the
       * credential in force — the page never receives it, so it has nothing to show.
       */
      const credentialPage = () => {
        const parts = [
          h('div', { key: 'title', style: styles.sectionTitle }, t('credentialSection')),
          h('p', { key: 'hint', style: styles.hint }, t('credentialHint')),
          h('div', { key: 'form', style: styles.fieldColumn },
            credentialField('current', 'credentialCurrent'),
            credentialField('password', 'credentialNew'),
            credentialField('confirm', 'credentialConfirm'),
            h('button', {
              key: 'submit',
              type: 'button',
              style: styles.buttonPrimary,
              disabled: credential.phase === 'sending',
              onClick: () => void submitCredential(),
            }, credential.phase === 'sending' ? t('credentialSubmitting') : t('credentialSubmit'))),
        ]
        // A failure is shown as the reason, a success as the one line it is.
        if (credential.phase === 'done' || credential.phase === 'invalid' || credential.phase === 'failed') {
          parts.push(h('div', {
            key: 'outcome',
            style: credential.phase === 'done' ? styles.ok : styles.error,
          }, credentialOutcomeText(t, credential)))
        }
        return parts
      }

      /** One row of the session table. */
      const sessionRow = (entry, index) => {
        if (entry.kind === 'session') {
          return h('tr', { key: `s${index}` },
            h('td', { style: styles.td }, nodeDisplayName(entry.node, t('nodeSelf'))),
            h('td', { style: styles.td }, entry.session.address),
            h('td', { style: styles.td, title: entry.session.userAgent }, entry.session.userAgent),
            h('td', { style: styles.td }, formatTime(entry.session.lastSeenAt)),
            h('td', { style: styles.td }, formatTime(entry.session.issuedAt)),
            h('td', { style: styles.td }, formatTime(entry.session.expiresAt)),
            h('td', { style: styles.td },
              h('code', { style: styles.mono }, entry.session.id),
              entry.session.current ? h('span', { style: styles.tagOk }, t('sessionCurrent')) : null))
        }
        const name = nodeDisplayName(entry.node, t('nodeSelf'))
        if (entry.kind === 'empty') {
          return h('tr', { key: `e${index}` },
            h('td', { style: styles.td }, name),
            h('td', { style: styles.td, colSpan: 6 },
              h('span', { style: styles.dim }, t('sessionsEmptyNode'))))
        }
        // Unreadable. The node is named, its state is a tag, and the reason is in the
        // row — never an empty session list, which would say "nobody is signed in
        // there", the one thing this node did not tell us.
        return h('tr', { key: `u${index}` },
          h('td', { style: styles.td },
            name,
            ' ',
            h('span', { style: styles.tagDanger }, t(nodeStateKey(entry.node.state)))),
          h('td', { style: styles.td, colSpan: 6 },
            h('span', { style: styles.error }, t('sessionsUnreadable')),
            entry.node.error === '' ? null : h('span', { style: styles.dim }, ` — ${entry.node.error}`)))
      }

      /** The session page: one table, read-only, with every node accounted for. */
      const sessionsPage = () => {
        const parts = [h('div', { key: 'title', style: styles.sectionTitle }, t('sessionsSection'))]
        // Say the table is incomplete before drawing it, not after.
        if (sessions.partial) parts.push(h('div', { key: 'partial', style: styles.warn }, t('sessionsPartial')))
        if (sessions.phase === 'failed') {
          parts.push(h('div', { key: 'error', style: styles.error }, t('sessionsUnreachable')))
          return parts
        }
        if (sessions.phase !== 'ready') {
          parts.push(h('div', { key: 'loading', style: styles.dim }, t('sessionsLoading')))
          return parts
        }
        const columns = ['colNode', 'colAddress', 'colClient', 'colLastSeen', 'colIssued', 'colExpires', 'colSessionId']
        parts.push(h('div', { key: 'table', style: styles.tableBox },
          h('table', { style: styles.table },
            h('thead', null,
              h('tr', null, columns.map((key) => h('th', { key, style: styles.th }, t(key))))),
            h('tbody', null, sessions.entries.map(sessionRow)))))
        return parts
      }

      const tabs = h('div', { key: 'tabs', style: styles.tabs },
        PANEL_TABS.map((entry) => h('button', {
          key: entry.id,
          type: 'button',
          'aria-pressed': tab === entry.id,
          style: tab === entry.id ? styles.tabActive : styles.tab,
          onClick: () => setTab(entry.id),
        }, t(entry.labelKey))))

      const head = [
        h('div', { key: 'title', style: styles.titleRow },
          h('span', { key: 'text', style: styles.titleText }, t('title')),
          // Nothing on the credential page is read from the daemon, so there is
          // nothing there to refresh.
          tab === 'credential'
            ? null
            : h('button', {
              key: 'refresh',
              style: styles.button,
              disabled: busy !== '',
              onClick: () => { if (tab === 'sessions') void loadSessions(); else void load() },
            }, t('refresh'))),
        h('p', { key: 'hint', style: styles.hint }, t('hint')),
        tabs,
      ]
      const body = tab === 'credential' ? credentialPage() : tab === 'sessions' ? sessionsPage() : environmentPage()

      // Mirrors the market's markup: a query container holding a head and a body.
      return h('div', { style: styles.root },
        h('div', { style: styles.head }, head),
        h('div', { style: styles.wrap }, body))
    }


    /**
     * Environment switcher in the sidebar footer.
     *
     * A plain `select` because it is a location, not a state: choosing one navigates.
     * The list is fetched once on mount and refreshed when the panel loads, since an
     * environment's online state changes without anything here noticing.
     */
    const makeSwitcher = (t) => function EnvironmentSwitcher() {
      const [state, setState] = useState({ phase: 'loading', role: 'main', current: '', environments: [] })

      useEffect(() => {
        let cancelled = false
        void (async () => {
          try {
            const result = await call('/admin/state')
            if (cancelled) return
            if (result.ok) {
              setState({
                phase: 'ready',
                role: result.self?.role ?? 'main',
                current: result.self?.rootPrefix ?? '',
                environments: result.environments ?? [],
              })
            } else {
              setState((prev) => ({ ...prev, phase: 'failed' }))
            }
          } catch {
            if (!cancelled) setState((prev) => ({ ...prev, phase: 'failed' }))
          }
        })()
        return () => { cancelled = true }
      }, [])

      // An edge has no other environments to offer, and no list to build one from.
      if (state.phase === 'loading' || state.role !== 'main' || state.environments.length === 0) return null

      // Where we are now, so the control shows the truth rather than a default.
      const path = window.location.pathname
      const active = state.current !== '' && (path === `/${state.current}` || path.startsWith(`/${state.current}/`))
        ? state.current
        : state.environments.map((one) => one.id).find((id) => path.startsWith(`/${id}/`)) ?? ''

      return h('label', { style: styles.switcher, title: t('switcherTitle') },
        h('span', { style: styles.switcherLabel }, t('switcherLabel')),
        h('select', {
          style: styles.switcherSelect,
          value: active,
          onChange: (event) => {
            const id = event.target.value
            window.location.href = id === '' ? '/' : `/${id}/`
          },
        },
        h('option', { value: '' }, t('switcherLocal')),
        // Offline environments stay in the list: removing them would read as deletion,
        // and the operator needs to see that a machine is simply unreachable.
        ...state.environments.map((one) => h('option', {
          key: one.id,
          value: one.id,
          disabled: one.online !== true,
        }, `${one.label}${one.online === true ? '' : t('switcherOffline')}`))))
    }

    const apply = (ctx) => {
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'daemon: locale')
      const t = ctx.locale.bind(NS)
      // Rail button …
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: 'gateway',
        order: 40,
        label: () => t('title'),
      }, PanelIcon)), 'gateway: panel entry')
      // … and the page it opens, keyed by the same id.
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: 'gateway',
        inject: () => ({}),
      }, makePanelPage(t))), 'gateway: panel page')
      // The switcher lives at the bottom of the sidebar: `sidebar.workspaces` is a
      // single slot owned upstream, so there is no "above the workspace list" to use.
      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'daemon-environment-switcher',
        order: -20,
        inject: () => ({}),
      }, makeSwitcher(t))), 'daemon: environment switcher')
    }

    return {
      name: 'daemon-client',
      inject: ['locale', 'slots'],
      apply,
      __test: {
        call,
        ZH,
        EN,
        PANEL_TABS,
        DEFAULT_TAB,
        CREDENTIAL_MIN_LENGTH,
        credentialProblem,
        changeCredential,
        credentialOutcomeText,
        nodeStateKey,
        nodeDisplayName,
        formatTime,
        sessionView,
      },
    }
  },
})
