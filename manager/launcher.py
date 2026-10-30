#!/usr/bin/env python3
"""LearnHarness local workbench. Python 3.10+, standard library only (POSIX TUI)."""
from __future__ import annotations

import argparse
import contextlib
import curses
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = Path(__file__).resolve().parents[2]
DEFAULT_REPO = HOME / "learnharness"
UPDATE_URL = "https://github.com/amosblomqvist/learnharness.git"
PLUGIN_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")
FEATURES = {
    "general.autoUpdate": True,
    "graph.enabled": True,
    "graph.rendering": True,
    "agent.graphTools.enabled": True,
    "agent.tools.research": True,
    "agent.tools.demo": True,
    "agent.tools.visual": True,
    "agent.tools.pdf": True,
    "agent.tools.explain": True,
    "claudeCode.enabled": False,
    "appearance.mode": "dark",
    "appearance.proseFontSize": 16,
    "graph.extractionChunkTokens": 4096,
    "compaction.thresholdTokens": 150000,
}


def read_json(file, default=None):
    try:
        return json.loads(Path(file).read_text())
    except FileNotFoundError:
        return default


def write_json(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".lh-", dir=file.parent)
    try:
        with os.fdopen(fd, "w") as out:
            json.dump(value, out, indent=2)
            out.write("\n")
        os.replace(name, file)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def atomic_text(file, text, mode):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".lh-", dir=file.parent)
    try:
        with os.fdopen(fd, "w") as out:
            out.write(text)
        os.chmod(name, mode)
        os.replace(name, file)
    finally:
        if os.path.exists(name):
            os.unlink(name)

def desktop_string(value):
    """Escape a value for a .desktop string field (no newlines allowed)."""
    value = str(value)
    if any(c in value for c in "\n\r\t"):
        raise RuntimeError("Paths with control characters are not supported in desktop entries")
    return value.replace("\\", "\\\\")

def desktop_exec(path):
    """Quote a path for the Exec key (Desktop Entry spec: quote, escape \\ \" ` $, double % )."""
    value = str(path)
    if any(c in value for c in "\n\r\t"):
        raise RuntimeError("Paths with control characters are not supported in desktop entries")
    quoted = '"' + re.sub(r'(["`$\\])', r'\\\1', value) + '"'
    return desktop_string(quoted).replace("%", "%%")

def capture(args, cwd, check=True):
    result = subprocess.run(args, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or f"Command failed: {shlex.join(args)}")
    return result.stdout.rstrip("\n")


NODE_HELP = """Install Node.js 26 (the version LearnHarness CI uses) with nvm, no sudo needed:
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
  exec bash            # reload the shell
  nvm install 26 && nvm alias default 26
Then run ./learn install (npm ci) once."""


def require_node():
    """Next 16 needs Node >= 20.9; distro Node 18 often ships without npm."""
    node, npm = shutil.which("node"), shutil.which("npm")
    if not node:
        raise RuntimeError("Node.js not found on PATH.\n" + NODE_HELP)
    version = capture([node, "--version"], HOME).lstrip("v")
    major, minor = (int(x) for x in version.split(".")[:2])
    if (major, minor) < (20, 9):
        raise RuntimeError(f"Node {version} at {node} is too old (Next.js 16 needs 20.9+).\n" + NODE_HELP)
    if not npm:
        raise RuntimeError(f"npm not found (Node {version} at {node}).\n" + NODE_HELP)
    return version


def run(args, cwd, env=None):
    print("\n$ " + shlex.join(map(str, args)), flush=True)
    if args[0] in ("npm", "node", "npx"):
        require_node()
    try:
        child = subprocess.Popen(args, cwd=cwd, env=env, start_new_session=True)
    except FileNotFoundError:
        raise RuntimeError(f"Command not found: {args[0]}") from None
    try:
        code = child.wait()
    except KeyboardInterrupt:
        stop_group(child)
        raise RuntimeError("Cancelled") from None
    if code:
        raise RuntimeError(f"Command exited {code}: {shlex.join(map(str, args))}")


def stop_group(child):
    if child.poll() is not None:
        return
    with contextlib.suppress(ProcessLookupError):
        os.killpg(child.pid, signal.SIGTERM)
    try:
        child.wait(timeout=8)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(child.pid, signal.SIGKILL)
        child.wait()


class Manager:
    def __init__(self, repo=DEFAULT_REPO):
        self.repo = Path(repo).expanduser().resolve()
        if not (self.repo / "package.json").is_file() or not (self.repo / ".git").exists():
            raise RuntimeError(f"Not a LearnHarness checkout: {self.repo}")
        self.state = self.repo / ".launcher"
        self.state.mkdir(exist_ok=True, mode=0o700)
        self.config_file = self.state / "config.json"
        defaults = {"port": 3000, "mode": "dev", "data_dir": str(self.repo / "data"),
                    "auth_file": str(self.repo / "auth.json"), "remote": "origin", "open": "electron"}
        self.saved = defaults | (read_json(self.config_file, {}) or {})
        self.config = dict(self.saved)  # runtime view; env overrides are never persisted
        self.config["data_dir"] = str(Path(os.environ.get("LH_DATA_DIR", self.config["data_dir"])).expanduser().resolve())
        if self.config["mode"] not in ("dev", "production") or not 1024 <= int(self.config["port"]) <= 65535:
            raise RuntimeError("Invalid launcher mode/port in config.json")
        self.config["auth_file"] = str(Path(os.environ.get("LH_AUTH_FILE", self.config["auth_file"])).expanduser().resolve())
        self.data = Path(self.config["data_dir"])
        self.plugins = self.data / "plugins"
        self.url = f"http://127.0.0.1:{self.config['port']}"

    def git(self, *args, check=True):
        return capture(["git", *args], self.repo, check=check)

    def env(self):
        return os.environ | {"LH_DATA_DIR": str(self.data), "LH_AUTH_FILE": self.config["auth_file"],
                             "NEXT_TELEMETRY_DISABLED": "1", "HOSTNAME": "127.0.0.1", "PORT": str(self.config["port"])}

    def control(self, action="status"):
        state = read_json(self.state / "server.json")
        if not state:
            return None
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{state['control_port']}/{action}",
                headers={"Authorization": "Bearer " + state["token"]},
                method="POST" if action == "stop" else "GET")
            with urllib.request.urlopen(req, timeout=2) as res:
                return json.load(res)
        except (OSError, ValueError, KeyError):
            return None  # stale state is never permission to signal an arbitrary PID

    def api(self, route, method="GET", body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.url + route, data=data, method=method,
            headers={"Content-Type": "application/json", "Origin": self.url, "x-lh-plugin": "1"})
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                return json.load(res)
        except urllib.error.HTTPError as e:
            raise RuntimeError(e.read().decode(errors="replace")) from e

    def start(self):
        existing = self.control()
        if existing and existing.get("running"):
            print(f"Already running: {existing['url']} ({existing['mode']})")
            return
        require_node()
        if not (self.repo / "node_modules" / "next").exists():
            raise RuntimeError("Dependencies missing. Run ./learn install first.")
        if self.config["mode"] == "production" and not (self.repo / ".next/standalone/server.js").exists():
            raise RuntimeError("Production build missing. Run ./learn build first.")
        with socket.socket() as sock:
            try:
                sock.bind(("127.0.0.1", self.config["port"]))
            except OSError:
                raise RuntimeError(f"Port {self.config['port']} is occupied; refusing to adopt an unknown server") from None
        token = secrets.token_hex(32)
        log = open(self.state / "server.log", "ab", buffering=0)
        child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--repo", str(self.repo), "_serve", token],
                                 cwd=self.repo, env=self.env(), stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                 start_new_session=True)
        log.close()
        for _ in range(80):
            if child.poll() is not None:
                raise RuntimeError("Server worker failed; inspect ./learn logs")
            state = self.control()
            if state and state.get("token_match") == token:
                print(f"Started {self.url} ({self.config['mode']}). Use ./learn logs for readiness/errors.")
                return
            time.sleep(.1)
        raise RuntimeError("Worker did not become ready; inspect ./learn logs")

    def stop(self):
        result = self.control("stop")
        if not result:
            print("No managed server running (unknown processes were not touched).")
            return
        for _ in range(110):
            if not self.control():
                print("Stopped.")
                return
            time.sleep(.1)
        raise RuntimeError("Stop timed out; inspect server.log")

    def fingerprint(self):
        names = self.git("ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0")
        h = hashlib.sha256()
        for name in sorted(set(names)):
            if not name or name.startswith((".launcher/", "data/", "dist/")):
                continue
            file = self.repo / name
            h.update(name.encode())
            if file.is_file():
                h.update(file.read_bytes())
        return h.hexdigest()

    def build(self):
        if self.control():
            raise RuntimeError("Stop the managed server before rebuilding (.next is shared).")
        before = self.fingerprint()
        for command in [["npm", "run", "build"], ["node", "scripts/smoke-provider-runtime.mjs"],
                        ["node", "scripts/build-server.mjs"], ["node", "scripts/smoke-server.mjs"]]:
            run(command, self.repo, self.env())
        write_json(self.state / "build.json", {"at": dt.datetime.now().isoformat(timespec="seconds"), "fingerprint": before})
        print("Standalone build ready. Switch mode to production to launch it.")

    def check(self):
        for command in [["npm", "run", "typecheck"], ["npm", "test"], ["npm", "run", "lint"]]:
            run(command, self.repo, self.env())
        run([sys.executable, "-m", "unittest", "discover", "-s", "manager/tests", "-v"], self.repo)

    def set_config(self, key, value):
        if self.control():
            raise RuntimeError("Stop the managed server before changing launcher configuration.")
        if key not in self.config:
            raise RuntimeError("Unknown config key. Choose: " + ", ".join(self.config))
        if key == "port":
            value = int(value)
            if not 1024 <= value <= 65535:
                raise RuntimeError("Port must be 1024–65535")
        if key == "mode" and value not in ("dev", "production"):
            raise RuntimeError("Mode must be dev or production")
        if key == "open" and value not in ("browser", "electron"):
            raise RuntimeError("Open must be browser or electron")
        if key == "remote" and value not in self.git("remote").splitlines():
            raise RuntimeError("Remote is not configured in Git")
        if key in ("data_dir", "auth_file"):
            value = str(Path(value).expanduser().resolve())
        self.saved[key] = value
        write_json(self.config_file, self.saved)
        self.config[key] = value
        print(f"{key} = {value}")

    def settings(self):
        return read_json(self.data / "settings.json", {"version": 1})

    def setting_set(self, key, value):
        if key not in FEATURES:
            raise RuntimeError("Use settings list for supported keys; other settings stay in the app UI.")
        default = FEATURES[key]
        if type(value) is not type(default):
            raise RuntimeError(f"Expected {type(default).__name__}")
        if key == "appearance.mode" and value not in ("dark", "light"):
            raise RuntimeError("Appearance mode must be dark or light")
        floors = {"graph.extractionChunkTokens": 500, "compaction.thresholdTokens": 32000}
        if key in floors and value < floors[key]:
            raise RuntimeError(f"Minimum {floors[key]}")
        if key == "appearance.proseFontSize" and not 12 <= value <= 24:
            raise RuntimeError("Font size must be 12–24")
        running = self.control()
        record = self.api("/api/settings")["settings"] if running else self.settings()
        record = record or {"version": 1}
        if record.get("version", 1) != 1:
            raise RuntimeError("Unknown settings version; refusing to rewrite")
        section, *parts = key.split(".")
        target = record.setdefault(section, {})
        for part in parts[:-1]:
            target = target.setdefault(part, {})
        target[parts[-1]] = value
        if running:
            # Existing core validation and writer remain the authority while online.
            self.api("/api/settings/" + section, "PUT", record[section])
        else:
            write_json(self.data / "settings.json", record)
        print(f"{key} = {json.dumps(value)}. Reload the app window to refresh UI preferences.")

    def plugin_list(self):
        state = read_json(self.plugins / "enabled.json", {"version": 1, "enabled": {}})
        if state.get("version") != 1:
            raise RuntimeError("Unknown plugin state version")
        items = []
        if self.plugins.exists():
            for folder in sorted(self.plugins.iterdir()):
                if folder.is_dir() and PLUGIN_ID.fullmatch(folder.name):
                    try:
                        m = read_json(folder / "manifest.json")
                        validate_plugin(m, folder.name)
                        error = ""
                    except (ValueError, RuntimeError, TypeError) as e:
                        m, error = {}, str(e)
                    items.append({"id": folder.name, "manifest": m, "enabled": state["enabled"].get(folder.name) is True, "error": error})
        return items

    def plugin_enable(self, id, enabled, trust=False):
        items = {p["id"]: p for p in self.plugin_list()}
        if id not in items:
            raise RuntimeError("Plugin not installed")
        if enabled and items[id]["error"]:
            raise RuntimeError(items[id]["error"])
        if enabled and not trust:
            raise RuntimeError("Enabling trusts arbitrary browser/Node code, file access, credentials and provider spending. Review the plugin, then pass --trust.")
        if self.control():
            result = self.api("/api/plugins/" + id, "PUT", {"enabled": enabled, "trust": trust})
            errors = [p.get("error") for p in result["plugins"] if p["id"] == id and p.get("error")]
            if errors:
                raise RuntimeError("; ".join(errors))
        else:
            file = self.plugins / "enabled.json"
            state = read_json(file, {"version": 1, "enabled": {}})
            if state.get("version") != 1:
                raise RuntimeError("Unknown plugin state version")
            state["enabled"][id] = enabled
            write_json(file, state)
        print(f"{id}: {'enabled' if enabled else 'disabled'}. Open windows refresh within 5 seconds.")

    def plugin_create(self, id):
        if not PLUGIN_ID.fullmatch(id):
            raise RuntimeError("Plugin id must be lowercase letters, digits and hyphens (1–64 chars)")
        target = self.plugins / id
        if target.exists():
            raise RuntimeError("Plugin already exists")
        example = self.repo / "examples/plugins/hello-plugin"
        shutil.copytree(example, target)
        m = read_json(target / "manifest.json")
        m.update(id=id, name=id.replace("-", " ").title())
        write_json(target / "manifest.json", m)
        (target / "data").mkdir(mode=0o700)
        print(f"Created {target}. Disabled until explicitly enabled. Read docs/plugins.md.")

    def plugin_install(self, source):
        source = Path(source).expanduser().resolve()
        m = read_json(source / "manifest.json")
        validate_plugin(m)
        target = self.plugins / m["id"]
        if target.exists():
            raise RuntimeError("Plugin exists. Disable it and update its code manually; preserve data/.")
        # Never import arbitrary data, credentials, symlinks or hidden build directories.
        for file in source.rglob("*"):
            if file.is_symlink():
                raise RuntimeError("Install refuses symlinks")
        target.mkdir(parents=True, mode=0o700)
        try:
            for name in ["manifest.json", m.get("main"), m.get("backend"), m.get("styles"), "assets"]:
                if not name:
                    continue
                item = source / name
                if name == "assets" and not item.exists():
                    continue
                if item.is_dir():
                    shutil.copytree(item, target / name)
                else:
                    shutil.copy2(item, target / name)
            (target / "data").mkdir(mode=0o700)
        except BaseException:
            shutil.rmtree(target)
            raise
        print(f"Installed {m['id']} disabled at {target}")

    def backup(self):
        if self.control():
            raise RuntimeError("Stop the managed server first for a consistent data backup.")
        if not self.data.exists():
            raise RuntimeError("No data to back up yet")
        dest = self.state / "backups" / (dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".tar.gz")
        dest.parent.mkdir(mode=0o700, exist_ok=True)
        with open(dest, "xb") as raw:
            os.chmod(dest, 0o600)
            with tarfile.open(fileobj=raw, mode="w:gz") as archive:
                # Records, not installed executable plugin code. Never follow symlinks.
                for file in sorted(self.data.rglob("*")):
                    if not file.is_file() or file.is_symlink() or any(p.is_symlink() for p in file.parents if p != self.data.parent):
                        continue
                    relative = file.relative_to(self.data)
                    if relative.parts[0] == "plugins" and (len(relative.parts) < 4 or relative.parts[2] != "data"):
                        continue
                    # data/ here is plugin-owned records, not a reason to omit them.
                    record_path = Path(*relative.parts[3:]) if relative.parts[0] == "plugins" else relative
                    if sensitive_path(str(record_path)):
                        continue
                    archive.add(file, arcname=str(relative), recursive=False)
        print(f"Backup: {dest}\nContains private learning records and plugin data, NOT API keys or installed plugin code.")
        return dest

    def fetch_updates(self):
        # Keep upstream tracking separate from the fork used for publishing.
        if "upstream" not in self.git("remote").splitlines():
            self.git("remote", "add", "upstream", UPDATE_URL)
        urls = self.git("remote", "get-url", "--all", "upstream").splitlines()
        if urls != [UPDATE_URL]:
            raise RuntimeError(f"Existing upstream remote differs from {UPDATE_URL}; refusing to overwrite it.")
        run(["git", "fetch", "--no-tags", "upstream"], self.repo)
        print("Updates fetched from amosblomqvist/learnharness into upstream/*; nothing merged or installed.")

    def publish(self, message="", check=False):
        """One-shot publish: stage every non-ignored change, commit, push. No prompts."""
        branch = self.git("symbolic-ref", "--quiet", "--short", "HEAD")
        remote = self.config["remote"]
        url = self.git("remote", "get-url", "--push", remote)
        if not (re.match(r"https://github\.com/[^/]+/[^/]+", url) or re.match(r"git@github\.com:[^/]+/[^/]+", url)):
            raise RuntimeError("Configured publish remote is not GitHub")
        if any((self.repo / ".git" / marker).exists() for marker in ("MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD")):
            raise RuntimeError("Finish the in-progress merge/rebase/cherry-pick before publishing")
        if self.git("diff", "--name-only", "--diff-filter=U"):
            raise RuntimeError("Resolve merge conflicts before publishing")
        # Everything git would add (tracked edits + untracked, .gitignore respected).
        entries = iter(self.git("status", "--porcelain", "-z", "--untracked-files=all").split("\0"))
        changed = []
        for entry in entries:
            if not entry:
                continue
            changed.append(entry[3:])
            if "R" in entry[:2] or "C" in entry[:2]:
                changed.append(next(entries))  # original path of a rename/copy
        # Last line of defence: never push keys or private learning data, even if un-ignored.
        blocked = [c for c in changed if sensitive_path(c)]
        if blocked:
            raise RuntimeError("Refusing to publish private/generated files (add them to .gitignore):\n  " + "\n  ".join(blocked))
        if check:
            self.check()
        print(f"Publishing to {url} ({branch})")
        if changed:
            run(["git", "add", "-A"], self.repo)
            if self.git("diff", "--cached", "--name-only"):
                stamp = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
                message = message.strip() or f"update: {len(changed)} file(s) via manager ({stamp})"
                run(["git", "commit", "-m", message], self.repo)
        run(["git", "fetch", remote], self.repo)
        tracking = f"refs/remotes/{remote}/{branch}"
        exists = subprocess.run(["git", "show-ref", "--verify", "--quiet", tracking], cwd=self.repo).returncode == 0
        if exists and subprocess.run(["git", "merge-base", "--is-ancestor", tracking, "HEAD"], cwd=self.repo).returncode:
            raise RuntimeError(f"{remote}/{branch} has commits you don't have. Your work is committed locally; "
                               "pull/merge them, then publish again. (No force push.)")
        if exists and self.git("rev-parse", "HEAD") == self.git("rev-parse", tracking):
            print("Nothing new to publish.")
            return
        run(["git", "push", "--set-upstream", remote, f"HEAD:refs/heads/{branch}"], self.repo)
        print("Published. No force push was used.")

    def status(self):
        package = read_json(self.repo / "package.json")
        state = self.control()
        build = read_json(self.state / "build.json", {})
        built = "not built by manager"
        if build:
            built = ("up to date" if build["fingerprint"] == self.fingerprint() else "source changed — rebuild needed") + f" ({build['at']})"
        sessions = len(list((self.data / "chats").glob("*.json")))
        try:
            node = "v" + require_node() + " at " + shutil.which("node")
        except RuntimeError as e:
            node = "PROBLEM: " + str(e).splitlines()[0]
        return {"version": package["version"], "node": node, "branch": self.git("branch", "--show-current"),
                "changes": self.git("status", "--short"), "mode": self.config["mode"], "build": built,
                "server": state, "sessions": sessions, "data": str(self.data), "repo": str(self.repo),
                "plugins": self.plugin_list(), "updates": UPDATE_URL,
                "remote": self.git("remote", "get-url", self.config["remote"], check=False)}

    def desktop_paths(self):
        data_home = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")).expanduser().absolute()
        config_home = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")).expanduser().absolute()
        root = data_home / "learnharness"
        return {"root": root, "executable": root / "current/learnharness",
                "launcher": root / "launch", "shortcut": data_home / "applications/learnharness.desktop",
                "profile": config_home / "LearnHarness"}

    def desktop_install(self):
        if sys.platform != "linux":
            raise RuntimeError("Per-user desktop installation is currently supported on Linux only.")
        # A fresh build includes your edits. Do not replace .next beneath a live dev server.
        if self.control():
            raise RuntimeError("Stop the managed server with ./learn stop, then retry ./learn desktop install. Your data is preserved.")
        require_node()
        self.build()
        run(["node", "scripts/smoke-server.mjs", "--electron"], self.repo, self.env())
        output = self.state / "desktop-package"
        builder = self.repo / "node_modules/.bin/electron-builder"
        if not builder.exists():
            raise RuntimeError("electron-builder missing. Run ./learn install first.")
        run([str(builder), "--linux", "--dir", "--publish", "never",
             "--config.linux.executableName=learnharness",
             f"--config.directories.output={output}"], self.repo, self.env())
        payloads = list(output.glob("linux*-unpacked"))
        if len(payloads) != 1:
            raise RuntimeError(f"Expected one packaged Linux app in {output}; found {len(payloads)}")
        self.install_desktop_payload(payloads[0])

    def install_desktop_payload(self, payload):
        """Versioned payloads + atomic current symlink: a running old version stays intact."""
        payload = Path(payload)
        if not (payload / "learnharness").is_file() or not (payload / "resources/app.asar").is_file():
            raise RuntimeError("Incomplete desktop payload; nothing installed")
        if not (payload / "resources/server/standalone/server.js").is_file():
            raise RuntimeError("Packaged server missing; nothing installed")
        paths = self.desktop_paths()
        root = paths["root"]
        owner = root / "manager-install.json"
        marker = {"kind": "learnharness-manager", "version": 1}
        if root.exists() and read_json(owner) != marker:
            raise RuntimeError(f"{root} is not a manager-owned installation; refusing to overwrite")
        if paths["shortcut"].exists() and "X-LearnHarness-Manager=true" not in paths["shortcut"].read_text():
            raise RuntimeError("Desktop shortcut already exists and is not manager-owned")
        current = root / "current"
        if current.exists() and not current.is_symlink():
            raise RuntimeError("Install current path is not a symlink; refusing to overwrite")
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        write_json(owner, marker)
        releases = root / "releases"
        releases.mkdir(exist_ok=True)
        version = read_json(self.repo / "package.json")["version"]
        tag = dt.datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(4)
        destination = releases / tag
        temp_link = root / (".current-" + secrets.token_hex(4))
        try:
            shutil.copytree(payload, destination, symlinks=True)
            # Durable marker in resources means updates stay disabled even when launched directly.
            write_json(destination / "resources/local-build.json", {"localBuild": True, "version": version})
            os.chmod(destination / "learnharness", 0o755)
            temp_link.symlink_to(destination.relative_to(root), target_is_directory=True)
            # Version-neutral entry uses no shell expansion from manifest/config values.
            script = '#!/bin/sh\nset -eu\nROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\n'
            script += 'unset LH_DEV_URL LH_DATA_DIR LH_AUTH_FILE LH_UPDATE_FEED LH_DESKTOP_SERVER LH_DESKTOP_API_SECRET ELECTRON_RUN_AS_NODE\n'
            script += 'exec "$ROOT/current/learnharness" "$@"\n'
            atomic_text(paths["launcher"], script, 0o755)
            icon = root / "icon.png"
            shutil.copy2(self.repo / "build/icon.png", icon)
            entry = ("[Desktop Entry]\nType=Application\nName=LearnHarness\n"
                     "Comment=Your locally built LearnHarness, independent of the browser\n"
                     f"Exec={desktop_exec(paths['launcher'])}\nIcon={desktop_string(icon)}\n"
                     "Terminal=false\nCategories=Education;\n"
                     "X-LearnHarness-Manager=true\n")
            atomic_text(paths["shortcut"], entry, 0o644)
            os.replace(temp_link, current)
        except BaseException:
            temp_link.unlink(missing_ok=True)
            # Never delete the target after committing the current symlink.
            if not current.is_symlink() or current.resolve() != destination:
                shutil.rmtree(destination, ignore_errors=True)
            raise
        self.remove_legacy_desktop_shortcut()
        if shutil.which("update-desktop-database"):
            subprocess.run(["update-desktop-database", str(paths["shortcut"].parent)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print(f"Installed LearnHarness {version}: {root}")
        print(f"Application menu shortcut: {paths['shortcut']}")
        print(f"Existing desktop data: {paths['profile'] / 'data'}")
        print("Release updates are disabled. Re-run desktop install to rebuild/update your local app.")
        print("Existing app/repo data was not copied or changed. Use ./learn desktop open to launch.")

    def remove_legacy_desktop_shortcut(self):
        # Remove only our previous menu entry. Keep its profile and binaries intact.
        old = self.desktop_paths()["shortcut"].with_name("learnharness-local.desktop")
        if old.is_file() and "X-LearnHarness-Manager=true" in old.read_text():
            old.unlink()

    def desktop_open(self):
        paths = self.desktop_paths()
        if not paths["executable"].is_file() or not paths["launcher"].is_file():
            raise RuntimeError("Desktop app is not installed. Run ./learn desktop install first.")
        env = os.environ.copy()
        # A terminal previously used for dev must not redirect the installed app.
        for name in ("LH_DEV_URL", "LH_DATA_DIR", "LH_AUTH_FILE", "LH_UPDATE_FEED", "LH_DESKTOP_SERVER", "LH_DESKTOP_API_SECRET", "ELECTRON_RUN_AS_NODE"):
            env.pop(name, None)
        with open(self.state / "desktop.log", "ab", buffering=0) as log:
            subprocess.Popen([str(paths["launcher"])], cwd=paths["root"], env=env,
                             stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        print("Opened LearnHarness using the existing installed-app profile. It owns its server and does not need the terminal manager.")
        print(f"Startup output: {self.state / 'desktop.log'}")

    def open(self, target=None):
        target = target or self.config["open"]
        self.start()
        if target == "electron":
            # Always app-dev: installation must never redirect feature testing into real data.
            env = self.env() | {"LH_DEV_URL": self.url}
            env.pop("ELECTRON_RUN_AS_NODE", None)
            with open(self.state / "desktop.log", "ab", buffering=0) as log:
                subprocess.Popen([str(self.repo / "node_modules/.bin/electron"), "."], cwd=self.repo, env=env,
                                 stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
            print(f"Opened app-dev with test data at {self.data}. Startup output: {self.state / 'desktop.log'}")
        else:
            webbrowser.open(self.url)


def sensitive_path(name):
    parts = Path(name).parts
    return any(p in {".git", ".launcher", "node_modules", ".next", "dist", "data", ".fresh-data"} or
               p.startswith(".env") or p == "auth.json" or "credentials.json" in p or
               p.endswith((".pem", ".key")) for p in parts)


def validate_plugin(m, folder=None):
    if not isinstance(m, dict) or not isinstance(m.get("id"), str) or not PLUGIN_ID.fullmatch(m["id"]):
        raise RuntimeError("Invalid plugin manifest/id")
    if folder and folder != m["id"]:
        raise RuntimeError("Plugin id must match folder name")
    if m.get("apiVersion") != 1 or not m.get("name") or not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+].+)?", str(m.get("version", ""))):
        raise RuntimeError("Manifest needs name, semver version and apiVersion: 1")
    for key, name in (("main", "main.js"), ("backend", "backend.cjs"), ("styles", "styles.css")):
        if key in m and m[key] != name:
            raise RuntimeError(f"{key} must be {name}")
    if m.get("styles") and not m.get("main"):
        raise RuntimeError("styles requires main.js")


def serve(manager, token):
    """Detached supervisor. Authenticated control, no PID reuse/adoption guessing."""
    lock = open(manager.state / "server.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return 1
    command = ["npm", "run", "dev", "--", "--hostname", "127.0.0.1", "--port", str(manager.config["port"])]
    if manager.config["mode"] == "production":
        command = ["node", str(manager.repo / ".next/standalone/server.js")]
    child = subprocess.Popen(command, cwd=manager.repo, env=manager.env(), start_new_session=True)
    stopping = threading.Event()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass
        def do_GET(self):
            self.handle_control()
        def do_POST(self):
            self.handle_control()
        def handle_control(self):
            if not secrets.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                self.send_error(403)
                return
            if self.path == "/stop" and self.command == "POST":
                stopping.set()
            elif self.path != "/status" or self.command != "GET":
                self.send_error(404)
                return
            body = json.dumps({"running": child.poll() is None, "url": manager.url,
                "mode": manager.config["mode"], "pid": child.pid, "token_match": token}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.timeout = .3
    write_json(manager.state / "server.json", {"control_port": server.server_port, "token": token})
    def request_stop(*_):
        stopping.set()
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    try:
        while child.poll() is None and not stopping.is_set():
            server.handle_request()
    finally:
        stop_group(child)
        server.server_close()
        state = read_json(manager.state / "server.json", {})
        if state.get("token") == token:
            (manager.state / "server.json").unlink(missing_ok=True)
        lock.close()
    return 0


def setting_value(record, key, default):
    value = record
    for part in key.split("."):
        if not isinstance(value, dict) or part not in value:
            return default
        value = value[part]
    return value


def tui(manager):
    def screen(stdscr):
        curses.curs_set(0)
        curses.start_color()
        curses.use_default_colors()
        for i, color in enumerate([curses.COLOR_CYAN, curses.COLOR_GREEN, curses.COLOR_YELLOW, curses.COLOR_RED], 1):
            curses.init_pair(i, color, -1)
        stdscr.timeout(1000)
        notice = "Ready. Nothing is fetched, merged or published automatically."
        page = "home"
        cached, refreshed = None, 0
        def external(fn):
            nonlocal notice, refreshed
            curses.def_prog_mode(); curses.endwin()
            try:
                fn()
                notice = "Done."
            except (Exception, KeyboardInterrupt) as e:
                notice = str(e) or "Cancelled"
                print("\n" + notice)
            try:
                input("\nPress Enter to return to manager…")
            except (EOFError, KeyboardInterrupt):
                pass
            curses.reset_prog_mode(); stdscr.clear(); refreshed = 0
        def configure():
            print(json.dumps(manager.config, indent=2))
            key = input("Config key (blank cancels): ").strip()
            if key:
                manager.set_config(key, input("New value: ").strip())
                manager.__init__(manager.repo)
        def features():
            record = manager.settings()
            keys = list(FEATURES)
            for i, k in enumerate(keys, 1):
                print(f"{i:2}. {k:32} {json.dumps(setting_value(record, k, FEATURES[k]))}")
            choice = input("Setting number (blank cancels): ").strip()
            if choice:
                key = keys[int(choice) - 1]
                value = input("New JSON value (true / false / number / quoted string): ")
                manager.setting_set(key, json.loads(value))
        def plugins():
            items = manager.plugin_list()
            for p in items:
                print(f"{p['id']:24} {'enabled' if p['enabled'] else 'disabled'} {p['error']}")
            print("\nActions: enable ID | disable ID | create ID | install PATH")
            parts = shlex.split(input("Plugin action (blank cancels): "))
            if not parts:
                return
            action, value = parts
            if action == "create": manager.plugin_create(value)
            elif action == "install": manager.plugin_install(value)
            elif action == "disable": manager.plugin_enable(value, False)
            elif action == "enable":
                print("WARNING: plugins can access ALL files, credentials and provider credits. Not sandboxed.")
                if input("Type TRUST to enable: ") == "TRUST": manager.plugin_enable(value, True, True)
            else: raise RuntimeError("Unknown plugin action")
        def publish():
            manager.publish()
        while True:
            if time.monotonic() - refreshed > 5 or cached is None:
                try:
                    cached = manager.status()
                    refreshed = time.monotonic()
                except Exception as e:
                    notice = str(e)
            stdscr.erase()
            h, w = stdscr.getmaxyx()
            rows = []
            def line(text="", color=0): rows.append((text, color))
            def heading(title): line(); line(title + " " + "─" * max(0, min(w - len(title) - 3, 76)), 1)
            s = cached or {}
            line("╭─ LearnHarness · your development workbench " + "─" * max(0, min(w - 46, 35)) + "╮", 1)
            line(f"  {manager.repo}")
            if page == "logs":
                heading("Server log · H returns home")
                try:
                    logs = (manager.state / "server.log").read_text(errors="replace").splitlines()
                except FileNotFoundError:
                    logs = ["No server log yet."]
                for text in logs[-max(1, h - 9):]: line(re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", text))
            else:
                heading("App")
                line(f"Version    {s.get('version', '?')}  · branch {s.get('branch', '?')}")
                line(f"Mode       {manager.config['mode']}  · port {manager.config['port']}", 2)
                line(f"Build      {s.get('build', '?')}")
                node = s.get("node", "?")
                line(f"Node       {node}", 4 if node.startswith("PROBLEM") else 0)
                line(f"Your edits {len(s.get('changes', '').splitlines())} changed/untracked paths")
                heading("Your data & plugins")
                line(f"Sessions   {s.get('sessions', 0)} saved")
                line(f"Folder     {manager.data}")
                ps = s.get("plugins", [])
                line(f"Plugins    {len(ps)} installed · {sum(p['enabled'] for p in ps)} enabled · P manages")
                heading("GitHub")
                line("Updates    amosblomqvist/learnharness (upstream)")
                line(f"Publish    {s.get('remote', '?')}")
                line("U fetches only · G commits & pushes everything (secrets refused)", 3)
                heading("Server")
                state = s.get("server")
                line(f"Status     {'running at ' + state['url'] if state and state.get('running') else 'stopped'}", 2 if state else 3)
                heading("Desktop app")
                installed = manager.desktop_paths()["executable"].is_file()
                line(f"Installed  {'yes · LearnHarness in your app menu' if installed else 'no · press A to build and install'}", 2 if installed else 3)
                heading("Controls")
                line("O open app-dev  A install main app R restart dev    X stop dev")
                line("B rebuild       T tests           C verify all     I install deps")
                line("S app settings  P plugins         V launcher config K back up data")
                line("U fetch updates G publish GitHub  D data folder    F code folder")
                line("L live logs     Q quit (server stays on)           ? help / all commands")
            line(); line(notice, 3)
            if h < 30 or w < 72:
                rows = rows[:max(1, h - 2)] + [("Resize terminal to 72×32+ for full dashboard · Q quits · ? help", 3)]
            for y, (text, color) in enumerate(rows[:h - 1]):
                with contextlib.suppress(curses.error):
                    stdscr.addnstr(y, 0, text, max(1, w - 1), curses.color_pair(color))
            stdscr.refresh()
            key = stdscr.getch()
            if key < 0: continue
            if key in (ord("q"), ord("Q")): return
            char = chr(key).lower() if key < 256 else ""
            if char == "h": page = "home"; continue
            if char == "l": page = "logs"; continue
            actions = {
                "o": manager.open, "a": manager.desktop_install, "r": lambda: (manager.stop(), manager.start()), "x": manager.stop,
                "b": manager.build, "t": lambda: run(["npm", "test"], manager.repo, manager.env()),
                "c": manager.check, "i": lambda: run(["npm", "ci"], manager.repo, manager.env()),
                "s": features, "p": plugins, "v": configure, "k": manager.backup,
                "u": manager.fetch_updates,
                "g": publish, "d": lambda: open_folder(manager.data), "f": lambda: open_folder(manager.repo),
                "?": lambda: print(help_text()),
            }
            if char in actions: external(actions[char])
    curses.wrapper(screen)


def open_folder(folder):
    folder.mkdir(parents=True, exist_ok=True)
    subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(folder)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def help_text():
    return """LearnHarness manager (Python standard library; no pip packages).

./learn                         terminal dashboard
./learn install                 npm ci (first setup)
./learn start | stop | restart   manage persistent local server
./learn open [--browser]         open app-dev for feature testing (never uses main app data)
./learn desktop install         build your edits and install the main LearnHarness app (real chats)
./learn desktop open            launch the installed main app (real chats/settings)
./learn build                   Next build + provider smoke + curate standalone + smoke
./learn test | typecheck | lint  run an individual check
./learn check                   typecheck + app tests + lint + launcher tests
./learn status [--json]          version, git, build, data, server and plugins
./learn logs [--follow]          server output
./learn config list
./learn config set mode production    dev or production; stop first
./learn config set port 3005
./learn config set data_dir /absolute/path
./learn settings list
./learn settings set graph.enabled false
./learn settings set appearance.mode '\"light\"'
./learn plugins list
./learn plugins create my-plugin
./learn plugins install ./learnharness/examples/plugins/hello-plugin
./learn plugins enable hello-plugin --trust
./learn plugins disable hello-plugin
./learn backup                  stopped-server data backup; excludes known key files
./learn git status | fetch       fetch updates from amosblomqvist/learnharness
./learn git push                push already-committed work (confirmation required)
./learn git publish [-m MSG] [--check]
                                stage everything, commit, push (secrets refused)

--repo PATH selects another checkout. Servers survive closing the manager;
stop explicitly. Configuration/state/logs/backups live in learnharness/.launcher/.
Read manager/README.md and learnharness/docs/plugins.md for lifecycle/security.
"""


def main(argv=None):
    parser = argparse.ArgumentParser(description=help_text(), formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", type=Path, default=DEFAULT_REPO)
    sub = parser.add_subparsers(dest="command")
    for name in ("tui", "install", "start", "stop", "restart", "build", "test", "typecheck", "lint", "check", "backup"):
        sub.add_parser(name)
    p = sub.add_parser("open"); p.add_argument("--browser", action="store_true"); p.add_argument("--electron", action="store_true", help=argparse.SUPPRESS)
    p = sub.add_parser("desktop"); p.add_argument("action", choices=["install", "open"])
    p = sub.add_parser("status"); p.add_argument("--json", action="store_true")
    p = sub.add_parser("logs"); p.add_argument("--follow", action="store_true")
    p = sub.add_parser("config"); p.add_argument("action", choices=["list", "set"]); p.add_argument("key", nargs="?"); p.add_argument("value", nargs="?")
    p = sub.add_parser("settings"); p.add_argument("action", choices=["list", "set"]); p.add_argument("key", nargs="?"); p.add_argument("value", nargs="?")
    p = sub.add_parser("plugins"); p.add_argument("action", choices=["list", "create", "install", "enable", "disable"]); p.add_argument("value", nargs="?"); p.add_argument("--trust", action="store_true")
    p = sub.add_parser("git"); p.add_argument("action", choices=["status", "fetch", "publish", "push"]); p.add_argument("-m", "--message", default=""); p.add_argument("--check", action="store_true"); p.add_argument("--yes", action="store_true")
    p = sub.add_parser("_serve", help=argparse.SUPPRESS); p.add_argument("token")
    args = parser.parse_args(argv)
    manager = Manager(args.repo)
    command = args.command or "tui"
    if command == "_serve": return serve(manager, args.token)
    if command == "tui":
        if not sys.stdin.isatty():
            print(help_text()); return 0
        tui(manager)
    elif command == "install": run(["npm", "ci"], manager.repo, manager.env())
    elif command in ("start", "stop", "build", "check", "backup"): getattr(manager, command)()
    elif command == "restart": manager.stop(); manager.start()
    elif command == "open": manager.open("browser" if args.browser else "electron")
    elif command == "desktop": manager.desktop_install() if args.action == "install" else manager.desktop_open()
    elif command in ("test", "lint", "typecheck"): run(["npm", "run", command], manager.repo, manager.env())
    elif command == "status":
        status = manager.status()
        print(json.dumps(status, indent=2) if args.json else "\n".join(f"{k:10} {v}" for k, v in status.items()))
    elif command == "logs":
        log = manager.state / "server.log"
        if args.follow: run(["tail", "-n", "80", "-f", str(log)], manager.repo)
        else: print(log.read_text(errors="replace")[-20000:] if log.exists() else "No log yet.")
    elif command == "config":
        if args.action == "list": print(json.dumps(manager.config, indent=2))
        elif args.key and args.value is not None: manager.set_config(args.key, args.value)
        else: parser.error("config set needs key and value")
    elif command == "settings":
        if args.action == "list":
            record = manager.settings()
            for key, default in FEATURES.items(): print(f"{key:34} {json.dumps(setting_value(record, key, default))}")
        elif args.key and args.value is not None: manager.setting_set(args.key, json.loads(args.value))
        else: parser.error("settings set needs key and JSON value")
    elif command == "plugins":
        if args.action == "list": print(json.dumps(manager.plugin_list(), indent=2))
        elif not args.value: parser.error("plugin action requires id or path")
        elif args.action == "create": manager.plugin_create(args.value)
        elif args.action == "install": manager.plugin_install(args.value)
        else: manager.plugin_enable(args.value, args.action == "enable", args.trust)
    elif command == "git":
        if args.action == "status": run(["git", "status", "-sb"], manager.repo)
        elif args.action == "fetch": manager.fetch_updates()
        elif args.action == "publish": manager.publish(args.message, args.check)
        elif args.action == "push":
            branch = manager.git("symbolic-ref", "--quiet", "--short", "HEAD")
            remote = manager.config["remote"]
            print(f"Push committed HEAD ({branch}) to {manager.git('remote', 'get-url', '--push', remote)}")
            if args.yes or input("Type PUSH to continue: ") == "PUSH":
                run(["git", "push", "--set-upstream", remote, f"HEAD:refs/heads/{branch}"], manager.repo)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (Exception, KeyboardInterrupt) as error:
        print(f"\nManager: {error or 'cancelled'}", file=sys.stderr)
        sys.exit(1)
