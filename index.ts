// Server-side entry. This plugin has no server behavior: folder discovery
// (client.session.list + the project cache), favorites storage, and the
// picker dialog all live in the TUI entry (tui.tsx). The file exists so
// plugin discovery finds the package's main entrypoint.
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "local.recent-folders",
  setup() {
    // Nothing to do server-side.
  },
})
