/** Trusted local extensions. This is a lifecycle/resource boundary, NOT a sandbox. */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export const PLUGIN_API_VERSION = 1;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export interface PluginManifest {
	id: string; name: string; version: string; apiVersion: number;
	description?: string; main?: string; backend?: string; styles?: string;
}
export function validateManifest(raw: unknown, folder: string): PluginManifest {
	const m = raw as PluginManifest;
	if (!m || !ID.test(m.id) || m.id !== folder || typeof m.name !== "string" || !m.name.trim()
		|| typeof m.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(m.version)
		|| m.apiVersion !== PLUGIN_API_VERSION) throw new Error("Invalid manifest or unsupported API version (expected 1)");
	for (const [key, expected] of [["main", "main.js"], ["backend", "backend.cjs"], ["styles", "styles.css"]] as const) {
		if (m[key] !== undefined && m[key] !== expected) throw new Error(`${key} must be ${expected}`);
	}
	if (m.styles && !m.main) throw new Error("styles requires main.js");
	return m;
}
/** Realpath containment: also rejects symlinks escaping the selected root. */
export function containedFile(root: string, relative: string): string {
	if (!relative || relative.includes("\\") || relative.split("/").some(p => !p || p === "." || p === "..") || path.isAbsolute(relative)) throw new Error("Invalid relative path");
	const base = fs.realpathSync(root);
	const target = fs.realpathSync(path.join(base, relative));
	if (!target.startsWith(base + path.sep) || !fs.statSync(target).isFile()) throw new Error("Path outside plugin or not a file");
	return target;
}
function atomicJSON(file: string, value: unknown) {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${randomUUID()}.tmp`;
	try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); }
	finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
interface Task { id: string; label: string; status: string; error?: string; result?: unknown; controller: AbortController }
interface Loaded {
	manifest: PluginManifest; signature: string; cleanups: Array<() => unknown>;
	handlers: Map<string, (input: unknown) => unknown>; tasks: Map<string, Task>;
}
export interface PluginServices {
	core: unknown;
	runAgent: (options: any, signal: AbortSignal) => Promise<unknown>;
}
export class PluginHost {
	private loaded = new Map<string, Loaded>();
	private errors = new Map<string, string>();
	private events = new EventEmitter();
	private queue: Promise<unknown> = Promise.resolve();
	constructor(readonly root: string, private services: PluginServices) { this.events.setMaxListeners(100); }
	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.queue.then(fn, fn); this.queue = next.catch(() => {}); return next;
	}
	private state(): { version: number; enabled: Record<string, boolean> } {
		try {
			const value = JSON.parse(fs.readFileSync(path.join(this.root, "enabled.json"), "utf8"));
			if (value.version !== 1 || !value.enabled || typeof value.enabled !== "object" || Array.isArray(value.enabled)) throw new Error("Invalid plugin state");
			return value;
		} catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, enabled: {} }; throw e; }
	}
	private discover() {
		if (!fs.existsSync(this.root)) return [];
		return fs.readdirSync(this.root, { withFileTypes: true }).filter(d => d.isDirectory() && ID.test(d.name)).map(d => {
			try {
				const dir = path.join(this.root, d.name);
				const file = containedFile(dir, "manifest.json");
				const manifest = validateManifest(JSON.parse(fs.readFileSync(file, "utf8")), d.name);
				const signature = ["manifest.json", manifest.main, manifest.backend, manifest.styles].filter(Boolean).map(f => {
					const s = fs.statSync(containedFile(dir, f!)); return `${s.mtimeMs}:${s.size}`;
				}).join("|");
				return { id: d.name, manifest, signature };
			} catch (e) { return { id: d.name, error: String(e) }; }
		});
	}
	async sync() { return this.exclusive(() => this.reconcile()); }
	private async reconcile() {
		const state = this.state(); const found = this.discover();
		for (const [id, p] of this.loaded) {
			const item = found.find(f => f.id === id);
			if (state.enabled[id] !== true || !item?.manifest || item.signature !== p.signature) await this.unload(id);
		}
		for (const item of found) {
			if (item.error) { this.errors.set(item.id, item.error); continue; }
			if (state.enabled[item.id] !== true || this.loaded.has(item.id)) continue;
			try { await this.load(item.manifest!, item.signature!); this.errors.delete(item.id); }
			catch (e) { this.errors.set(item.id, String(e)); await this.unload(item.id); }
		}
		return found.map(item => ({ ...item, enabled: state.enabled[item.id] === true, loaded: this.loaded.has(item.id), error: item.error ?? this.errors.get(item.id) }));
	}
	async setEnabled(id: string, enabled: boolean) {
		return this.exclusive(async () => {
			const item = this.discover().find(p => p.id === id);
			if (!item || (enabled && !item.manifest)) throw new Error(item?.error ?? "Plugin not found");
			const state = this.state(); state.enabled[id] = enabled;
			atomicJSON(path.join(this.root, "enabled.json"), state);
			return this.reconcile();
		});
	}
	private async load(manifest: PluginManifest, signature: string) {
		const id = manifest.id, dir = path.join(this.root, id), dataDir = path.join(dir, "data");
		fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
		const p: Loaded = { manifest, signature, cleanups: [], handlers: new Map(), tasks: new Map() };
		this.loaded.set(id, p);
		const register = (fn: () => unknown) => { p.cleanups.push(fn); return fn; };
		const storageFile = (key: string) => {
			if (!/^[a-zA-Z0-9_-]{1,100}$/.test(key)) throw new Error("Invalid storage key");
			return path.join(dataDir, key + ".json");
		};
		const background = (label: string, work: (signal: AbortSignal) => Promise<unknown>) => {
			if (this.loaded.get(id) !== p) throw new Error("Plugin unloaded");
			const task: Task = { id: randomUUID(), label, status: "running", controller: new AbortController() };
			p.tasks.set(task.id, task);
			// Keep bounded history without discarding running work.
			for (const [key, old] of p.tasks) if (p.tasks.size > 100 && old.status !== "running") p.tasks.delete(key);
			void Promise.resolve().then(() => { task.controller.signal.throwIfAborted(); return work(task.controller.signal); }).then(result => {
				task.result = result; task.status = task.controller.signal.aborted ? "cancelled" : "completed";
			}, e => { task.status = task.controller.signal.aborted ? "cancelled" : "failed"; task.error = String(e); });
			return task.id;
		};
		const api = {
			apiVersion: PLUGIN_API_VERSION, manifest, dataDir, pluginDir: dir, core: this.services.core,
			log: (...args: unknown[]) => console.log(`[plugin:${id}]`, ...args),
			registerCleanup: register,
			storage: {
				read: (key: string) => { const f = storageFile(key); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; },
				write: (key: string, value: unknown) => atomicJSON(storageFile(key), value),
			},
			events: {
				on: (name: string, fn: (...args: any[]) => void) => { this.events.on(name, fn); return register(() => this.events.off(name, fn)); },
				emit: (name: string, value: unknown) => this.events.emit(name, value),
			},
			handle: (name: string, fn: (input: unknown) => unknown) => {
				if (!ID.test(name) || p.handlers.has(name)) throw new Error("Invalid/duplicate handler");
				p.handlers.set(name, fn); return register(() => p.handlers.delete(name));
			},
			background,
			agents: { run: (options: any) => background("Agent: " + (options.role ?? "researcher"), signal => this.services.runAgent(options, signal)) },
			tasks: { list: () => this.tasks(id), cancel: (taskId: string) => this.cancel(id, taskId) },
		};
		if (manifest.backend) {
			// Native Node loading deliberately bypasses the application bundler.
			const require = createRequire(path.join(dir, "manifest.json"));
			const file = containedFile(dir, manifest.backend);
			delete require.cache[file];
			const mod = require(file);
			if (typeof mod.onload !== "function") throw new Error("backend.cjs must export onload(api)");
			if (typeof mod.onunload === "function") register(() => mod.onunload());
			const cleanup = await mod.onload(api);
			if (typeof cleanup === "function") register(cleanup);
		}
	}
	private async unload(id: string) {
		const p = this.loaded.get(id); if (!p) return;
		this.loaded.delete(id);
		for (const task of p.tasks.values()) task.controller.abort();
		for (const cleanup of p.cleanups.reverse()) { try { await cleanup(); } catch (e) { this.errors.set(id, String(e)); } }
	}
	async dispose() { return this.exclusive(async () => { for (const id of this.loaded.keys()) await this.unload(id); }); }
	async call(id: string, method: string, input: unknown) {
		await this.sync(); const p = this.loaded.get(id);
		if (!p) throw new Error("Plugin is disabled or failed to load");
		if (method === "$tasks") return this.tasks(id);
		if (method === "$cancel") { this.cancel(id, String(input)); return null; }
		const handler = p.handlers.get(method); if (!handler) throw new Error("Unknown plugin method");
		return handler(input);
	}
	tasks(id: string) { return [...(this.loaded.get(id)?.tasks.values() ?? [])].map(({ controller: _controller, ...task }) => task); }
	cancel(id: string, taskId: string) { this.loaded.get(id)?.tasks.get(taskId)?.controller.abort(); }
	async asset(id: string, relative: string) {
		await this.sync(); const p = this.loaded.get(id);
		if (!p) throw new Error("Plugin not enabled");
		if (relative !== p.manifest.main && relative !== p.manifest.styles && !relative.startsWith("assets/")) throw new Error("Not a public plugin asset");
		// Never expose server code, even when an assets symlink targets it.
		const dir = path.join(this.root, id), file = containedFile(dir, relative);
		if (relative.startsWith("assets/")) {
			const assets = fs.realpathSync(path.join(dir, "assets"));
			if (!file.startsWith(assets + path.sep) || assets !== path.join(fs.realpathSync(dir), "assets")) throw new Error("Asset symlink outside public directory");
		}
		if (/\.(?:cjs|map)$/i.test(file)) throw new Error("Private file type");
		return { bytes: fs.readFileSync(file), file };
	}
}
