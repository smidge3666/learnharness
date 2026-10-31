# LearnHarness manager

A terminal dashboard and command-line tool for building, testing, configuring, running and publishing your LearnHarness checkout. It uses Python 3.10+ and only the standard library. It runs on Linux and macOS (it uses `curses` and `fcntl`).

```bash
cd ~/Projects/Learn
./learn            # dashboard
./learn --help     # every command
```

`learnharness/scripts/learn` does the same from inside the repository.

## Dashboard keys

The dashboard is deliberately minimal: four keys.

| Key | Action |
|---|---|
| O | open app-dev (restarts the dev server automatically; test data, never your real chats) |
| A | build your current code and install it as the main app (real chats) |
| X | stop the dev server |
| P | list, create, install, enable or disable plugins |
| Q | quit the dashboard; a running dev server keeps running |

Commands that produce output leave the dashboard temporarily and return on Enter. Ctrl-C cancels a running command.

Everything else stays available as `./learn` commands for scripting and agents: `install`, `start`, `stop`, `restart`, `build`, `test`, `typecheck`, `lint`, `check`, `status`, `logs`, `config`, `settings`, `plugins`, `backup`, `desktop`, `git`. Run `./learn --help` for the full list.

## Two modes

| | app-dev (O) | Main app (A installs) |
|---|---|---|
| Purpose | test features while you edit | your real daily app |
| Code | live `next dev`, hot reload | packaged build of your current code |
| Data, chats, keys | `learnharness/data/`, `learnharness/auth.json` | `~/.config/LearnHarness/` (your real chats) |
| Opens from | `O` / `./learn open` | app menu "LearnHarness" / `./learn desktop open` |

`O` always opens app-dev, even after installing, so testing never touches your real chats. `./learn open --browser` opens app-dev in the browser instead.

`A` / `./learn desktop install` builds your current code (including uncommitted edits), runs the smoke tests, packages it with Electron and installs it to `~/.local/share/learnharness/` with a menu entry at `~/.local/share/applications/learnharness.desktop`. No sudo needed. It uses the same profile as the official app, so your chats, settings and keys carry over unchanged; nothing is copied or migrated. Release auto-updates are off in this build, so an upstream release can't replace your edits. Press `A` again to update. Quit the main app and stop app-dev (`X`) before installing.

## Server

`./learn start` starts a small detached supervisor that runs `next dev` (mode `dev`) or `.next/standalone/server.js` (mode `production`) on `127.0.0.1:<port>`. The server keeps running after the dashboard closes. Stop it with X or `./learn stop`.

The supervisor holds a lock and answers an authenticated control port. Its state lives in `learnharness/.launcher/server.json`. The manager stops only servers it started. If the port is already busy, it refuses to start rather than adopt an unknown process.

Production mode requires `./learn build` first. The dashboard shows whether the build is older than your source edits, based on a hash of tracked and untracked files.

## Settings

`./learn settings list` shows supported feature switches and values. Examples:

```bash
./learn settings set graph.enabled false
./learn settings set agent.tools.research false
./learn settings set appearance.mode '"light"'     # JSON value
./learn settings set compaction.thresholdTokens 200000
```

While the server runs, changes go through the app's own validated `/api/settings/<section>` route. When it's stopped, the manager edits `settings.json` in the data directory directly, with the same type and range checks. Reload an open window to see UI preference changes. Model slots and API keys stay in the app's Settings dialog.

## Plugins

See `../docs/plugins.md`. Plugins are disabled by default. Enabling one requires `--trust` on the command line or typing `TRUST` in the dashboard, because plugin code is not sandboxed.

## Backups

`./learn backup` writes `learnharness/.launcher/backups/<timestamp>.tar.gz` (mode 0600). The archive contains chats, the graph, jobs, settings, prompt overrides and plugin `data/` records. It excludes `auth.json`, credential files, `.env*`, installed plugin code and symlinks. The archive is still private learning data.

## GitHub

Updates (U / `./learn git fetch`) always come from **https://github.com/amosblomqvist/learnharness**, tracked under `upstream/*`. The manager creates the `upstream` remote on first fetch; if that name already points somewhere else, it refuses to overwrite it. Fetching never merges or installs updates.

The publish remote remains the separate `remote` config value (default `origin`, currently `smidge3666/learnharness`). Publishing uses your existing Git credentials. Its pre-push divergence check fetches your publish remote, not upstream.

```bash
./learn git status
./learn git fetch
./learn git publish -m "feat: plugin host"   # or just: ./learn git publish
./learn git push                  # push commits you already made
```

`G` / `./learn git publish` sends everything in one step, with no prompts:

1. stages all changes and new files (`git add -A`, respecting `.gitignore`);
2. commits with your `-m` message, or an automatic one;
3. pushes normally to your publish remote.

It refuses, before staging anything, if a change would publish keys or private data (`auth.json`, `.env*`, credentials, `data/`, `.launcher/`, build output), if a merge or rebase is in progress, or if GitHub has commits you don't have. In that last case your work is already committed locally; pull, then publish again. It never force-pushes. Add `--check` to run the full test suite first.

## Files

| Path | Contents |
|---|---|
| `learnharness/.launcher/config.json` | launcher config |
| `learnharness/.launcher/server.log` | server output |
| `learnharness/.launcher/build.json` | last build time and source hash |
| `learnharness/.launcher/backups/` | data backups |

`.launcher/` is git-ignored. `LH_DATA_DIR` and `LH_AUTH_FILE` environment variables override the configured paths.

## Tests

```bash
cd learnharness && python3 -m unittest discover -s manager/tests -v
```
