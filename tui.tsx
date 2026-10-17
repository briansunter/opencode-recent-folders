// TUI entry: wires folder discovery, durable favorites, folder switching, and
// the picker command into the host. The dialog itself lives in dialog.tsx and
// the pure logic in core.js.
import { Plugin } from "@opencode/plugin/tui"
import type { Destination } from "@opencode/plugin/tui/context"
import type { JSX } from "@opentui/solid"
import { FolderLocation, discoverSessions, errorMessage, toggleFolderFavorite } from "./core.js"
import { runFolderPicker } from "./dialog.tsx"

type FavoritesState = { folders: string[] }

function bindFromOption(value: unknown, fallback: string): string | false {
  if (value === false) return false
  if (typeof value === "string" && value.trim()) return value.trim()
  return fallback
}

export default Plugin.define({
  id: "local.recent-folders.tui",
  setup(context) {
    // Durable favorites: persisted to disk and live-synced across running
    // TUIs, so a ctrl+f in one window re-sorts the list in every other one.
    const [favorites, setFavorites] = context.storage.store<FavoritesState>("favorites", {
      initial: { folders: [] },
    })

    const toggleFavorite = async (directory: string) => {
      await setFavorites(draft => {
        draft.folders = toggleFolderFavorite(draft.folders, directory)
      })
    }

    // One macrotask of breathing room before pushing a dialog: the host is
    // still dispatching the key that started the command, and a dialog pushed
    // mid-dispatch can race the host's own key handling.
    const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
    const hostDialog = context.ui.dialog
    const dialog = {
      async show(render: () => JSX.Element, onClose?: () => void) {
        await tick()
        hostDialog.show(render, onClose)
      },
      set(options: { size?: "medium" | "large" | "xlarge"; centered?: boolean }) {
        hostDialog.set(options)
      },
      clear() {
        hostDialog.clear()
      },
      async alert(options: { title: string; message: string }) {
        await tick()
        return hostDialog.alert(options)
      },
    }

    // Folder switching. The home route's `location` is not part of the
    // documented Destination type even though the host router accepts it (the
    // built-in open menu and worktree flows navigate with one), hence the
    // cast. FolderLocation is a class instance on purpose: the router applies
    // navigations through Solid's reconcile, which mutates plain objects in
    // place, so a plain `{ directory }` would leave the route's location
    // reference unchanged on a home→home switch — the Home screen effect would
    // never re-run and the new directory would never sync. A class instance
    // cannot be wrapped, so reconcile replaces the reference every time and
    // the location provider performs the same set + server sync the built-ins
    // trigger with their direct location.set call.
    const switchFolder = (directory: string) => {
      context.ui.router.navigate({ type: "home", location: new FolderLocation(directory) } as unknown as Destination)
    }

    const loadFolders = async () => {
      // Global discovery through the server: the TUI's own session cache only
      // holds sessions this instance has loaded, so a fresh directory would
      // list nothing. Bounded by a timeout so a hung server cannot wedge the
      // command (and its busy guard) forever.
      const discovery = await discoverSessions({
        list: (input, requestOptions) => context.client.session.list(input, requestOptions),
        signal: AbortSignal.timeout(15000),
      })
      // Projects add directories that were opened without a session. A failed
      // project sync degrades to whatever the cache already holds: the
      // session list is the primary source, and a partial picker still works.
      let projects: unknown[] = []
      try {
        await context.data.project.sync()
        projects = context.data.project.list() ?? []
      } catch {
        projects = context.data.project.list() ?? []
      }
      return { sessions: discovery.sessions, projects }
    }

    const picker = () =>
      runFolderPicker({
        dialog,
        layer: context.keymap.layer,
        shortcut: context.keymap.shortcuts,
        themeMode: context.themeMode,
        loadFolders,
        favorites: () => favorites.folders,
        toggleFavorite,
        switchFolder,
        current: () => context.location?.directory,
        formatPath: value => context.ui.format.path(value),
        now: () => Date.now(),
        toast: options => context.ui.toast.show(options),
      })

    // One interactive flow at a time; re-running the command while its dialog
    // is open is ignored instead of stacking a second modal.
    let busy = false
    const runExclusively = (flow: () => Promise<unknown>) => () => {
      if (busy) return
      busy = true
      void Promise.resolve()
        .then(flow)
        .catch(error => {
          context.ui.toast.show({ message: errorMessage(error), variant: "error" })
        })
        .finally(() => {
          busy = false
        })
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "local.recent-folders.open",
          title: "Open recent folders",
          description:
            "Pick a recently opened folder (favorites pinned on top, grouped by day) and switch OpenCode to it.",
          group: "Recent Folders",
          palette: true,
          // "folders"/"recent" are free; the built-in open menu owns
          // "open"/"projects"/"project", so those are deliberately not used.
          slash: { name: "folders", aliases: ["recent"] },
          suggested: true,
          bind: bindFromOption(context.options.foldersBind, "<leader>f"),
          run: runExclusively(picker),
        },
      ],
    }))
  },
})
