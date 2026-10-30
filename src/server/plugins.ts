import path from "node:path";
import { PATHS, type ModelRole } from "../../config.ts";
import { PluginHost } from "./plugin-runtime.ts";
import { stores, effectiveSettings } from "./stores.ts";
import { graphView } from "./graph.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { runSubagent } from "../agent/subagents/pi-run.ts";

// One local server process per data directory, like the existing credential stores.
const globalHost = globalThis as typeof globalThis & { lhPluginHost?: PluginHost };
export function pluginHost() {
	return globalHost.lhPluginHost ??= new PluginHost(path.join(PATHS.data, "plugins"), {
		core: { stores, effectiveSettings, graphView },
		runAgent: async (options, signal) => {
			const role: ModelRole = options.role ?? "researcher";
			if (!["researcher", "demoBuilder", "visualMaker", "pdfReader", "extractor", "auditor", "teacher", "prober"].includes(role)) throw new Error("Unknown agent role");
			const spec = resolveRoleSpec(role, stores.settingsStore.readSettings());
			if (!spec) throw new Error(`No model configured for ${role}; configure model slots in Settings`);
			if (typeof options.prompt !== "string" || typeof options.systemPrompt !== "string") throw new Error("Agent needs prompt and systemPrompt");
			const maxTurns = options.maxTurns ?? 8;
			if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100) throw new Error("maxTurns must be 1–100");
			signal.throwIfAborted();
			return runSubagent(options.tools ?? [], {
				role, engine: piEngineForSpec(spec), prompt: options.prompt,
				systemPrompt: options.systemPrompt, maxTurns, abortSignal: signal,
				onUsage: options.onUsage, onToolStart: options.onToolStart,
			});
		},
	});
}
const MIME: Record<string, string> = {
	".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
	".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp",
	".woff2": "font/woff2", ".wasm": "application/wasm", ".txt": "text/plain",
};
/** One transport for management, RPC and the narrow public asset allowlist. */
export async function pluginResponse(req: Request, segments: string[] = []) {
	const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
	try {
		const host = pluginHost();
		if (req.method === "GET") {
			if (!segments.length) return Response.json({ apiVersion: 1, plugins: await host.sync() }, { headers });
			const [id, ...parts] = segments;
			const asset = await host.asset(id!, parts.join("/"));
			return new Response(new Uint8Array(asset.bytes), { headers: { ...headers, "Content-Type": MIME[path.extname(asset.file)] ?? "application/octet-stream" } });
		}
		// Reject cross-origin / form requests before running code or changing trust.
		// Compare against Host: standalone Next rebuilds req.url from its bind address.
		let originHost = "";
		try { originHost = new URL(req.headers.get("origin") ?? "").host; } catch { /* missing/invalid origin fails closed */ }
		if (!originHost || originHost !== req.headers.get("host") || req.headers.get("x-lh-plugin") !== "1"
			|| !req.headers.get("content-type")?.startsWith("application/json")) return Response.json({ error: "Same-origin plugin request required" }, { status: 403, headers });
		if (Number(req.headers.get("content-length") ?? 0) > 1024 * 1024) throw new Error("Request too large");
		const text = await req.text(); if (text.length > 1024 * 1024) throw new Error("Request too large");
		const body = JSON.parse(text);
		if (req.method === "PUT" && segments.length === 1) {
			if (typeof body.enabled !== "boolean" || (body.enabled && body.trust !== true)) throw new Error("Enabling requires explicit trust: true");
			return Response.json({ plugins: await host.setEnabled(segments[0]!, body.enabled) }, { headers });
		}
		if (req.method === "POST" && segments.length === 2 && segments[1] === "rpc") {
			if (typeof body.method !== "string") throw new Error("method required");
			return Response.json({ result: (await host.call(segments[0]!, body.method, body.input)) ?? null }, { headers });
		}
		return Response.json({ error: "Unsupported plugin operation" }, { status: 405, headers });
	} catch (e) { return Response.json({ error: String(e) }, { status: 400, headers }); }
}
