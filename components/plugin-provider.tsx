"use client";
import { useEffect, useState } from "react";
import { BrowserPluginHost, pluginRequest } from "@/lib/plugin-client";

export default function PluginProvider() {
	const [error, setError] = useState("");
	useEffect(() => {
		let closed = false, busy = false;
		const host = new BrowserPluginHost((id, e) => { console.error(`[plugin:${id}]`, e); if (!closed) setError(`${id}: ${String(e)}`); });
		const refresh = async () => {
			if (closed || busy) return; busy = true;
			try { const { plugins } = await pluginRequest("/api/plugins"); if (!closed) await host.sync(plugins); }
			catch (e) { if (!closed) setError(String(e)); } finally { busy = false; }
		};
		void refresh();
		// Also detects edits/enables made by the external terminal manager.
		const timer = setInterval(() => void refresh(), 5000);
		window.addEventListener("lh:plugins-changed", refresh);
		return () => { closed = true; clearInterval(timer); window.removeEventListener("lh:plugins-changed", refresh); void host.dispose(); };
	}, []);
	return <aside aria-label="Plugin workspace" className="fixed bottom-3 right-3 z-40 max-h-[65vh] max-w-sm overflow-auto rounded border border-border bg-card text-xs empty:hidden">
		{error && <p role="alert" className="p-2">Plugin: {error} <button onClick={() => setError("")}>Dismiss</button></p>}
		<div id="lh-plugin-commands" className="flex flex-wrap gap-2 p-1 empty:hidden" />
		<div id="lh-plugin-panels" />
	</aside>;
}
