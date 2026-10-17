// Pure-logic regression tests: run with `bun test` (or `node --test`).
import test from "node:test"
import assert from "node:assert/strict"
import {
  FolderLocation,
  bucketLabel,
  buildFolderIndex,
  buildFolderRows,
  discoverSessions,
  errorMessage,
  filterFolderEntries,
  formatRelativeTime,
  isFavorite,
  lastActiveOf,
  normalizeFavorites,
  projectActive,
  projectDirectory,
  sessionDirectory,
  singleLine,
  toggleFolderFavorite,
} from "./core.js"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
// Friday, Oct 16 2026, 14:30 local time.
const NOW = new Date(2026, 9, 16, 14, 30).getTime()

const session = (id, directory, time, title = "") => ({ id, title, location: { directory }, time })

// ---------------------------------------------------------------------------
// FolderLocation: the router-switch contract
// ---------------------------------------------------------------------------

test("FolderLocation is a class instance whose only own field is directory", () => {
  const location = new FolderLocation("/code/app")
  assert.equal(location.directory, "/code/app")
  // The class prototype is what makes Solid's reconcile replace the reference
  // on every navigation (a plain object would be mutated in place, leaving
  // the route's location reference stable and the Home effect stale).
  assert.notEqual(Object.getPrototypeOf(location), Object.prototype)
  assert.equal(Object.getPrototypeOf(location), FolderLocation.prototype)
  // Serialization must look exactly like a LocationRef ({ directory }).
  assert.deepEqual(Object.keys(location), ["directory"])
  assert.deepEqual(JSON.parse(JSON.stringify(location)), { directory: "/code/app" })
})

// ---------------------------------------------------------------------------
// errorMessage
// ---------------------------------------------------------------------------

test("errorMessage extracts safe strings from errors and RPC-shaped objects", () => {
  assert.equal(errorMessage("  boom  "), "boom")
  assert.equal(errorMessage(new Error("real failure")), "real failure")
  assert.equal(errorMessage({ _tag: "RpcError", message: "server said no" }), "server said no")
  // No message: fall back to the tag and never serialize the payload.
  const rpc = { _tag: "RpcError", data: { secret: "token" } }
  assert.equal(errorMessage(rpc), "RpcError (no message).")
  assert.ok(!errorMessage(rpc).includes("token"))
  assert.equal(errorMessage(null), "Unknown error.")
  assert.equal(errorMessage(undefined), "Unknown error.")
  assert.equal(errorMessage({}), "Unknown error.")
  assert.equal(errorMessage(7), "7")
})

// ---------------------------------------------------------------------------
// Session / project field extraction
// ---------------------------------------------------------------------------

test("lastActiveOf takes the highest valid timestamp of viewed/updated/created", () => {
  assert.equal(lastActiveOf(session("a", "/x", { viewed: 30, updated: 20, created: 10 })), 30)
  assert.equal(lastActiveOf(session("a", "/x", { updated: 20, created: 10 })), 20)
  assert.equal(lastActiveOf(session("a", "/x", { created: 10 })), 10)
  assert.equal(lastActiveOf(session("a", "/x", { viewed: "soon", updated: NaN })), 0)
  assert.equal(lastActiveOf({}), 0)
  assert.equal(lastActiveOf(undefined), 0)
})

test("sessionDirectory reads location.directory, falls back to directory, and trims", () => {
  assert.equal(sessionDirectory(session("a", "/code/app", {})), "/code/app")
  assert.equal(sessionDirectory({ id: "a", directory: " /code/legacy " }), "/code/legacy")
  assert.equal(sessionDirectory({ id: "a", location: { directory: "  " } }), "")
  assert.equal(sessionDirectory({ id: "a" }), "")
  assert.equal(sessionDirectory(undefined), "")
})

test("projectDirectory excludes the synthetic global project and empty canonicals", () => {
  assert.equal(projectDirectory({ canonical: "/code/app" }), "/code/app")
  assert.equal(projectDirectory({ canonical: " /code/app " }), "/code/app")
  assert.equal(projectDirectory({ canonical: "/" }), "")
  assert.equal(projectDirectory({ canonical: "  " }), "")
  assert.equal(projectDirectory({}), "")
})

test("projectActive takes the highest of active/updated/created", () => {
  assert.equal(projectActive({ time: { active: 30, updated: 20, created: 10 } }), 30)
  assert.equal(projectActive({ time: { updated: 20, created: 10 } }), 20)
  assert.equal(projectActive({ time: { active: NaN } }), 0)
  assert.equal(projectActive({}), 0)
})

// ---------------------------------------------------------------------------
// buildFolderIndex
// ---------------------------------------------------------------------------

test("buildFolderIndex merges sessions and projects per directory", () => {
  const sessions = [
    session("a", "/code/app", { created: NOW - 10 * DAY, updated: NOW - 5 * MINUTE, viewed: NOW - MINUTE }, "Fix login"),
    session("b", "/code/app", { created: NOW - 20 * DAY, updated: NOW - 30 * DAY }, "Old work"),
    session("c", "/code/docs", { updated: NOW - HOUR }),
  ]
  const projects = [
    { canonical: "/code/app", name: "app", time: { active: NOW - 2 * DAY, created: NOW - 90 * DAY } },
    { canonical: "/", name: "global", time: { active: NOW } },
    { canonical: "/code/empty", name: "empty", time: { active: NOW - 3 * DAY } },
    { canonical: "/code/docs", name: "docs", time: { active: NOW - 4 * HOUR } },
  ]
  const index = buildFolderIndex(sessions, projects)
  const byDirectory = new Map(index.map(folder => [folder.directory, folder]))
  assert.deepEqual([...byDirectory.keys()].sort(), ["/code/app", "/code/docs", "/code/empty"])

  assert.deepEqual(byDirectory.get("/code/app"), {
    directory: "/code/app",
    lastActive: NOW - MINUTE, // session viewed beats every other timestamp
    sessionCount: 2,
    lastTitle: "Fix login", // title of the most recently active session
    projectName: "app",
    fromProject: true,
  })
  assert.deepEqual(byDirectory.get("/code/docs"), {
    directory: "/code/docs",
    lastActive: NOW - HOUR, // session activity beats the older project active time
    sessionCount: 1,
    lastTitle: "",
    projectName: "docs",
    fromProject: true,
  })
  assert.deepEqual(byDirectory.get("/code/empty"), {
    directory: "/code/empty",
    lastActive: NOW - 3 * DAY,
    sessionCount: 0,
    lastTitle: "",
    projectName: "empty",
    fromProject: true,
  })
})

test("buildFolderIndex tolerates malformed input", () => {
  assert.deepEqual(buildFolderIndex(undefined, undefined), [])
  assert.deepEqual(buildFolderIndex([null, 7, {}], [{ canonical: "/" }]), [])
  // A session with no directory is skipped, not counted.
  assert.deepEqual(buildFolderIndex([session("a", "", { updated: 1 })], []), [])
})

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

test("formatRelativeTime renders recent times, then calendar dates with a year when needed", () => {
  assert.equal(formatRelativeTime(NOW, NOW - 10_000), "just now")
  assert.equal(formatRelativeTime(NOW, NOW - 5 * MINUTE), "5m ago")
  assert.equal(formatRelativeTime(NOW, NOW - 3 * HOUR), "3h ago")
  assert.equal(formatRelativeTime(NOW, NOW - 2 * DAY), "2d ago")
  assert.equal(formatRelativeTime(NOW, new Date(2026, 9, 1).getTime()), "Oct 1")
  assert.equal(formatRelativeTime(NOW, new Date(2025, 9, 1).getTime()), "Oct 1, 2025")
  assert.equal(formatRelativeTime(NOW, 0), "unknown")
  assert.equal(formatRelativeTime(NOW, NaN), "unknown")
  assert.equal(formatRelativeTime(NOW, undefined), "unknown")
})

test("bucketLabel groups by local calendar day with weekday labels for older days", () => {
  assert.equal(bucketLabel(NOW, NOW), "Today")
  assert.equal(bucketLabel(NOW, NOW - HOUR), "Today")
  assert.equal(bucketLabel(NOW, NOW + HOUR), "Today", "future timestamps bucket as Today")
  assert.equal(bucketLabel(NOW, NOW - DAY), "Yesterday")
  assert.equal(bucketLabel(NOW, NOW - 2 * DAY), "Wed, Oct 14")
  assert.equal(bucketLabel(NOW, new Date(2025, 9, 14).getTime()), "Tue, Oct 14, 2025")
  assert.equal(bucketLabel(NOW, 0), "Older")
  assert.equal(bucketLabel(NOW, NaN), "Older")
})

// ---------------------------------------------------------------------------
// Favorites
// ---------------------------------------------------------------------------

test("normalizeFavorites trims, deduplicates, and drops corrupt entries", () => {
  assert.deepEqual(normalizeFavorites(undefined), [])
  assert.deepEqual(normalizeFavorites("nope"), [])
  assert.deepEqual(normalizeFavorites(["/a", " /a ", "/b", "", "   ", 7, null, { path: "/c" }]), ["/a", "/b"])
})

test("isFavorite and toggleFolderFavorite add and remove without mutating", () => {
  const original = ["/a"]
  assert.equal(isFavorite(original, "/a"), true)
  assert.equal(isFavorite(original, "/b"), false)
  assert.deepEqual(toggleFolderFavorite(original, "/b"), ["/a", "/b"])
  assert.deepEqual(toggleFolderFavorite(["/a", "/b"], "/a"), ["/b"])
  assert.deepEqual(toggleFolderFavorite(original, "  "), ["/a"])
  assert.deepEqual(original, ["/a"], "the input list is never mutated")
})

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const indexFixture = () => [
  { directory: "/code/app", lastActive: NOW - MINUTE, sessionCount: 3, lastTitle: "Fix login bug", projectName: "app" },
  { directory: "/code/docs", lastActive: NOW - DAY, sessionCount: 1, lastTitle: "", projectName: "" },
  { directory: "/code/old", lastActive: NOW - 2 * DAY, sessionCount: 0, lastTitle: "", projectName: "" },
  { directory: "/code/zeta", lastActive: NOW - 2 * DAY - MINUTE, sessionCount: 2, lastTitle: "", projectName: "" },
]

test("buildFolderRows pins favorites first, groups the rest by day, and marks the current folder", () => {
  const entries = buildFolderRows(indexFixture(), {
    favorites: ["/code/old"],
    now: NOW,
    formatPath: value => value.replace("/code/", ""),
    current: "/code/app",
  })
  assert.deepEqual(
    entries.map(entry => (entry.kind === "header" ? `#${entry.label}(${entry.count})` : ` ${entry.id}`)),
    ["#★ Favorites(1)", " /code/old", "#Today(1)", " /code/app", "#Yesterday(1)", " /code/docs", "#Wed, Oct 14(1)", " /code/zeta"],
  )
  const old = entries.find(entry => entry.id === "/code/old")
  assert.equal(old.favorite, true)
  assert.equal(old.updated, "2d ago")
  const app = entries.find(entry => entry.id === "/code/app")
  assert.equal(app.display, "app")
  assert.equal(app.current, true)
  assert.equal(app.favorite, false)
  assert.equal(app.updated, "1m ago")
  assert.equal(entries.find(entry => entry.id === "/code/zeta").current, false)
})

test("buildFolderRows keeps favorites that are missing from the recent index", () => {
  const entries = buildFolderRows(indexFixture(), { favorites: ["/code/gone", "/code/docs"], now: NOW })
  const favorites = entries.findIndex(entry => entry.kind === "header" && entry.label === "★ Favorites")
  assert.equal(entries[favorites].count, 2)
  const gone = entries.find(entry => entry.id === "/code/gone")
  assert.deepEqual(
    { favorite: gone.favorite, updated: gone.updated, sessionCount: gone.sessionCount, display: gone.display },
    { favorite: true, updated: "", sessionCount: 0, display: "/code/gone" },
  )
  // The favorite copy of /code/docs is not repeated in the Yesterday section.
  assert.equal(entries.filter(entry => entry.id === "/code/docs").length, 1)
})

test("buildFolderRows sorts within sections by recency, then path", () => {
  const entries = buildFolderRows(
    [
      { directory: "/b", lastActive: NOW, sessionCount: 0, lastTitle: "", projectName: "" },
      { directory: "/a", lastActive: NOW, sessionCount: 0, lastTitle: "", projectName: "" },
      { directory: "/c", lastActive: NOW - MINUTE, sessionCount: 0, lastTitle: "", projectName: "" },
    ],
    { now: NOW },
  )
  assert.deepEqual(entries.filter(entry => entry.kind === "row").map(entry => entry.id), ["/a", "/b", "/c"])
})

test("buildFolderRows with nothing to show returns an empty list", () => {
  assert.deepEqual(buildFolderRows([], { now: NOW }), [])
  assert.deepEqual(buildFolderRows(undefined, {}), [])
})

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

test("filterFolderEntries matches on path, display, title, and project name with AND semantics", () => {
  const entries = buildFolderRows(indexFixture(), {
    favorites: ["/code/old"],
    now: NOW,
    formatPath: value => value.replace("/code/", ""),
  })
  const ids = list => list.map(entry => (entry.kind === "header" ? `#${entry.label}` : entry.id))

  assert.deepEqual(ids(filterFolderEntries("app", entries)), ["#Today", "/code/app"])
  assert.deepEqual(ids(filterFolderEntries("code app", entries)), ["#Today", "/code/app"], "all terms must match")
  assert.deepEqual(ids(filterFolderEntries("fix login", entries)), ["#Today", "/code/app"], "matches the last session title")
  assert.deepEqual(ids(filterFolderEntries("old", entries)), ["#★ Favorites", "/code/old"], "favorites section survives with its row")
  assert.deepEqual(ids(filterFolderEntries("nothing-here", entries)), [])
  assert.deepEqual(ids(filterFolderEntries("", entries)), ids(entries), "an empty query keeps every section")
  assert.deepEqual(ids(filterFolderEntries("  ", entries)), ids(entries))
})

test("filterFolderEntries recounts section headers after pruning", () => {
  const entries = buildFolderRows(indexFixture(), { now: NOW })
  const filtered = filterFolderEntries("zeta", entries)
  const header = filtered.find(entry => entry.kind === "header")
  assert.equal(header.label, "Wed, Oct 14")
  assert.equal(header.count, 1)
})

// ---------------------------------------------------------------------------
// singleLine
// ---------------------------------------------------------------------------

test("singleLine collapses whitespace and truncates with an ellipsis", () => {
  assert.equal(singleLine("  hello   world \n", 40), "hello world")
  assert.equal(singleLine("abcdef", 6), "abcdef")
  assert.equal(singleLine("abcdefg", 6), "abcde…")
  assert.equal(singleLine(undefined, 5), "")
})

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const discovered = (id, directory = "/code/app") => session(id, directory, { updated: 1 })

test("discovery follows cursors until the server stops offering pages", async () => {
  const calls = []
  const list = async (input, options) => {
    calls.push({ input, options })
    if (input.cursor === undefined) return { data: [discovered("ses_a"), discovered("ses_b")], cursor: { next: "c2" } }
    if (input.cursor === "c2") return { data: [discovered("ses_c")], cursor: { next: null } }
    throw new Error("unexpected cursor")
  }
  const result = await discoverSessions({ list })
  assert.deepEqual(result.sessions.map(entry => entry.id), ["ses_a", "ses_b", "ses_c"])
  assert.equal(result.pages, 2)
  assert.equal(result.truncated, false)
  assert.deepEqual(calls.map(call => call.input), [
    { limit: 100, order: "desc" },
    { limit: 100, order: "desc", cursor: "c2" },
  ])
})

test("discovery deduplicates ids, skips malformed entries, and stops on empty pages", async () => {
  const list = async input => {
    if (input.cursor === undefined) {
      return { data: [discovered("ses_a"), discovered("ses_a"), null, { title: "no id" }, 7], cursor: { next: "c2" } }
    }
    return { data: [], cursor: { next: "c3" } }
  }
  const result = await discoverSessions({ list })
  assert.deepEqual(result.sessions.map(entry => entry.id), ["ses_a"])
  assert.equal(result.pages, 2)
  assert.equal(result.truncated, false)
})

test("discovery reports truncation when the page cap cuts the list short", async () => {
  let n = 0
  const list = async () => {
    n += 1
    return { data: [discovered(`ses_${n}`)], cursor: { next: "more" } }
  }
  const capped = await discoverSessions({ list, maxPages: 3, pageSize: 5 })
  assert.equal(capped.pages, 3)
  assert.equal(capped.truncated, true)
  assert.deepEqual(capped.sessions.map(entry => entry.id), ["ses_1", "ses_2", "ses_3"])
})

test("discovery stays bounded when a broken server repeats one page", async () => {
  const list = async () => ({ data: [discovered("ses_a")], cursor: { next: "same" } })
  const result = await discoverSessions({ list })
  assert.equal(result.pages, 10)
  assert.equal(result.truncated, true)
  assert.deepEqual(result.sessions.map(entry => entry.id), ["ses_a"], "repeated ids are deduplicated")
})

test("discovery rejects page failures instead of returning a partial list", async () => {
  await assert.rejects(
    () => discoverSessions({ list: async () => { throw new Error("server down") } }),
    /server down/,
  )
  await assert.rejects(() => discoverSessions({}), /required/)
  await assert.rejects(() => discoverSessions({ list: async () => ({ data: [] }), maxPages: 0 }), /positive integers/)
  await assert.rejects(() => discoverSessions({ list: async () => ({ data: [] }), pageSize: 1.5 }), /positive integers/)
})
