# OpenCode Recent Folders

**Jump back into any folder you worked in recently — and start a new session there.**

`/folders` (default `<leader>f`) opens a picker of recently opened folders:

- **★ Favorites** pinned at the top — press `ctrl+f` on any folder to pin or unpin it;
- **Today**, **Yesterday**, then one section per day ("Wed, Oct 14"), newest activity first;
- the folder you are in right now is marked `●`;
- **Enter** switches OpenCode to the highlighted folder: the TUI navigates home to it and
  syncs the location with the server, exactly like the built-in open menu — ready for a new
  session in that directory.

Uses only documented OpenCode **2.0** plugin APIs: a TUI keymap command, the custom-JSX
`ui.dialog.show` surface, durable plugin storage, `client.session.list` cursor pagination,
the TUI data caches, and `ui.router.navigate`. No V1 hooks, legacy SDK, filesystem IPC, or
extra credentials. Tested with OpenCode **2.0.30**.

## Install

```sh
opencode plugin add github:briansunter/opencode-recent-folders
opencode reload
```

Requires **OpenCode 2.0**, not V1. Check with `opencode --version`. The package ships both
entrypoints (a no-op server plugin and the TUI plugin); there is nothing to add to
`cli.json` and no dependencies to install by hand. It is published on GitHub, not npm.

## Use

In an OpenCode TUI, press **`<leader>f`** (default leader is `ctrl+x`, so `ctrl+x f`), run
**Open recent folders** from the command palette (`ctrl+p`), or type `/folders`
(alias `/recent`).

| Key | Action |
| --- | --- |
| `up` / `down` | Move the highlight (headers are skipped; the list wraps) |
| `pageup` / `pagedown` | Move ten rows at a time |
| `home` / `end` | First / last folder |
| `enter` | Switch OpenCode to the highlighted folder |
| `ctrl+f` | Pin or unpin the highlighted folder as a favorite |
| `escape` | Close without switching |

Typing filters live on the folder path, the last session title, and the project name;
space-separated terms must all match. Every key binding is a named command
(`local.recent-folders.picker.*`) and can be rebound by ID.

### What counts as "recent"

The picker asks the connected server for the newest sessions (cursor-paginated, capped at the
1000 most recent — child/subagent sessions included, since they mark activity in their folder)
and merges the project list for folders that were opened without a session. Each folder shows
its session count, the title of its most recent session, the project name, and when it was
last active. Favorites persist in plugin storage, so they survive restarts and stay in sync
across running TUIs.

## Configuration

Rebind or disable by command ID in `~/.config/opencode/cli.json` (merge; don't replace your
other settings):

```json
{
  "keybinds": {
    "local.recent-folders.open": "ctrl+alt+f"
  }
}
```

Or set the default binding where the plugin is configured:

```jsonc
{
  "plugins": [
    {
      "package": "github:briansunter/opencode-recent-folders",
      "options": { "foldersBind": "<leader>o" }
    }
  ]
}
```

`false` disables the automatic binding; the command stays in the palette and slash completion.
Inside the picker, keys are registered in the host's **modal** keymap mode, so they apply only
while the dialog is open and never leak to the background or other dialogs.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| The command is missing | Run `opencode plugin list`, then `opencode reload`; reopen the TUI so the `./tui` entrypoint loads. |
| "No recently opened folders were found…" | The server really has no sessions or projects yet. Open a folder or start a session first, then run `/folders` again. |
| "Could not load recent folders from the server: …" | The discovery request failed or timed out (15s). Check the connection and run `/folders` again. |
| "Could not switch folders: …" | The location sync failed. The message is the server's error; check the connection and retry. |
| A favorite points at a deleted folder | Still listed (favorites persist); pressing Enter surfaces the server's error instead of switching. `ctrl+f` unpins it. |

## Local development

```sh
git clone https://github.com/briansunter/opencode-recent-folders.git
cd opencode-recent-folders
bun install        # dev-only dependencies (plugin types, OpenTUI peers for tests)
bun test           # logic tests + real-UI dialog tests (bunfig.toml preloads the Solid JSX transform)
bun run typecheck  # tsc --noEmit against @opencode/plugin 2.0.30 types
```

To load the checkout instead, symlink it into OpenCode's plugin directory and reload:

```sh
mkdir -p ~/.config/opencode/plugins
ln -s "$(pwd)" ~/.config/opencode/plugins/recent-folders
opencode reload
```

Use either the GitHub installation or the local symlink, not both.

### How it works

1. `core.js` is pure logic: folder index building (sessions + projects per directory), day
   bucketing and relative times, favorites normalization, row/section building, filtering,
   and cursor-paginated session discovery.
2. `dialog.tsx` holds the picker controller (Solid state outside the dialog component), the
   dialog view, its modal keymap commands, and the single-pass flow: load → show → wait for a
   switch request or a close → clear → switch → toast.
3. `tui.tsx` wires it to the host: favorites in `context.storage.store` (durable, live-synced),
   discovery through `client.session.list` plus `data.project.sync()`, and the switch through
   `ui.router.navigate({ type: "home", location })`.
4. `index.ts` is a no-op server plugin; everything happens in the TUI.

One implementation detail worth knowing: the `location` passed to `navigate` is a
`FolderLocation` **class instance**, not a plain object. The TUI router applies navigations
through Solid's `reconcile`, which mutates plain objects in place — on a home → home switch a
plain object would leave the route's location reference unchanged, so the Home screen effect
would never re-run and the new directory would never sync. A class instance cannot be wrapped,
so reconcile replaces the reference every time and the location provider performs the same
set + server sync the built-in open menu triggers with its direct `location.set` call.

Tests: `core.test.js` covers index merging, day labels, favorites, row building and ordering,
filter pruning with header recounts, the `FolderLocation` contract, and discovery pagination.
`dialog-ui.test.tsx` mounts the real dialog through OpenTUI's test renderer and types into the
real search input: section rendering, filtering by path and project name, header-skipping
navigation with wrapping, `enter`-to-switch with dialog clear + toast, favorite pin/unpin
re-sorting, escape fall-through, the empty-server alert, favorites-only state, load failures,
and the modal keymap scope the bindings live in.

## License

[MIT](LICENSE) © 2026 Brian Sunter. Free to use, modify, and redistribute, including
commercially, with the license notice retained.
