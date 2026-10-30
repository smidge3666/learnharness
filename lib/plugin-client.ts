/** Browser plugin lifecycle. Native URL imports keep extensions out of the app bundle. */
export interface BrowserPlugin { id: string; enabled: boolean; loaded: boolean; signature?: string; error?: string; manifest?: { name: string; version: string; main?: string; styles?: string } }
type Cleanup = () => unknown;
export async function pluginRequest(url: string, method = "GET", body?: unknown) {
	const res = await fetch(url, { method, headers: body === undefined ? {} : { "content-type": "application/json", "x-lh-plugin": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
	const value = await res.json(); if (!res.ok) throw new Error(value.error ?? `Plugin HTTP ${res.status}`); return value;
}
export class BrowserPluginHost {
	private loaded = new Map<string, { signature?: string; cleanups: Cleanup[] }>();
	private pending = Promise.resolve();
	constructor(private report: (id: string, error: unknown) => void = console.error) {}
	sync(plugins: BrowserPlugin[]) {
		this.pending = this.pending.then(() => this.reconcile(plugins)).catch(e => this.report("host", e));
		return this.pending;
	}
	private async unload(id: string) {
		const p = this.loaded.get(id); if (!p) return;
		this.loaded.delete(id);
		for (const cleanup of p.cleanups.reverse()) { try { await cleanup(); } catch (e) { this.report(id, e); } }
	}
	private async reconcile(plugins: BrowserPlugin[]) {
		for (const [id, p] of this.loaded) {
			const next = plugins.find(x => x.id === id);
			if (!next?.enabled || !next.loaded || next.error || next.signature !== p.signature) await this.unload(id);
		}
		for (const p of plugins) {
			if (!p.enabled || !p.loaded || p.error || !p.manifest?.main || this.loaded.has(p.id)) continue;
			const cleanups: Cleanup[] = []; this.loaded.set(p.id, { signature: p.signature, cleanups });
			const register = (cleanup: Cleanup) => { cleanups.push(cleanup); return cleanup; };
			const base = `/api/plugins/${encodeURIComponent(p.id)}/`;
			const rpc = async (method: string, input?: unknown) => (await pluginRequest(base + "rpc", "POST", { method, input })).result;
			try {
				if (p.manifest.styles) {
					const link = document.createElement("link"); link.rel = "stylesheet"; link.href = base + p.manifest.styles + "?v=" + encodeURIComponent(p.signature ?? "");
					document.head.append(link); register(() => link.remove());
				}
				const api = {
					apiVersion: 1, manifest: p.manifest, registerCleanup: register, rpc,
					assetUrl: (relative: string) => base + "assets/" + relative.split("/").map(encodeURIComponent).join("/"),
					core: { request: (route: string, init?: RequestInit) => { if (!route.startsWith("/api/") || route.startsWith("//")) throw new Error("Expected /api/ path"); return fetch(route, init); } },
					events: {
						on: (name: string, fn: (value: unknown) => void) => { const listener = (e: Event) => fn((e as CustomEvent).detail); window.addEventListener(name, listener); return register(() => window.removeEventListener(name, listener)); },
						emit: (name: string, value: unknown) => window.dispatchEvent(new CustomEvent(name, { detail: value })),
					},
					commands: { register: (command: { id: string; name: string; run: () => unknown }) => {
						const tray = document.getElementById("lh-plugin-commands"); if (!tray) throw new Error("Plugin command tray unavailable");
						const button = document.createElement("button"); button.textContent = command.name; button.dataset.command = p.id + ":" + command.id;
						button.onclick = () => { void Promise.resolve().then(command.run).catch(e => this.report(p.id, e)); };
						tray.append(button); return register(() => button.remove());
					} },
					panels: { register: (title: string, mount: (el: HTMLElement) => Cleanup | void) => {
						const section = document.createElement("details"); section.className = "lh-plugin-panel";
						const summary = document.createElement("summary"); summary.textContent = title;
						const el = document.createElement("div"); section.append(summary, el);
						document.getElementById("lh-plugin-panels")?.append(section); register(() => section.remove());
						const cleanup = mount(el); if (cleanup) register(cleanup); return el;
					} },
					tasks: { list: () => rpc("$tasks"), cancel: (id: string) => rpc("$cancel", id) },
				};
				const url = base + p.manifest.main + "?v=" + encodeURIComponent(p.signature ?? "");
				const mod = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url);
				if (typeof mod.onload !== "function") throw new Error("main.js must export onload(api)");
				if (typeof mod.onunload === "function") register(() => mod.onunload());
				const cleanup = await mod.onload(api); if (typeof cleanup === "function") register(cleanup);
			} catch (e) { this.report(p.id, e); await this.unload(p.id); }
		}
	}
	async dispose() { await this.sync([]); }
}
