# Plugins (API v1)

LearnHarness loads trusted local plugins, similar to Obsidian community plugins. A plugin can add browser UI, server code, background work and agent loops without changing the core app.

**Plugins are not sandboxed.** An enabled plugin runs with the same privileges as LearnHarness: it can read and write any file, read API keys and credentials, make network requests and spend provider credits. Enable only code you have read or trust. New plugins are always disabled.

## Layout

Plugins live in the active data directory, separate from app source:

```text
$LH_DATA_DIR/plugins/            # default: learnharness/data/plugins/
  enabled.json                   # {"version":1,"enabled":{"my-plugin":true}}
  my-plugin/
    manifest.json
    main.js        # optional browser ES module
    backend.cjs    # optional Node CommonJS module
    styles.css     # optional; requires main.js
    assets/        # public files (images, extra ES modules, wasm)
    data/          # plugin-owned records; never served
```

`manifest.json`:

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "apiVersion": 1,
  "description": "Optional",
  "main": "main.js",
  "backend": "backend.cjs",
  "styles": "styles.css"
}
```

- `id` must match the folder name: lowercase letters, digits and hyphens, at most 64 characters.
- `version` is semver. `apiVersion` must be `1`.
- Entry names are fixed (`main.js`, `backend.cjs`, `styles.css`). Omit the ones you don't use.

Only `main.js`, `styles.css` and files under `assets/` are served, from `/api/plugins/<id>/...`. `backend.cjs`, `manifest.json`, `data/`, `.cjs` files and symlinks leading out of `assets/` are refused.

## Lifecycle

Both entry modules export `onload(api)` and optionally `onunload()`. `onload` may return a cleanup function.

On disable, edit or failure the host:

1. aborts every managed background task's `AbortSignal`;
2. runs registered cleanups in reverse order (event listeners, handlers, commands, panels, styles);
3. calls `onunload`.

The server checks for changes to manifest and entry files on each plugin request, and reloads changed backends. Open windows poll every 5 seconds and reload changed frontends. Browser ES modules cannot be evicted from memory, so a reload imports a fresh URL; refresh the window if old module-level state matters. Code that ignores `AbortSignal` or leaves its own timers running can't be forcibly stopped. A server restart is the hard stop.

A plugin that throws during load is reported in **Settings → Plugins** and in `./learn plugins list`. Other plugins keep running.

## Browser API (`main.js`)

```js
export async function onload(api) {
  api.manifest;                       // parsed manifest
  await api.rpc("method", input);     // call a backend handler (JSON in/out)
  api.assetUrl("icon.png");           // URL of assets/icon.png
  await api.core.request("/api/graph"); // fetch a core /api/ route
  api.events.on("name", fn);          // window CustomEvent; auto-removed
  api.events.emit("name", value);
  api.commands.register({ id, name, run }); // button in the plugin tray
  api.panels.register("Title", (el) => cleanup); // collapsible panel
  await api.tasks.list();             // this plugin's background tasks
  await api.tasks.cancel(taskId);
  api.registerCleanup(fn);
}
```

Commands and panels appear in the plugin workspace in the bottom-right corner of the app.

## Server API (`backend.cjs`)

```js
exports.onload = async (api) => {
  api.handle("method", async (input) => result);   // exposed to api.rpc
  api.storage.read("key");                         // data/key.json or null
  api.storage.write("key", value);                 // atomic JSON write
  api.dataDir; api.pluginDir;                      // absolute paths
  api.events.on("name", fn); api.events.emit("name", value); // server bus shared by plugins
  const taskId = api.background("Label", async (signal) => result);
  const agentTask = api.agents.run({
    role: "researcher",          // any model role; uses the user's model slots
    systemPrompt: "…",
    prompt: "…",
    maxTurns: 8,                 // 1–100
    tools: [],                   // optional pi-agent-core AgentTool objects
  });
  api.tasks.list(); api.tasks.cancel(taskId);
  api.core.stores;               // chatStore, graphStore, jobStore, settingsStore
  api.core.effectiveSettings();  // resolved settings
  api.core.graphView();          // derived graph snapshot
  api.log("message");
  api.registerCleanup(fn);
  return () => {};               // optional cleanup
};
```

Background tasks keep the 100 most recent finished entries per plugin. Running tasks are never discarded. `api.agents.run` fails clearly when the role has no configured model.

`api.core.stores` provides direct access to the app's real stores. Writing through them bypasses the core's validation routes. Prefer read operations, and treat writes as you would edits to a database.

## HTTP

| Request | Purpose |
|---|---|
| `GET /api/plugins` | discovered plugins, state and errors |
| `PUT /api/plugins/<id>` `{"enabled":true,"trust":true}` | enable/disable |
| `POST /api/plugins/<id>/rpc` `{"method":"…","input":…}` | call a backend handler |
| `GET /api/plugins/<id>/<main.js / styles.css / assets/…>` | public files |

`PUT` and `POST` require a same-origin `Origin` header, `Content-Type: application/json` and `x-lh-plugin: 1`. They accept bodies up to 1 MiB. This stops ordinary cross-site pages from enabling or calling plugins. It does not replace user authentication, so don't expose a development server publicly. In the desktop app, the existing desktop API capability header applies too.

## Getting started

```bash
./learn plugins create my-plugin      # copy of examples/plugins/hello-plugin
$EDITOR learnharness/data/plugins/my-plugin/backend.cjs
./learn plugins enable my-plugin --trust
./learn start && ./learn open
```

The example plugin registers a counter command, a panel, plugin storage, a cancellable two-second background task and an agent summarization handler. The agent handler only spends credits if you call it.

The packaged desktop app uses its own user-data directory, so its plugins live in that directory's `plugins/` subdirectory.
