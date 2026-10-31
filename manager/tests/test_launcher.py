import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("launcher", Path(__file__).resolve().parents[1] / "launcher.py")
launcher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(launcher)


def make_repo(root):
    repo = Path(root) / "repo"
    repo.mkdir()
    (repo / "package.json").write_text(json.dumps({"version": "1.2.3"}))
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "remote", "add", "origin", "https://github.com/me/app.git"], cwd=repo, check=True)
    example = repo / "examples/plugins/hello-plugin"
    example.mkdir(parents=True)
    (example / "manifest.json").write_text(json.dumps({"id": "hello-plugin", "name": "Hello", "version": "0.1.0", "apiVersion": 1, "main": "main.js"}))
    (example / "main.js").write_text("export function onload() {}")
    return repo


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = make_repo(self.tmp.name)
        self.m = launcher.Manager(self.repo)

    def tearDown(self):
        self.tmp.cleanup()

    def test_sensitive_paths(self):
        for p in ["auth.json", ".env.local", "data/settings.json", "x/chatgpt-credentials.json", "node_modules/a", "k.pem"]:
            self.assertTrue(launcher.sensitive_path(p), p)
        self.assertFalse(launcher.sensitive_path("src/server/plugins.ts"))

    def test_manifest_validation(self):
        good = {"id": "a-b", "name": "A", "version": "1.0.0", "apiVersion": 1}
        launcher.validate_plugin(good, "a-b")
        for bad in [good | {"id": "A"}, good | {"apiVersion": 2}, good | {"backend": "x.cjs"}, good | {"styles": "styles.css"}]:
            with self.assertRaises(RuntimeError):
                launcher.validate_plugin(bad)
        with self.assertRaises(RuntimeError):
            launcher.validate_plugin(good, "other")

    def test_plugins_scaffold_disabled_and_trust_required(self):
        self.m.plugin_create("my-plugin")
        [p] = self.m.plugin_list()
        self.assertFalse(p["enabled"])
        with self.assertRaises(RuntimeError):
            self.m.plugin_enable("my-plugin", True)
        self.m.plugin_enable("my-plugin", True, trust=True)
        self.assertTrue(self.m.plugin_list()[0]["enabled"])
        with self.assertRaises(RuntimeError):
            self.m.plugin_create("../evil")

    def test_install_copies_only_declared_entries(self):
        src = Path(self.tmp.name) / "src-plugin"
        (src / "data").mkdir(parents=True)
        (src / "manifest.json").write_text(json.dumps({"id": "src-plugin", "name": "S", "version": "1.0.0", "apiVersion": 1, "main": "main.js"}))
        (src / "main.js").write_text("")
        (src / "data/secret.json").write_text("{}")
        (src / ".env").write_text("KEY=1")
        self.m.plugin_install(src)
        target = self.m.plugins / "src-plugin"
        self.assertTrue((target / "main.js").exists())
        self.assertFalse((target / ".env").exists())
        self.assertFalse((target / "data/secret.json").exists())

    def test_settings_offline_validation(self):
        self.m.setting_set("graph.enabled", False)
        self.assertEqual(self.m.settings()["graph"]["enabled"], False)
        for key, value in [("graph.enabled", "no"), ("graph.extractionChunkTokens", 10), ("appearance.mode", "blue"), ("unknown", 1)]:
            with self.assertRaises(RuntimeError):
                self.m.setting_set(key, value)

    def test_backup_excludes_keys_and_plugin_code(self):
        (self.m.data / "chats").mkdir(parents=True)
        (self.m.data / "chats/a.json").write_text("{}")
        (self.m.data / "auth.json").write_text("{}")
        self.m.plugin_create("p")
        (self.m.plugins / "p/data/rec.json").write_text("{}")
        import tarfile
        names = tarfile.open(self.m.backup()).getnames()
        self.assertIn("chats/a.json", names)
        self.assertIn("plugins/p/data/rec.json", names)
        self.assertNotIn("auth.json", names)
        self.assertNotIn("plugins/p/main.js", names)

    def test_publish_commits_everything_and_pushes(self):
        bare = Path(self.tmp.name) / "remote.git"
        subprocess.run(["git", "init", "-q", "--bare", str(bare)], check=True)
        self.m.git("remote", "set-url", "origin", str(bare))
        self.m.git("config", "user.email", "t@t"); self.m.git("config", "user.name", "t")
        (self.repo / "a.txt").write_text("a")
        real = launcher.re.match
        # Let a local bare repo stand in for GitHub; nothing leaves the temp dir.
        with patch.object(launcher.re, "match", side_effect=lambda p, s, *a: True if "github" in p else real(p, s, *a)):
            self.m.publish()
            (self.repo / "a.txt").write_text("b")
            self.m.publish("second")
        self.assertIn("a.txt", subprocess.run(["git", "--git-dir", str(bare), "ls-tree", "-r", "--name-only", "HEAD"], capture_output=True, text=True).stdout)

    def test_publish_refuses_secrets(self):
        (self.repo / "auth.json").write_text("{}")
        with self.assertRaisesRegex(RuntimeError, "private"):
            self.m.publish()
        self.assertEqual(self.m.git("diff", "--cached", "--name-only"), "")

    def fake_payload(self, name="payload"):
        payload = Path(self.tmp.name) / name
        (payload / "resources/server/standalone").mkdir(parents=True)
        (payload / "learnharness").write_text("#!/bin/sh\n")
        (payload / "resources/app.asar").write_text("asar")
        (payload / "resources/server/standalone/server.js").write_text("")
        (self.repo / "build").mkdir(exist_ok=True)
        (self.repo / "build/icon.png").write_bytes(b"png")
        return payload

    def desktop_env(self):
        home = Path(self.tmp.name) / "home"
        return patch.dict(launcher.os.environ, {"XDG_DATA_HOME": str(home / "share"), "XDG_CONFIG_HOME": str(home / "config")})

    def test_desktop_install_marks_local_build_and_writes_shortcut(self):
        with self.desktop_env():
            self.m.install_desktop_payload(self.fake_payload())
            paths = self.m.desktop_paths()
            self.assertTrue(paths["executable"].is_file())
            self.assertTrue(paths["root"].joinpath("current").is_symlink())
            marker = launcher.read_json(paths["root"] / "current/resources/local-build.json")
            self.assertEqual(marker["localBuild"], True)
            entry = paths["shortcut"].read_text()
            self.assertIn("X-LearnHarness-Manager=true", entry)
            self.assertIn("Name=LearnHarness\n", entry)
            self.assertEqual(paths["profile"].name, "LearnHarness")
            self.assertFalse(paths["profile"].exists(), "install must never write into the real profile")
            self.assertTrue(os.access(paths["launcher"], os.X_OK))
            first = paths["root"].joinpath("current").resolve()
            # Reinstall switches atomically and keeps the previous release on disk.
            self.m.install_desktop_payload(self.fake_payload("payload2"))
            self.assertNotEqual(paths["root"].joinpath("current").resolve(), first)
            self.assertTrue(first.exists())

    def test_desktop_install_refuses_foreign_paths_and_incomplete_payloads(self):
        with self.desktop_env():
            paths = self.m.desktop_paths()
            broken = Path(self.tmp.name) / "broken"
            broken.mkdir()
            with self.assertRaisesRegex(RuntimeError, "Incomplete"):
                self.m.install_desktop_payload(broken)
            paths["root"].mkdir(parents=True)
            (paths["root"] / "user-file").write_text("keep")
            with self.assertRaisesRegex(RuntimeError, "not a manager-owned"):
                self.m.install_desktop_payload(self.fake_payload())
            self.assertEqual((paths["root"] / "user-file").read_text(), "keep")

    def test_desktop_install_refuses_foreign_shortcut(self):
        with self.desktop_env():
            paths = self.m.desktop_paths()
            paths["shortcut"].parent.mkdir(parents=True)
            paths["shortcut"].write_text("[Desktop Entry]\nName=Mine\n")
            with self.assertRaisesRegex(RuntimeError, "not manager-owned"):
                self.m.install_desktop_payload(self.fake_payload())
            self.assertIn("Mine", paths["shortcut"].read_text())

    def test_desktop_exec_quoting(self):
        self.assertEqual(launcher.desktop_exec("/a b/launch"), '"/a b/launch"')
        self.assertEqual(launcher.desktop_exec('/x$"%/launch'), '"/x\\\\$\\\\"%%/launch"')
        with self.assertRaises(RuntimeError):
            launcher.desktop_exec("/a\nb")

    def test_open_always_uses_dev_even_after_install(self):
        self.assertEqual(self.m.config["open"], "electron")
        with self.desktop_env():
            self.m.install_desktop_payload(self.fake_payload())
            with patch.object(self.m, "desktop_open") as desk, patch.object(self.m, "start") as start, patch.object(self.m, "wait_for_app") as ready, patch.object(launcher.subprocess, "Popen") as spawn:
                self.m.open()
                ready.assert_called_once()
                desk.assert_not_called()
                start.assert_called_once()
                env = spawn.call_args.kwargs["env"]
            self.assertEqual(env["LH_DEV_URL"], self.m.url)
            self.assertEqual(env["LH_DATA_DIR"], str(self.repo / "data"))
            # The real installed profile (~/.config/LearnHarness) must never be app-dev's data.
            profile = self.m.desktop_paths()["profile"]
            self.assertFalse(Path(env["LH_DATA_DIR"]).is_relative_to(profile))
            self.assertFalse(Path(env["LH_AUTH_FILE"]).is_relative_to(profile))

    def test_wait_for_app_refuses_dead_or_broken_server(self):
        with patch.object(self.m, "control", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "exited before"):
                self.m.wait_for_app(timeout=1)
        state = {"running": True, "url": self.m.url}
        err = launcher.urllib.error.HTTPError(self.m.url, 500, "x", {}, None)
        with patch.object(self.m, "control", return_value=state), patch.object(launcher.urllib.request, "urlopen", side_effect=err):
            with self.assertRaisesRegex(RuntimeError, "compilation failed"):
                self.m.wait_for_app(timeout=1)

    def test_wait_for_app_retries_until_ready(self):
        class Ok:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *a): return False
        calls = [ConnectionRefusedError("refused"), ConnectionRefusedError("refused"), Ok()]
        def opener(*a, **k):
            r = calls.pop(0)
            if isinstance(r, Exception): raise r
            return r
        with patch.object(self.m, "control", return_value={"running": True, "url": self.m.url}), \
             patch.object(launcher.urllib.request, "urlopen", side_effect=opener), patch.object(launcher.time, "sleep"):
            self.m.wait_for_app(timeout=30)
        self.assertEqual(calls, [])

    def test_install_removes_only_owned_legacy_shortcut(self):
        with self.desktop_env():
            old = self.m.desktop_paths()["shortcut"].with_name("learnharness-local.desktop")
            old.parent.mkdir(parents=True)
            old.write_text("[Desktop Entry]\nX-LearnHarness-Manager=true\n")
            self.m.install_desktop_payload(self.fake_payload())
            self.assertFalse(old.exists())
            old.write_text("[Desktop Entry]\nName=Other\n")
            self.m.remove_legacy_desktop_shortcut()
            self.assertTrue(old.exists())

    def test_config_validation(self):
        for key, value in [("port", "80"), ("mode", "fast"), ("remote", "nope"), ("bogus", "1")]:
            with self.assertRaises((RuntimeError, ValueError)):
                self.m.set_config(key, value)
        self.m.set_config("port", "3005")
        self.assertEqual(launcher.Manager(self.repo).config["port"], 3005)


if __name__ == "__main__":
    unittest.main()
