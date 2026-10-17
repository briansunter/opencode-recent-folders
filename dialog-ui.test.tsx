// Real-UI regression tests for the folder picker: they mount the actual
// dialog JSX through @opentui/solid's test renderer, type into the real
// search input, run the same keymap commands the host keymap would, and
// assert on rendered frames and flow outcomes.
import test from "node:test"
import assert from "node:assert/strict"
import { testRender } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import type { JSX } from "@opentui/solid"
import { runFolderPicker } from "./dialog.tsx"
import { toggleFolderFavorite } from "./core.js"
import { fakeDialog } from "./dialog-driver.js"

type TestRendererSetup = Awaited<ReturnType<typeof testRender>>

// Friday, Oct 16 2026, 14:30 local time.
const NOW = new Date(2026, 9, 16, 14, 30).getTime()
const HOUR = 3_600_000
const DAY = 24 * HOUR

const sessions = [
  { id: "ses_a", title: "Fix login bug", location: { directory: "/code/app" }, time: { updated: NOW - 60_000 } },
  { id: "ses_b", title: "Write docs", location: { directory: "/code/docs" }, time: { updated: NOW - 26 * HOUR } },
  { id: "ses_c", title: "Old refactor", location: { directory: "/code/old" }, time: { updated: NOW - 3 * DAY } },
]

const projects = [{ canonical: "/code/empty", name: "empty project", time: { active: NOW - 5 * DAY } }]

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

type Harness = {
  driver: ReturnType<typeof fakeDialog>
  first: { kind: string }
  layers: Array<{ mode?: string; commands: Array<{ id: string; bind: string; run: () => unknown }> }>
  switched: string[]
  toggled: string[]
  toasts: Array<{ message: string; variant?: string }>
  done: Promise<{ status: string; directory?: string; message?: string }>
  setup: TestRendererSetup
  runBind: (bind: string) => unknown
  syncRender: () => void
  frame: () => string
}

async function startPicker(overrides: Record<string, unknown> = {}, size = { width: 100, height: 44 }): Promise<Harness> {
  const driver = fakeDialog()
  const layers: Harness["layers"] = []
  const switched: string[] = []
  const toggled: string[] = []
  const toasts: Harness["toasts"] = []
  // A signal, like the real storage store: the controller's memo must re-run
  // when a toggle changes the favorites.
  const [favoriteFolders, setFavoriteFolders] = createSignal<string[]>([])
  const deps = {
    dialog: driver.dialog,
    layer: (factory: () => { mode?: string; commands: unknown[] }) => {
      layers.push(factory() as never)
    },
    shortcut: () => undefined,
    loadFolders: async () => ({ sessions: sessions.slice(), projects: projects.slice() }),
    favorites: () => favoriteFolders(),
    toggleFavorite: async (directory: string) => {
      toggled.push(directory)
      setFavoriteFolders(current => toggleFolderFavorite(current, directory))
    },
    switchFolder: async (directory: string) => {
      switched.push(directory)
    },
    current: () => "/code/app",
    formatPath: (value: string) => value,
    now: () => NOW,
    toast: (options: { message: string; variant?: string }) => toasts.push(options),
    ...overrides,
  }
  const done = runFolderPicker(deps as never)

  // Remount bridge: the flow hands its render function to dialog.show; the
  // test renderer displays whatever the latest show carries. A keyed Show
  // re-runs (and disposes the previous child) whenever the version changes —
  // the same replace-and-remount the host DialogProvider performs.
  let currentRender: (() => JSX.Element) | undefined
  const [version, bumpVersion] = createSignal(0)
  const syncRender = () => {
    currentRender = driver.currentShow()?.render as (() => JSX.Element) | undefined
    bumpVersion(value => value + 1)
  }
  const setup = await testRender(
    () => (
      <Show when={version()} keyed fallback={<box />}>
        {/* The parameter matters: Solid only re-invokes children callbacks
            that accept the keyed value, so only these remount on every
            truthy->truthy change (a zero-arg closure would run once). */}
        {(_version: number) => currentRender?.() ?? <box />}
      </Show>
    ),
    size,
  )
  // Some flows never push a dialog (load failure); don't wait forever on those.
  const first = (await Promise.race([driver.next(), settle(25).then(() => ({ kind: "none" }))])) as { kind: string }
  if (first.kind === "show") {
    syncRender()
    await settle(5) // the input focuses on a timeout, like the host dialogs
    await setup.flush()
  }

  const runBind = (bind: string) => {
    for (let index = layers.length - 1; index >= 0; index--) {
      const command = layers[index].commands.find(entry => entry.bind === bind)
      if (command) return command.run()
    }
    throw new Error(`no command bound to ${bind}`)
  }
  return { driver, first, layers, switched, toggled, toasts, done, setup, runBind, syncRender, frame: () => setup.captureCharFrame() }
}

test("the dialog renders day sections in recency order and marks the current folder", async () => {
  const picker = await startPicker()
  try {
    const frame = picker.frame()
    assert.match(frame, /Recent folders — 4 folders/)
    assert.ok(!frame.includes("★ Favorites"), "no favorites section while the list is empty")
    assert.match(frame, /Today \(1\)/)
    assert.match(frame, /Yesterday \(1\)/)
    assert.match(frame, /Tue, Oct 13 \(1\)/)
    assert.match(frame, /Sun, Oct 11 \(1\)/)
    assert.match(frame, /\/code\/app/)
    assert.match(frame, /\/code\/docs/)
    assert.match(frame, /\/code\/old/)
    assert.match(frame, /\/code\/empty/)
    assert.match(frame, /Fix login bug/, "the last session title is shown")
    assert.match(frame, /empty project/, "project-only folders show their project name")
    assert.match(frame, /●/, "the current folder is marked")
    assert.ok(frame.indexOf("Today") < frame.indexOf("Yesterday"), "newer sections come first")
    assert.ok(frame.indexOf("Yesterday") < frame.indexOf("Tue, Oct 13"))
  } finally {
    picker.driver.closeShow()
    await picker.done
    await picker.setup.dispose()
  }
})

test("shortcut footer fits at normal dialog widths", async () => {
  const picker = await startPicker({}, { width: 80, height: 34 })
  try {
    const frame = picker.frame()
    assert.match(frame, /switch\s+enter/)
    assert.match(frame, /favorite\s+ctrl\+f/)
    assert.match(frame, /close\s+escape/)
  } finally {
    picker.driver.closeShow()
    await picker.done
    await picker.setup.dispose()
  }
})

test("ctrl+f pins the highlighted folder on top and ctrl+f again unpins it", async () => {
  const picker = await startPicker()
  try {
    picker.runBind("ctrl+f") // initial highlight is /code/app
    await settle(5)
    await picker.setup.flush()
    assert.deepEqual(picker.toggled, ["/code/app"])
    const pinned = picker.frame()
    assert.match(pinned, /★ Favorites \(1\)/)
    assert.ok(pinned.indexOf("★ Favorites") < pinned.indexOf("/code/app"), "the favorite sits in the top section")
    assert.ok(!pinned.includes("Today"), "the folder left its date section")
    assert.match(pinned, /Recent folders — 4 folders · 1 favorite/)

    picker.runBind("ctrl+f")
    await settle(5)
    await picker.setup.flush()
    assert.deepEqual(picker.toggled, ["/code/app", "/code/app"])
    const unpinned = picker.frame()
    assert.ok(!unpinned.includes("★ Favorites"), "unpinning removes the section")
    assert.match(unpinned, /Today \(1\)/, "the folder is back in its date section")
    assert.ok(!unpinned.includes("1 favorite"), "the title drops the favorite count")
  } finally {
    picker.driver.closeShow()
    assert.deepEqual(await picker.done, { status: "cancelled" })
    await picker.setup.dispose()
  }
})

test("typing filters the live list by path and by project name", async () => {
  const picker = await startPicker()
  try {
    await picker.setup.mockInput.typeText("docs", 0)
    await picker.setup.flush()
    const filtered = picker.frame()
    assert.match(filtered, /\/code\/docs/)
    assert.ok(!filtered.includes("/code/app"), "non-matching rows are hidden")
    assert.match(filtered, /docs/, "the typed query is visible in the search field")

    for (let index = 0; index < 4; index++) await picker.setup.mockInput.pressKey("\b")
    await picker.setup.mockInput.typeText("project", 0)
    await picker.setup.flush()
    const byProject = picker.frame()
    assert.match(byProject, /\/code\/empty/, "a project-only folder matches by project name")
    assert.ok(!byProject.includes("/code/docs"))

    // The filtered selection stays actionable.
    picker.runBind("enter")
    const outcome = await picker.done
    assert.equal(outcome.status, "switched")
    assert.deepEqual(picker.switched, ["/code/empty"])
  } finally {
    await picker.setup.dispose()
  }
})

test("navigation skips headers, wraps, and enter switches the highlighted folder", async () => {
  const picker = await startPicker()
  try {
    // Initial highlight is the first row (/code/app, Today); "up" wraps to the
    // last row, skipping the intervening section headers.
    picker.runBind("up")
    picker.runBind("enter")
    const outcome = await picker.done
    assert.equal(outcome.status, "switched")
    assert.deepEqual(picker.switched, ["/code/empty"])
    assert.equal(picker.driver.clearCount(), 1, "the dialog is cleared before switching")
    assert.deepEqual(picker.driver.setCalls, [{ size: "large" }])
    assert.deepEqual(picker.toasts, [{ message: "Switched to /code/empty.", variant: "success" }])
  } finally {
    await picker.setup.dispose()
  }
})

test("down moves between rows rather than entries", async () => {
  const picker = await startPicker()
  try {
    picker.runBind("down")
    picker.runBind("enter")
    const outcome = await picker.done
    assert.equal(outcome.status, "switched")
    assert.deepEqual(picker.switched, ["/code/docs"], "one down press lands on the next row, not the Yesterday header")
  } finally {
    await picker.setup.dispose()
  }
})

test("home, end, and pagedown move through the rows only", async () => {
  const picker = await startPicker()
  try {
    picker.runBind("end")
    picker.runBind("home")
    picker.runBind("pagedown") // 10 steps over 4 rows wraps to index 2 (/code/old)
    picker.runBind("enter")
    const outcome = await picker.done
    assert.equal(outcome.status, "switched")
    assert.deepEqual(picker.switched, ["/code/old"])
  } finally {
    await picker.setup.dispose()
  }
})

test("escape returns false so the host closes the picker", async () => {
  const picker = await startPicker()
  try {
    assert.equal(picker.runBind("escape"), false)
    picker.driver.closeShow()
    assert.deepEqual(await picker.done, { status: "cancelled" })
  } finally {
    await picker.setup.dispose()
  }
})

test("the dialog registers its bindings in the host modal mode and never in the palette", async () => {
  const picker = await startPicker()
  try {
    const layer = picker.layers.at(-1)!
    assert.equal(layer.mode, "modal", "dialog keys live in the host's modal scope only")
    const binds = layer.commands.map(command => command.bind)
    for (const bind of ["up", "down", "pageup", "pagedown", "home", "end", "enter", "ctrl+f", "escape"]) {
      assert.ok(binds.includes(bind), `${bind} is bound`)
    }
    assert.ok(layer.commands.every(command => !("palette" in command) || (command as { palette?: boolean }).palette !== true))
    picker.driver.closeShow()
    await picker.done
  } finally {
    await picker.setup.dispose()
  }
})

test("an empty server list shows an alert instead of the picker", async () => {
  const picker = await startPicker({ loadFolders: async () => ({ sessions: [], projects: [] }) })
  try {
    assert.equal(picker.first.kind, "alert")
    assert.equal(picker.driver.shows.length, 0, "no picker dialog was pushed")
    picker.driver.closeAlert()
    assert.deepEqual(await picker.done, { status: "cancelled" })
  } finally {
    await picker.setup.dispose()
  }
})

test("favorites alone keep the picker usable with no recent activity", async () => {
  const picker = await startPicker({
    loadFolders: async () => ({ sessions: [], projects: [] }),
    favorites: () => ["/code/solo"],
  })
  try {
    const frame = picker.frame()
    assert.match(frame, /★ Favorites \(1\)/)
    assert.match(frame, /\/code\/solo/)
    picker.runBind("enter")
    const outcome = await picker.done
    assert.equal(outcome.status, "switched")
    assert.deepEqual(picker.switched, ["/code/solo"])
  } finally {
    await picker.setup.dispose()
  }
})

test("a discovery failure surfaces as an error toast, not an empty picker", async () => {
  const picker = await startPicker({
    loadFolders: async () => {
      throw new Error("server down")
    },
  })
  try {
    const outcome = await picker.done
    assert.equal(outcome.status, "error")
    assert.deepEqual(picker.toasts, [
      { message: "Could not load recent folders from the server: server down", variant: "error" },
    ])
    assert.equal(picker.driver.shows.length, 0, "no picker dialog was pushed")
  } finally {
    await picker.setup.dispose()
  }
})
