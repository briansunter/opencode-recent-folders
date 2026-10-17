// Pure logic for the recent-folders picker: no Solid, no host APIs, no I/O.
// Everything here is exercised by core.test.js under `bun test`.

// ---------------------------------------------------------------------------
// Error rendering. Rejections that cross an RPC boundary arrive as plain
// objects (e.g. { _tag: "RpcError", type, message, data }), not Error
// instances, so String(error) renders "[object Object]". Extract only
// known-safe string fields; the rest of the object is never serialized —
// an RpcError's `data` payload can carry request contents that must not
// be dumped into a toast or dialog.
// ---------------------------------------------------------------------------
export function errorMessage(error) {
  if (typeof error === "string") return error.trim() || "Unknown error."
  if (error !== null && typeof error === "object") {
    const message = typeof error.message === "string" ? error.message.trim() : ""
    if (message) return message
    const tag = ["_tag", "type", "code"].find(field => typeof error[field] === "string" && error[field].trim())
    return tag ? `${error[tag].trim()} (no message).` : "Unknown error."
  }
  if (error === undefined || error === null) return "Unknown error."
  return String(error) || "Unknown error."
}

// ---------------------------------------------------------------------------
// Folder switching. The TUI router stores routes in a Solid store and applies
// navigations with `reconcile`. reconcile mutates plain objects in place, so
// navigating home → home with a plain `location` object keeps the store's
// `location` reference stable; the Home screen's effect (which reads only
// `route.location` and pushes it into the location provider) never re-runs,
// and the new directory is never synced. A class instance is not wrappable,
// so reconcile replaces the reference on every navigation, the effect runs,
// and the provider performs the same set + server sync the built-in open
// menu triggers with its direct location.set call. `directory` stays the only
// own enumerable field, so the value serializes exactly like a LocationRef.
// ---------------------------------------------------------------------------
export class FolderLocation {
  constructor(directory) {
    this.directory = directory
  }
}

// ---------------------------------------------------------------------------
// Session / project folder discovery
// ---------------------------------------------------------------------------

/** Highest of time.viewed, time.updated, time.created; 0 when none is valid. */
export function lastActiveOf(session) {
  const time = session?.time
  if (!time || typeof time !== "object") return 0
  let best = 0
  for (const field of ["viewed", "updated", "created"]) {
    const value = time[field]
    if (typeof value === "number" && Number.isFinite(value) && value > best) best = value
  }
  return best
}

export function sessionDirectory(session) {
  const raw = session?.location?.directory ?? session?.directory
  return typeof raw === "string" && raw.trim() ? raw.trim() : ""
}

// The synthetic global project ("/") is not a folder anyone can open; the
// built-in open menu filters it out the same way.
export function projectDirectory(project) {
  const raw = project?.canonical
  if (typeof raw !== "string" || !raw.trim() || raw.trim() === "/") return ""
  return raw.trim()
}

export function projectActive(project) {
  const time = project?.time
  if (!time || typeof time !== "object") return 0
  let best = 0
  for (const field of ["active", "updated", "created"]) {
    const value = time[field]
    if (typeof value === "number" && Number.isFinite(value) && value > best) best = value
  }
  return best
}

/**
 * Merges sessions and projects into one folder record per directory:
 * `{ directory, lastActive, sessionCount, lastTitle, projectName, fromProject }`.
 * Sessions contribute per-directory counts, the title of the most recent
 * session, and recency from time.viewed/updated/created; projects add
 * directories that were opened without a session and their time.active.
 *
 * @param {readonly Record<string, unknown>[]} sessions
 * @param {readonly Record<string, unknown>[]} projects
 * @returns {Array<{ directory: string, lastActive: number, sessionCount: number, lastTitle: string, projectName: string, fromProject: boolean }>}
 */
export function buildFolderIndex(sessions, projects) {
  const folders = new Map()
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const directory = sessionDirectory(session)
    if (!directory) continue
    const active = lastActiveOf(session)
    const title = typeof session?.title === "string" && session.title.trim() ? session.title.trim() : ""
    const existing = folders.get(directory)
    if (!existing) {
      folders.set(directory, {
        directory,
        lastActive: active,
        sessionCount: 1,
        lastTitle: title,
        projectName: "",
        fromProject: false,
      })
    } else {
      existing.sessionCount += 1
      if (active >= existing.lastActive) {
        existing.lastActive = active
        if (title) existing.lastTitle = title
      }
    }
  }
  for (const project of Array.isArray(projects) ? projects : []) {
    const directory = projectDirectory(project)
    if (!directory) continue
    const active = projectActive(project)
    const name = typeof project?.name === "string" ? project.name.trim() : ""
    const existing = folders.get(directory)
    if (!existing) {
      folders.set(directory, {
        directory,
        lastActive: active,
        sessionCount: 0,
        lastTitle: "",
        projectName: name,
        fromProject: true,
      })
    } else {
      existing.lastActive = Math.max(existing.lastActive, active)
      existing.fromProject = true
      if (!existing.projectName) existing.projectName = name
    }
  }
  return [...folders.values()]
}

// ---------------------------------------------------------------------------
// Dates and relative times
// ---------------------------------------------------------------------------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export function formatRelativeTime(now, then) {
  if (typeof then !== "number" || !Number.isFinite(then) || then <= 0) return "unknown"
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 45) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  const date = new Date(then)
  const label = `${MONTHS[date.getMonth()]} ${date.getDate()}`
  return date.getFullYear() === new Date(now).getFullYear() ? label : `${label}, ${date.getFullYear()}`
}

function startOfDay(ms) {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * Section label for a timestamp relative to `now`, by local calendar day:
 * "Today", "Yesterday", then "Wed, Oct 14" (with the year appended when it
 * differs from the current year). Future timestamps bucket as Today.
 *
 * @param {number} now
 * @param {number} then
 * @returns {string}
 */
export function bucketLabel(now, then) {
  if (typeof then !== "number" || !Number.isFinite(then) || then <= 0) return "Older"
  const days = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000)
  if (days <= 0) return "Today"
  if (days === 1) return "Yesterday"
  const date = new Date(then)
  const label = `${WEEKDAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`
  return date.getFullYear() === new Date(now).getFullYear() ? label : `${label}, ${date.getFullYear()}`
}

// ---------------------------------------------------------------------------
// Favorites
// ---------------------------------------------------------------------------

/** Valid, trimmed, de-duplicated directory list; corrupt entries are dropped. */
export function normalizeFavorites(value) {
  const list = Array.isArray(value) ? value : []
  const seen = new Set()
  const folders = []
  for (const entry of list) {
    if (typeof entry !== "string") continue
    const directory = entry.trim()
    if (!directory || seen.has(directory)) continue
    seen.add(directory)
    folders.push(directory)
  }
  return folders
}

export function isFavorite(folders, directory) {
  return normalizeFavorites(folders).includes(directory)
}

/** Adds or removes one directory, returning a new list (never mutates). */
export function toggleFolderFavorite(folders, directory) {
  const current = normalizeFavorites(folders)
  if (typeof directory !== "string" || !directory.trim()) return current
  const clean = directory.trim()
  return current.includes(clean) ? current.filter(entry => entry !== clean) : [...current, clean]
}

// ---------------------------------------------------------------------------
// Rows: a flat list of section headers and selectable folder rows. The view
// renders one element per entry, so highlight-following scroll math and
// navigation can share the same indexing.
// ---------------------------------------------------------------------------

function rowFor(folder, { favorite, now, formatPath, current }) {
  return {
    kind: "row",
    id: folder.directory,
    directory: folder.directory,
    display: formatPath(folder.directory),
    lastActive: folder.lastActive,
    updated: folder.lastActive > 0 ? formatRelativeTime(now, folder.lastActive) : "",
    sessionCount: folder.sessionCount,
    lastTitle: folder.lastTitle,
    projectName: folder.projectName,
    favorite,
    current: typeof current === "string" && current !== "" && current === folder.directory,
  }
}

/**
 * Builds the dialog entries: a "★ Favorites" section first (favorites are
 * pinned there and not repeated below), then date sections from most to least
 * recent, each sorted by last activity. Favorites that no longer appear in
 * the recent index are still listed (they persist in storage).
 *
 * @param {Array<{ directory: string, lastActive: number, sessionCount: number, lastTitle: string, projectName: string }>} index
 * @param {{ favorites?: readonly string[], now?: number, formatPath?: (value: string) => string, current?: string }} [options]
 */
export function buildFolderRows(index, { favorites = [], now = Date.now(), formatPath = value => value, current } = {}) {
  const favoriteSet = new Set(normalizeFavorites(favorites))
  const byDirectory = new Map((Array.isArray(index) ? index : []).map(folder => [folder.directory, folder]))
  const favoriteRows = [...favoriteSet].map(directory => {
    const folder = byDirectory.get(directory) ?? {
      directory,
      lastActive: 0,
      sessionCount: 0,
      lastTitle: "",
      projectName: "",
    }
    return rowFor(folder, { favorite: true, now, formatPath, current })
  })
  favoriteRows.sort((left, right) => right.lastActive - left.lastActive || left.directory.localeCompare(right.directory))
  const rest = (Array.isArray(index) ? index : [])
    .filter(folder => !favoriteSet.has(folder.directory))
    .sort((left, right) => right.lastActive - left.lastActive || left.directory.localeCompare(right.directory))

  const entries = []
  if (favoriteRows.length) {
    entries.push({ kind: "header", id: "section:favorites", label: "★ Favorites", count: favoriteRows.length })
    entries.push(...favoriteRows)
  }
  let label
  let header
  for (const folder of rest) {
    const next = bucketLabel(now, folder.lastActive)
    if (next !== label) {
      label = next
      header = { kind: "header", id: `section:${label}`, label, count: 0 }
      entries.push(header)
    }
    header.count += 1
    entries.push(rowFor(folder, { favorite: false, now, formatPath, current }))
  }
  return entries
}

/**
 * Every whitespace-separated term must match the directory, its display form,
 * the last session title, or the project name (case-insensitive). Section
 * headers survive only while they still have matching rows, with recounted
 * totals.
 *
 * @param {unknown} query
 * @param {readonly Record<string, unknown>[]} entries
 */
export function filterFolderEntries(query, entries) {
  const terms = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean)
  const list = Array.isArray(entries) ? entries : []
  if (!terms.length) return list
  const kept = []
  let pending
  for (const entry of list) {
    if (entry.kind === "header") {
      pending = { ...entry, count: 0 }
      continue
    }
    const haystack = `${entry.directory ?? ""}\n${entry.display ?? ""}\n${entry.lastTitle ?? ""}\n${entry.projectName ?? ""}`.toLowerCase()
    if (!terms.every(term => haystack.includes(term))) continue
    if (pending) {
      kept.push(pending)
      pending = undefined
    }
    kept.push(entry)
  }
  for (let position = 0; position < kept.length; position++) {
    if (kept[position].kind !== "header") continue
    let count = 0
    for (let next = position + 1; next < kept.length && kept[next].kind !== "header"; next++) count += 1
    kept[position] = { ...kept[position], count }
  }
  return kept
}

export function singleLine(text, limit) {
  const collapsed = String(text ?? "").replace(/\s+/g, " ").trim()
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1).trimEnd()}…` : collapsed
}

// ---------------------------------------------------------------------------
// Session discovery. The TUI's data.session.list() cache only holds sessions
// this particular UI has already loaded, so folder discovery asks the server
// directly through client.session.list. Scope is deliberately global: passing
// no directory/project/subpath filter returns every session the connected
// server manages, across all locations. Pages follow the documented cursor
// contract ({ data, cursor: { next } }) and are capped so a server that keeps
// returning cursors cannot loop forever; entries are deduplicated by ID so a
// repeating page also stays bounded. Unlike the session picker, child
// (subagent) sessions are kept: they share their parent's directory, and
// their timestamps still mark activity in that folder.
// ---------------------------------------------------------------------------

const DISCOVER_PAGE_SIZE = 100
const DISCOVER_MAX_PAGES = 10

/**
 * Discovers sessions globally through cursor-paginated `client.session.list`
 * calls, newest-first, up to `pageSize` * `maxPages` sessions (1000 by
 * default); `truncated` reports that the cap cut the list short.
 *
 * @param {{
 *   list: (input: { limit?: number, order?: "asc" | "desc", cursor?: string }, requestOptions?: { signal?: AbortSignal }) => Promise<{ data?: Array<Record<string, unknown> & { id: string }>, cursor?: { next?: string | null } }>,
 *   pageSize?: number,
 *   maxPages?: number,
 *   signal?: AbortSignal,
 * }} [options]
 * @returns {Promise<{ sessions: Array<Record<string, unknown> & { id: string }>, pages: number, truncated: boolean }>}
 */
export async function discoverSessions({ list, pageSize = DISCOVER_PAGE_SIZE, maxPages = DISCOVER_MAX_PAGES, signal } = {}) {
  if (typeof list !== "function") throw new Error("A client session list function is required for discovery.")
  if (!Number.isInteger(pageSize) || pageSize < 1 || !Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error("Discovery pageSize and maxPages must be positive integers.")
  }
  const sessions = []
  const seen = new Set()
  let cursor
  let more = false
  let pages = 0
  while (pages < maxPages) {
    const input = { limit: pageSize, order: "desc" }
    if (cursor !== undefined) input.cursor = cursor
    // Page failures reject: callers must report them instead of silently
    // showing a partial list as if it were complete.
    const page = await list(input, { signal })
    pages += 1
    const data = Array.isArray(page?.data) ? page.data : []
    for (const session of data) {
      if (!session || typeof session.id !== "string" || seen.has(session.id)) continue
      seen.add(session.id)
      sessions.push(session)
    }
    const next = typeof page?.cursor?.next === "string" && page.cursor.next ? page.cursor.next : undefined
    if (next === undefined || data.length === 0) {
      more = false
      break
    }
    cursor = next
    more = true
  }
  return { sessions, pages, truncated: more }
}
