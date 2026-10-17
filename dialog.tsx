// Folder picker built on the documented custom-JSX dialog API
// (`context.ui.dialog.show`, OpenCode 2.0 docs → Build plugins → CLI).
// Like the session picker in opencode-session-tabs, the controller's Solid
// state lives outside the dialog component, so the search query, the
// highlight, and the live favorites list survive dialog re-shows and host
// dialog replacements.
//
// Keyboard scope: the host pushes its exclusive "modal" keymap mode while any
// dialog is shown, and the view registers its bindings in a `mode: "modal"`
// layer created inside the dialog component. The layer is disposed when the
// dialog JSX unmounts, so bindings never leak to the background. Escape
// returns false ("not handled"), letting the host's own dialog layer close
// the picker.
import { CliRenderEvents, TextAttributes, type InputRenderable, type ScrollBoxRenderable } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import type { KeymapLayer } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createRoot, createSignal, For, Show, untrack } from "solid-js"
import {
  buildFolderIndex,
  buildFolderRows,
  errorMessage,
  filterFolderEntries,
  normalizeFavorites,
  singleLine,
} from "./core.js"

// ---------------------------------------------------------------------------
// Controller: reactive picker state without any rendering. Created once per
// picker invocation, outside the dialog component.
// ---------------------------------------------------------------------------

export type FolderPickerRequest = { readonly type: "switch"; readonly directory: string }

export type FolderRow = {
  readonly kind: "row"
  readonly id: string
  readonly directory: string
  readonly display: string
  readonly lastActive: number
  readonly updated: string
  readonly sessionCount: number
  readonly lastTitle: string
  readonly projectName: string
  readonly favorite: boolean
  readonly current: boolean
}

export type FolderHeader = {
  readonly kind: "header"
  readonly id: string
  readonly label: string
  readonly count: number
}

export type FolderEntry = FolderHeader | FolderRow

export type FolderPickerControllerOptions = {
  readonly sessions: readonly Record<string, unknown>[]
  readonly projects: readonly Record<string, unknown>[]
  /** Reactive read of the durable favorites list (live-synced across TUIs). */
  readonly favorites: () => readonly string[]
  readonly toggleFavorite?: (directory: string) => void | Promise<void>
  readonly formatPath?: (value: string) => string
  readonly current?: () => string | undefined
  readonly now?: () => number
  readonly toast?: (options: { message: string; variant?: "info" | "success" | "warning" | "error" }) => void
}

export type FolderPickerController = {
  // Reactive state read by the view (and tests).
  query(): string
  setQuery(value: string): void
  titleLine(): string
  entries(): readonly FolderEntry[]
  rows(): readonly FolderRow[]
  highlightedId(): string | undefined
  highlightedRow(): FolderRow | undefined
  // Commands bound to keys (and mouse) by the view.
  move(delta: number): void
  moveFirst(): void
  moveLast(): void
  activate(): void
  activateAt(directory: string): void
  toggleFavorite(): void
  // Flow plumbing: Enter resolves the flow's pending request.
  takeRequest(): Promise<FolderPickerRequest>
  resetRequests(): void
  dispose(): void
}

export function createFolderPickerController(options: FolderPickerControllerOptions): FolderPickerController {
  let disposeRoot: (() => void) | undefined
  const controller = createRoot(dispose => {
    disposeRoot = dispose
    const favorites = options.favorites ?? (() => [])
    const onToggleFavorite = options.toggleFavorite
    const formatPath = options.formatPath ?? ((value: string) => value)
    const current = options.current ?? (() => undefined)
    const now = options.now ?? (() => Date.now())
    const toast = options.toast ?? (() => {})
    const index = buildFolderIndex(options.sessions, options.projects)

    const [query, setQuerySignal] = createSignal("")
    const [highlight, setHighlight] = createSignal<string | undefined>(undefined)
    const lastHighlightIndex = { value: 0 }

    // Favorites and the current location are read reactively: a ctrl+f toggle
    // (or another TUI's change, live-synced through storage) re-sorts the
    // sections immediately.
    const entries = createMemo<readonly FolderEntry[]>(() => {
      const all = buildFolderRows(index, {
        favorites: favorites(),
        now: now(),
        formatPath,
        current: current(),
      })
      return filterFolderEntries(query(), all)
    })

    const rows = createMemo<readonly FolderRow[]>(() => entries().filter((entry): entry is FolderRow => entry.kind === "row"))

    // Stable highlight fallback: when the filtered rows change and the
    // highlighted row disappears, keep the nearest position instead of
    // jumping unpredictably.
    createEffect(() => {
      const list = rows()
      untrack(() => {
        const wanted = highlight()
        if (list.length === 0) return
        if (wanted !== undefined && list.some(row => row.id === wanted)) return
        setHighlight(list[Math.min(lastHighlightIndex.value, list.length - 1)].id)
      })
    })
    createEffect(() => {
      const position = rows().findIndex(row => row.id === highlight())
      if (position >= 0) lastHighlightIndex.value = position
    })

    const highlightedRow = () => rows().find(row => row.id === highlight())

    function moveToIndex(position: number) {
      const list = rows()
      if (!list.length) return
      const clamped = Math.max(0, Math.min(position, list.length - 1))
      lastHighlightIndex.value = clamped
      setHighlight(list[clamped].id)
    }

    function move(delta: number) {
      const list = rows()
      if (!list.length) return
      const position = list.findIndex(row => row.id === highlight())
      const base = position < 0 ? 0 : position + delta
      const next = ((base % list.length) + list.length) % list.length
      lastHighlightIndex.value = next
      setHighlight(list[next].id)
    }

    let queued: FolderPickerRequest | undefined
    let waiter: ((request: FolderPickerRequest) => void) | undefined

    function request(value: FolderPickerRequest) {
      if (waiter) {
        const resolve = waiter
        waiter = undefined
        resolve(value)
      } else {
        queued = value
      }
    }

    function activate() {
      const row = highlightedRow()
      if (row) request({ type: "switch", directory: row.directory })
    }

    function activateAt(directory: string) {
      const row = rows().find(entry => entry.id === directory)
      if (!row) return
      setHighlight(row.id)
      request({ type: "switch", directory: row.directory })
    }

    function toggleFavorite() {
      const row = highlightedRow()
      if (!row || typeof onToggleFavorite !== "function") return
      void Promise.resolve()
        .then(() => onToggleFavorite(row.directory))
        .catch(error => {
          toast({ message: `Could not update favorites: ${errorMessage(error)}`, variant: "error" })
        })
    }

    function titleLine() {
      const count = rows().length
      const favoritesCount = normalizeFavorites(favorites()).length
      return `Recent folders — ${count} folder${count === 1 ? "" : "s"}${
        favoritesCount ? ` · ${favoritesCount} favorite${favoritesCount === 1 ? "" : "s"}` : ""
      }`
    }

    return {
      query: () => query(),
      setQuery: (value: string) => setQuerySignal(String(value ?? "")),
      titleLine,
      entries,
      rows,
      highlightedId: () => highlight(),
      highlightedRow,
      move,
      moveFirst: () => moveToIndex(0),
      moveLast: () => moveToIndex(rows().length - 1),
      activate,
      activateAt,
      toggleFavorite,
      takeRequest() {
        if (queued !== undefined) {
          const value = queued
          queued = undefined
          return Promise.resolve(value)
        }
        return new Promise<FolderPickerRequest>(resolve => {
          waiter = resolve
        })
      },
      resetRequests() {
        queued = undefined
        waiter = undefined
      },
    }
  })
  return { ...controller, dispose: () => disposeRoot?.() }
}

// ---------------------------------------------------------------------------
// View: a thin Solid component that reads the controller reactively. All
// state lives in the controller, so re-showing the dialog (which remounts
// this component) loses nothing.
// ---------------------------------------------------------------------------

const COMMAND = {
  prev: "local.recent-folders.picker.prev",
  next: "local.recent-folders.picker.next",
  pageUp: "local.recent-folders.picker.page_up",
  pageDown: "local.recent-folders.picker.page_down",
  first: "local.recent-folders.picker.first",
  last: "local.recent-folders.picker.last",
  switch: "local.recent-folders.picker.switch",
  favorite: "local.recent-folders.picker.favorite",
  back: "local.recent-folders.picker.back",
} as const

export type FolderPickerCommand = {
  readonly id: string
  readonly title: string
  readonly group: string
  readonly bind: string
  readonly run: () => boolean | undefined | void
}

// The dialog's keymap commands, separated from the view so tests can drive
// the exact same functions the keymap binds. Escape returns false ("not
// handled") so the host's dialog layer closes the picker.
export function folderPickerCommands(c: FolderPickerController): readonly FolderPickerCommand[] {
  return [
    { id: COMMAND.prev, title: "Previous folder", group: "Recent Folders", bind: "up", run: () => c.move(-1) },
    { id: COMMAND.next, title: "Next folder", group: "Recent Folders", bind: "down", run: () => c.move(1) },
    { id: COMMAND.pageUp, title: "Page up", group: "Recent Folders", bind: "pageup", run: () => c.move(-10) },
    { id: COMMAND.pageDown, title: "Page down", group: "Recent Folders", bind: "pagedown", run: () => c.move(10) },
    { id: COMMAND.first, title: "First folder", group: "Recent Folders", bind: "home", run: () => c.moveFirst() },
    { id: COMMAND.last, title: "Last folder", group: "Recent Folders", bind: "end", run: () => c.moveLast() },
    { id: COMMAND.switch, title: "Switch folder", group: "Recent Folders", bind: "enter", run: () => c.activate() },
    { id: COMMAND.favorite, title: "Toggle favorite", group: "Recent Folders", bind: "ctrl+f", run: () => c.toggleFavorite() },
    { id: COMMAND.back, title: "Close", group: "Recent Folders", bind: "escape", run: () => false },
  ]
}

const FOOTER_ACTIONS: readonly { readonly id: string; readonly bind: string; readonly title: string }[] = [
  { id: COMMAND.switch, bind: "enter", title: "switch" },
  { id: COMMAND.favorite, bind: "ctrl+f", title: "favorite" },
  { id: COMMAND.back, bind: "escape", title: "close" },
]

function folderPalette(themeMode: string | undefined) {
  const light = themeMode === "light"
  return {
    base: light ? "#1f2328" : "#e6edf3",
    muted: light ? "#59636e" : "#8b949e",
    accent: light ? "#0969da" : "#58a6ff",
    check: light ? "#1a7f37" : "#3fb950",
  }
}

export function FolderPickerDialog(props: {
  readonly controller: FolderPickerController
  /** Scoped keymap registration: the plugin's context.keymap.layer. */
  readonly layer: (factory: () => KeymapLayer) => void
  readonly shortcut?: (id: string) => readonly string[] | undefined
  readonly themeMode?: string
}): JSX.Element {
  const c = props.controller
  const colors = folderPalette(props.themeMode)
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()

  // Bindings live only while this dialog component is mounted: the plugin
  // keymap layer API disposes the layer with the owning reactive scope.
  props.layer(() => ({
    mode: "modal",
    commands: folderPickerCommands(c) as KeymapLayer["commands"],
  }))

  // Focus the search input after mount, once layout settles — the same
  // pattern the host's own dialogs use. The value restores the persisted
  // query when the dialog is re-shown (read untracked so typing never
  // rewrites the buffer or moves the cursor).
  let inputRef: InputRenderable | undefined
  const attachInput = (node: InputRenderable) => {
    inputRef = node
    setTimeout(() => {
      if (inputRef === node && !node.isDestroyed) node.focus()
    }, 1)
  }

  let scroll: ScrollBoxRenderable | undefined
  let scrollScheduled = false
  function followHighlight() {
    if (!scroll || scroll.isDestroyed) return
    const position = c.entries().findIndex(entry => entry.kind === "row" && entry.id === c.highlightedId())
    if (position < 0) return
    const target = scroll.getChildren()[position]
    if (!target) return
    const y = target.y - scroll.y
    if (y >= scroll.height) scroll.scrollBy(y - scroll.height + 1)
    else if (y < 0) scroll.scrollBy(y)
  }
  function scheduleScroll() {
    if (scrollScheduled) return
    scrollScheduled = true
    renderer.once(CliRenderEvents.FRAME, () => {
      scrollScheduled = false
      followHighlight()
    })
    renderer.requestRender()
  }
  createEffect(() => {
    c.highlightedId()
    c.entries()
    scheduleScroll()
  })

  const listHeight = createMemo(() => {
    const lines = c.entries().length * 2 + 1
    return Math.max(3, Math.min(lines, Math.floor(dimensions().height / 2) - 4))
  })

  const keyFor = (action: { readonly id: string; readonly bind: string }) =>
    props.shortcut?.(action.id)?.[0] ?? action.bind

  const metaFor = (row: FolderRow) => {
    const parts = []
    if (row.sessionCount > 0) parts.push(`${row.sessionCount} session${row.sessionCount === 1 ? "" : "s"}`)
    if (row.lastTitle) parts.push(`last: ${singleLine(row.lastTitle, 56)}`)
    if (!parts.length) parts.push("no sessions yet")
    if (row.projectName) parts.push(row.projectName)
    return parts.join(" · ")
  }

  return (
    <box flexDirection="column" gap={1} paddingBottom={1} paddingLeft={3} paddingRight={3}>
      <text attributes={TextAttributes.BOLD} fg={colors.base}>
        {c.titleLine()}
      </text>
      <input
        ref={attachInput}
        value={untrack(c.query)}
        onInput={value => c.setQuery(value)}
        placeholder="Search folders by path, title, or project…"
        placeholderColor={colors.muted}
      />
      <box flexGrow={1} flexShrink={1} paddingLeft={1} paddingRight={1}>
        <Show
          when={c.rows().length > 0}
          fallback={
            <text fg={colors.muted}>
              {c.query() ? `No folders match "${c.query()}".` : "No folders available."}
            </text>
          }
        >
          <scrollbox
            ref={(node: ScrollBoxRenderable) => {
              scroll = node
            }}
            maxHeight={listHeight()}
            paddingLeft={1}
            paddingRight={1}
          >
            <For each={c.entries()}>
              {entry =>
                entry.kind === "header" ? (
                  <box paddingTop={1}>
                    <text attributes={TextAttributes.BOLD} fg={colors.accent} wrapMode="none">
                      {`${entry.label} (${entry.count})`}
                    </text>
                  </box>
                ) : (
                  <box
                    flexDirection="column"
                    onMouseUp={() => {
                      c.activateAt(entry.directory)
                    }}
                  >
                    <box flexDirection="row" gap={1}>
                      <text flexShrink={0} fg={entry.id === c.highlightedId() ? colors.accent : undefined}>
                        {entry.id === c.highlightedId() ? "›" : " "}
                      </text>
                      <text flexShrink={0} fg={entry.current ? colors.check : undefined}>
                        {entry.current ? "●" : " "}
                      </text>
                      <text
                        flexGrow={1}
                        overflow="hidden"
                        wrapMode="none"
                        fg={entry.id === c.highlightedId() ? colors.accent : colors.base}
                        attributes={entry.id === c.highlightedId() ? TextAttributes.BOLD : undefined}
                      >
                        {entry.display}
                      </text>
                      <text flexShrink={0} fg={colors.muted} wrapMode="none">
                        {entry.updated}
                      </text>
                    </box>
                    <box paddingLeft={2}>
                      <text fg={colors.muted} overflow="hidden" wrapMode="none">
                        {metaFor(entry)}
                      </text>
                    </box>
                  </box>
                )
              }
            </For>
          </scrollbox>
        </Show>
      </box>
      <box flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={1} flexShrink={0}>
        <For each={FOOTER_ACTIONS}>
          {action => (
            <text fg={colors.base} wrapMode="none" flexShrink={0}>
              {action.title} <span style={{ fg: colors.muted }}>{keyFor(action)}</span>
            </text>
          )}
        </For>
      </box>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Flow: shows the dialog, serves the switch request, and reports the outcome.
// ---------------------------------------------------------------------------

export type FolderPickerDialogSurface = {
  show(render: () => JSX.Element, onClose?: () => void): unknown
  set?(options: { size?: "medium" | "large" | "xlarge"; centered?: boolean }): unknown
  clear(): unknown
  alert(options: { title: string; message: string }): Promise<void>
}

export type FolderPickerDeps = {
  readonly dialog: FolderPickerDialogSurface
  readonly layer: (factory: () => KeymapLayer) => void
  readonly shortcut?: (id: string) => readonly string[] | undefined
  readonly themeMode?: string
  readonly loadFolders: () => Promise<{ sessions?: unknown; projects?: unknown }>
  readonly favorites?: () => readonly string[]
  readonly toggleFavorite?: (directory: string) => void | Promise<void>
  readonly switchFolder: (directory: string) => void | Promise<void>
  readonly current?: () => string | undefined
  readonly formatPath?: (value: string) => string
  readonly now?: () => number
  readonly toast: (options: { message: string; variant?: "info" | "success" | "warning" | "error" }) => void
  /** Receives the picker controller once per invocation (used by tests). */
  readonly onController?: (controller: FolderPickerController) => void
}

export async function runFolderPicker(deps: FolderPickerDeps) {
  const { dialog, layer } = deps
  const toast = deps.toast
  let loaded: { sessions?: unknown; projects?: unknown }
  try {
    loaded = await deps.loadFolders()
  } catch (error) {
    const message = errorMessage(error)
    toast({ message: `Could not load recent folders from the server: ${message}`, variant: "error" })
    return { status: "error", message }
  }
  const sessions = Array.isArray(loaded?.sessions) ? (loaded.sessions as Record<string, unknown>[]) : []
  const projects = Array.isArray(loaded?.projects) ? (loaded.projects as Record<string, unknown>[]) : []
  const favorites = normalizeFavorites(deps.favorites?.())
  if (!sessions.length && !projects.length && !favorites.length) {
    await dialog.alert({
      title: "Recent folders",
      message: "No recently opened folders were found on the connected server. Open a folder or start a session first.",
    })
    return { status: "cancelled" }
  }
  const controller = createFolderPickerController({
    sessions,
    projects,
    favorites: deps.favorites ?? (() => []),
    toggleFavorite: deps.toggleFavorite,
    current: deps.current,
    formatPath: deps.formatPath,
    now: deps.now,
    toast,
  })
  deps.onController?.(controller)
  try {
    // One dialog session. onClose resolves it; Enter resolves it through a
    // controller request. Anything that replaces the dialog (another plugin,
    // a nested host dialog) ends the session and cancels the picker.
    let settleClosed: ((value: { readonly type: "closed" }) => void) | undefined
    let settled = false
    const closed = new Promise<{ readonly type: "closed" }>(resolve => {
      settleClosed = value => {
        if (settled) return
        settled = true
        resolve(value)
      }
    })
    controller.resetRequests()
    // Await the show: the host's dialog surface may yield a macrotask before
    // pushing the dialog, and its replace would reset any size set in the
    // meantime.
    await dialog.show(
      () =>
        FolderPickerDialog({
          controller,
          layer,
          shortcut: deps.shortcut,
          themeMode: deps.themeMode,
        }),
      () => settleClosed?.({ type: "closed" }),
    )
    dialog.set?.({ size: "large" })
    const outcome = await Promise.race([closed, controller.takeRequest()])
    if (outcome.type === "closed") return { status: "cancelled" }
    dialog.clear()
    try {
      await deps.switchFolder(outcome.directory)
    } catch (error) {
      const message = errorMessage(error)
      toast({ message: `Could not switch folders: ${message}`, variant: "error" })
      return { status: "error", directory: outcome.directory, message }
    }
    toast({
      message: `Switched to ${deps.formatPath?.(outcome.directory) ?? outcome.directory}.`,
      variant: "success",
    })
    return { status: "switched", directory: outcome.directory }
  } finally {
    controller.dispose()
  }
}
