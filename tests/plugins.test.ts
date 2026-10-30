import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PluginHost, containedFile, validateManifest } from "../src/server/plugin-runtime.ts";

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-plugins-"));
	const dir = path.join(root, "demo");
	fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
	fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ id: "demo", name: "Demo", version: "1.0.0", apiVersion: 1, main: "main.js", backend: "backend.cjs" }));
	fs.writeFileSync(path.join(dir, "main.js"), "export function onload() {}");
	fs.writeFileSync(path.join(dir, "assets", "icon.txt"), "public");
	fs.writeFileSync(path.join(dir, "backend.cjs"), `
		exports.onload = (api) => {
			api.handle("echo", (x) => ({ x, stored: api.storage.read("k") }));
			api.handle("save", (x) => { api.storage.write("k", x); return true; });
			api.handle("wait", () => api.background("wait", (signal) => new Promise((_, reject) =>
				signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }))));
			api.registerCleanup(() => { globalThis.__lhCleanups = (globalThis.__lhCleanups ?? 0) + 1; });
		};`);
	const host = new PluginHost(root, { core: {}, runAgent: async () => "agent" });
	return { root, dir, host };
}

test("manifest validation rejects mismatched ids, bad versions and stray entries", () => {
	assert.throws(() => validateManifest({ id: "a", name: "A", version: "1.0.0", apiVersion: 1 }, "b"));
	assert.throws(() => validateManifest({ id: "a", name: "A", version: "1.0.0", apiVersion: 2 }, "a"));
	assert.throws(() => validateManifest({ id: "a", name: "A", version: "1.0.0", apiVersion: 1, backend: "../x.cjs" }, "a"));
	assert.throws(() => validateManifest({ id: "a", name: "A", version: "1.0.0", apiVersion: 1, styles: "styles.css" }, "a"));
	assert.equal(validateManifest({ id: "a", name: "A", version: "1.0.0", apiVersion: 1 }, "a").id, "a");
});

test("plugins are disabled by default and load only after enabling", async () => {
	const { host, root } = fixture();
	const [first] = await host.sync();
	assert.equal(first?.enabled, false);
	await assert.rejects(host.call("demo", "echo", 1), /disabled/);
	await host.setEnabled("demo", true);
	assert.deepEqual(await host.call("demo", "save", { a: 1 }), true);
	assert.deepEqual(await host.call("demo", "echo", 2), { x: 2, stored: { a: 1 } });
	assert.ok(fs.existsSync(path.join(root, "demo", "data", "k.json")));
	await host.dispose();
});

test("disabling runs cleanups and cancels background tasks", async () => {
	const { host } = fixture();
	(globalThis as any).__lhCleanups = 0;
	await host.setEnabled("demo", true);
	const taskId = await host.call("demo", "wait", null);
	assert.equal(typeof taskId, "string");
	const plugin = (host as any).loaded.get("demo");
	const task = plugin.tasks.get(taskId);
	await host.setEnabled("demo", false);
	assert.equal(task.controller.signal.aborted, true);
	assert.equal((globalThis as any).__lhCleanups, 1);
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(task.status, "cancelled");
});

test("only declared frontend files and assets are public", async () => {
	const { host, dir, root } = fixture();
	await host.setEnabled("demo", true);
	assert.equal((await host.asset("demo", "assets/icon.txt")).bytes.toString(), "public");
	assert.ok(await host.asset("demo", "main.js"));
	await assert.rejects(host.asset("demo", "backend.cjs"), /public/);
	await assert.rejects(host.asset("demo", "manifest.json"), /public/);
	await assert.rejects(host.asset("demo", "data/k.json"), /public/);
	await assert.rejects(host.asset("demo", "assets/../backend.cjs"), /Invalid/);
	fs.writeFileSync(path.join(root, "secret.txt"), "nope");
	fs.symlinkSync(path.join(root, "secret.txt"), path.join(dir, "assets", "leak.txt"));
	await assert.rejects(host.asset("demo", "assets/leak.txt"), /outside/);
	fs.symlinkSync(path.join(dir, "backend.cjs"), path.join(dir, "assets", "b.cjs"));
	await assert.rejects(host.asset("demo", "assets/b.cjs"), /outside|Private/);
	await host.dispose();
});

test("containedFile rejects traversal", () => {
	const { dir } = fixture();
	assert.throws(() => containedFile(dir, "../x"));
	assert.throws(() => containedFile(dir, "/etc/passwd"));
	assert.throws(() => containedFile(dir, "a\\b"));
});

test("broken plugins report errors without affecting others", async () => {
	const { host, root } = fixture();
	fs.mkdirSync(path.join(root, "broken"));
	fs.writeFileSync(path.join(root, "broken", "manifest.json"), "{nope");
	const list = await host.sync();
	assert.match(list.find((p) => p.id === "broken")!.error!, /JSON|Unexpected|Expected/);
	await assert.rejects(host.setEnabled("broken", true));
	await host.setEnabled("demo", true);
	assert.ok(await host.call("demo", "echo", 1));
	await host.dispose();
});

test("editing a backend reloads it on next sync", async () => {
	const { host, dir } = fixture();
	await host.setEnabled("demo", true);
	fs.writeFileSync(path.join(dir, "backend.cjs"), `exports.onload = (api) => { api.handle("echo", () => "v2"); };`);
	const later = new Date(Date.now() + 5000);
	fs.utimesSync(path.join(dir, "backend.cjs"), later, later);
	assert.equal(await host.call("demo", "echo", null), "v2");
	await host.dispose();
});
