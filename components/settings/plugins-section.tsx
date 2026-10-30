"use client";
import { useEffect, useState } from "react";
import { pluginRequest, type BrowserPlugin } from "@/lib/plugin-client";
export function PluginsSection() {
	const [plugins, setPlugins] = useState<BrowserPlugin[]>([]);
	const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
	const refresh = () => pluginRequest("/api/plugins").then(b => setPlugins(b.plugins)).catch(e => setError(String(e)));
	useEffect(() => { void refresh(); }, []);
	async function toggle(p: BrowserPlugin) {
		if (!p.enabled && !window.confirm(`Trust ${p.manifest?.name ?? p.id}? Plugins have full access to your data, credentials, browser and Node.js. Only enable code you trust.`)) return;
		setBusy(true); setError("");
		try {
			const b = await pluginRequest(`/api/plugins/${p.id}`, "PUT", { enabled: !p.enabled, trust: true }); setPlugins(b.plugins);
			window.dispatchEvent(new Event("lh:plugins-changed"));
		} catch (e) { setError(String(e)); } finally { setBusy(false); }
	}
	return <div className="space-y-4 text-sm">
		<p>Trusted local extensions · API v1. Install folders under <code>LH_DATA_DIR/plugins/</code>. New plugins are disabled by default.</p>
		<p className="text-muted-foreground">Plugins are not sandboxed. They can read your files, use credentials and spend provider credits. Disabling cancels managed work; arbitrary plugin code cannot be forcibly stopped.</p>
		<button onClick={() => void refresh()}>Refresh plugins</button>
		{error && <p role="alert">{error}</p>}
		{!plugins.length && <p>No plugins installed. Use the terminal manager to scaffold or install one.</p>}
		{plugins.map(p => <div key={p.id} className="border-t border-border py-3">
			<div className="flex justify-between gap-4"><span>{p.manifest?.name ?? p.id} <small>{p.manifest?.version}</small></span><button disabled={busy || (!p.manifest && !p.enabled)} onClick={() => void toggle(p)}>{p.enabled ? "Disable" : "Trust & enable"}</button></div>
			<small>{p.id} · {p.error ? "Error: " + p.error : p.loaded ? "Loaded" : "Disabled"}</small>
		</div>)}
	</div>;
}
