/**
 * What another machine can ask this one about its workspaces and sessions.
 *
 * A model on one environment can address a session on another, but it cannot see what
 * exists over there. These two reads close that: the workspace table, and the sessions
 * inside one workspace. Both are **reads only** — nothing here creates, renames or
 * archives, so a remote peer can discover a target without being able to change it.
 *
 * The shapes are deliberately flat. The registry entities are rich objects with getters
 * and methods; sending one over a tunnel would ship a snapshot that silently loses both,
 * so every field below is a plain value a caller can act on.
 *
 * @module @yiln-dsh/dsh-gateway/remote-info
 */

/** Longest session list one call returns; the caller narrows by workspace. */
export const MAX_SESSIONS = 500

/**
 * One workspace, as a peer sees it.
 *
 * @param workspace - the registry entity.
 * @returns the flat row.
 */
export function workspaceRow(workspace) {
  return {
    workspaceId: workspace.id,
    title: workspace.title,
    path: workspace.path,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    sessionCount: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0,
  }
}

/**
 * List this node's workspaces.
 *
 * @param options.workspaces - the `workspaceRegistry` service.
 * @returns `{ ok: true, workspaces }` or `{ ok: false, error }`.
 * @throws never — a missing service is an answer, not an exception the caller must catch.
 */
export function listWorkspaces({ workspaces }) {
  if (workspaces === undefined) return { ok: false, error: 'this node has no workspace registry' }
  try {
    return { ok: true, workspaces: workspaces.list().map(workspaceRow) }
  } catch (error) {
    return { ok: false, error: `could not list workspaces: ${error?.message ?? error}` }
  }
}

/**
 * List the sessions inside one workspace.
 *
 * The header carries what a caller needs to pick a target — id, cwd, creation time,
 * parent — and the two flags that say whether the session is reachable right now:
 * `live` (an Agent exists for it here) and `persisted` (its log is readable).
 *
 * @param options.workspaces - `workspaceRegistry`; used to validate the workspace id.
 * @param options.sessions - `sessionQuery`; the corpus every session header comes from.
 * @param workspaceId - the workspace to enumerate; empty means every workspace.
 * @returns `{ ok: true, sessions }` or `{ ok: false, error }`.
 */
export function listSessions({ workspaces, sessions }, workspaceId) {
  if (sessions === undefined) return Promise.resolve({ ok: false, error: 'this node has no session query' })
  const wanted = String(workspaceId ?? '').trim()

  let ids
  if (wanted === '') {
    ids = undefined
  } else {
    if (workspaces === undefined) return Promise.resolve({ ok: false, error: 'this node has no workspace registry' })
    const workspace = workspaces.get(wanted)
    if (workspace === undefined) {
      // Answering an empty list for an unknown workspace would look like "it has no
      // sessions" and hide the typo.
      return Promise.resolve({ ok: false, error: `no such workspace: "${wanted}"` })
    }
    ids = new Set(workspace.sessionIds)
  }

  return sessions.listSessions().then((records) => {
    const rows = []
    for (const record of records) {
      const header = record.header
      if (header === undefined) continue
      if (ids !== undefined && !ids.has(header.id)) continue
      rows.push({
        sessionId: header.id,
        cwd: header.cwd ?? '',
        createdAt: header.createdAt,
        parentSession: header.parentSession ?? '',
        origin: header.origin ?? '',
        live: record.live === true,
        persisted: record.persisted === true,
      })
      if (rows.length >= MAX_SESSIONS) break
    }
    return { ok: true, sessions: rows }
  }).catch((error) => ({ ok: false, error: `could not list sessions: ${error?.message ?? error}` }))
}
