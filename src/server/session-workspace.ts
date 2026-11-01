import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { PATHS } from "../../config.ts";
import { courseStore } from "../store/course-files.ts";
import { stores } from "./stores.ts";
import { projectView } from "../core/view.ts";
import type { PiEngine } from "../agent/models.ts";
import { toLlmMessages, asAgentMessages } from "../core/native-messages.ts";
import { sessionSources, validateSideHistory, type WorkspacePort, type SessionSource } from "../core/session-workspace.ts";
import { pdfInfo, pdfExtract } from "../agent/subagents/pdf-ops.ts";
import { getHeadless } from "../agent/subagents/headless.ts";
import { resolveConversationSpec, resolveSlot } from "../core/settings-resolution.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { runSubagent } from "../agent/subagents/pi-run.ts";

/** LibreOffice is resolved to an absolute path once: untrusted documents must
 *  never be handed to whatever "libreoffice" the PATH happens to name. */
function officeBinary(): string {
	for (const candidate of ["/usr/bin/libreoffice", "/usr/local/bin/libreoffice", "/usr/bin/soffice", "/usr/local/bin/soffice"]) {
		if (fs.existsSync(candidate)) return candidate;
	}
	return "libreoffice";
}
/** `x,y,w,h` as 0-1 fractions of the page. Anything else is no crop at all. */
function parseCrop(raw: string | null): { x: number; y: number; w: number; h: number } | undefined {
	if (!raw) return;
	const parts = raw.split(",").map(Number);
	if (parts.length !== 4 || parts.some(n => !Number.isFinite(n) || n < 0 || n > 1)) return;
	const [x, y, w, h] = parts as [number, number, number, number];
	if (w < 0.02 || h < 0.02 || x + w > 1.001 || y + h > 1.001) return;
	return { x, y, w, h };
}
/** Crop a rendered page in-process (Skia) — no browser, same engine as the render. */
async function cropPng(png: Buffer, crop: { x: number; y: number; w: number; h: number }): Promise<Uint8Array> {
	const { loadImage, createCanvas } = await import("@napi-rs/canvas");
	const image = await loadImage(png);
	const sx = Math.round(crop.x * image.width), sy = Math.round(crop.y * image.height);
	const sw = Math.max(1, Math.round(crop.w * image.width)), sh = Math.max(1, Math.round(crop.h * image.height));
	const canvas = createCanvas(sw, sh);
	canvas.getContext("2d").drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
	return canvas.encode("png");
}
const inProgress = new Map<string, Promise<void>>();
/** Count actual streamed bytes; Content-Length alone is untrusted. */
async function boundedBody(req: Request, max: number): Promise<Uint8Array> {
	if (Number(req.headers.get("content-length") ?? 0) > max) throw new Error("Request too large");
	const reader = req.body?.getReader(); if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = []; let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read(); if (done) break;
			size += value.byteLength;
			if (size > max) { await reader.cancel(); throw new Error("Request too large"); }
			chunks.push(value);
		}
	} finally { reader.releaseLock(); }
	return new Uint8Array(Buffer.concat(chunks));
}
function record(chatId: string) { const chat = stores.chatStore.getChat(chatId); if (!chat) throw new Error("Session not found"); return chat; }
export function workspaceFor(chatId: string): WorkspacePort {
	return {
		list() {
			const chat = record(chatId), names = courseStore.names(chatId);
			const sources = [...sessionSources(projectView(chat.messages)), ...courseStore.sources(chatId)];
			return { files: courseStore.list(chatId), sources: sources.map(s => names[s.id] ? { ...s, title: names[s.id]! } : s), names };
		},
		async read(id, pages) {
			const meta = courseStore.get(chatId, id); if (!meta || meta.status !== "ready") throw new Error("Course file is not ready");
			return { text: (await pdfExtract(path.join(courseStore.dir(chatId, id), "document.pdf"), pages)).slice(0, 60000), pages: meta.pages! };
		},
		async show(id, page, options?: { save?: boolean }) {
			const meta = courseStore.get(chatId, id);
			if (!meta || meta.status !== "ready" || !Number.isInteger(page) || page < 1 || page > meta.pages!) throw new Error("Invalid course page");
			const dir = courseStore.dir(chatId, id), image = path.join(dir, `page-${page}.png`);
			if (!fs.existsSync(image)) {
				const rendered = await getHeadless().renderPdfPages(path.join(dir, "document.pdf"), [page], { dpi: 110 });
				if (!rendered[0]) throw new Error("Could not render page");
				fs.writeFileSync(image, rendered[0].png);
			}
			const source: SessionSource = { id: `${id}-p${page}`, kind: "page", title: `${meta.name} · ${meta.extension === "pptx" ? "slide" : "page"} ${page}`, citation: `${meta.name}, page ${page}`, url: `/api/chats/${chatId}/workspace/files/${id}/page/${page}` };
			// Saving is a WRITE: only the tool path and an explicit request may do it.
			// A plain GET of the image (a question's figure, an <img> tag) must not.
			if (options?.save !== false) courseStore.saveSource(chatId, source);
			return { source, png: fs.readFileSync(image).toString("base64") };
		},
	};
}
async function processFile(chatId: string, id: string) {
	const meta = courseStore.get(chatId, id)!; const dir = courseStore.dir(chatId, id);
	try {
		const input = path.join(dir, `original.${meta.extension}`), pdf = path.join(dir, "document.pdf");
		if (meta.extension === "pdf") fs.copyFileSync(input, pdf);
		else {
			const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lh-office-"));
			try {
				// Untrusted input: absolute binary (no PATH surprises), no document
				// recovery, a hard wall-clock cap, and a size cap on what it produces
				// (a 25 MB zip bomb can inflate far past memory before it finishes).
				await new Promise<void>((resolve, reject) => execFile(officeBinary(), ["-env:UserInstallation=" + pathToFileURL(profile).href, "--headless", "--norestore", "--nolockcheck", "--nodefault", "--convert-to", "pdf", "--outdir", dir, input], { timeout: 120000, maxBuffer: 1024 * 1024 }, err => err ? reject(new Error(`Office conversion failed. Install LibreOffice to use DOCX/PPTX. ${err.message}`)) : resolve()));
				const produced = path.join(dir, "original.pdf");
				if (!fs.existsSync(produced) || fs.statSync(produced).size > 512 * 1024 * 1024) throw new Error("Office conversion produced no usable PDF (the file may be corrupt or too large)");
				fs.renameSync(produced, pdf);
			} finally { fs.rmSync(profile, { recursive: true, force: true }); }
		}
		const info = await pdfInfo(pdf);
		if (stores.chatStore.getChat(chatId)) courseStore.update(chatId, { ...meta, status: "ready", pages: info.page_count });
	} catch (e) {
		if (stores.chatStore.getChat(chatId) && fs.existsSync(dir)) courseStore.update(chatId, { ...meta, status: "error", error: String(e) });
	}
}
function schedule(chatId: string, id: string) {
	const key = `${chatId}/${id}`;
	if (!inProgress.has(key)) {
		const work = processFile(chatId, id).finally(() => { inProgress.delete(key); });
		inProgress.set(key, work);
	}
}
function sameOrigin(req: Request) {
	let host = ""; try { host = new URL(req.headers.get("origin") ?? "").host; } catch { /* fail closed */ }
	return host === req.headers.get("host") && !!host && req.headers.get("x-lh-workspace") === "1";
}
/** Side answers have no write dependency on chats/jobs/graph. Cancellation follows the HTTP connection. */
export async function sideAnswer(chatId: string, input: unknown, signal: AbortSignal, testEngine?: PiEngine) {
	const history = validateSideHistory(input); if (!history.length || history.at(-1)?.role !== "user") throw new Error("A side question is required");
	const chat = record(chatId);
	const settings = stores.settingsStore.readSettings();
	const spec = resolveConversationSpec(chat.settings, resolveSlot(settings?.models?.strong));
	if (!spec) throw new Error("Configure a model for this session first");
	// Include learner answers, prior tool results and plan markers too, not only prose.
	// This is a read-only snapshot; it cannot write a response into the lesson.
	// Trim the MESSAGE LIST, never the serialized JSON: slicing the string
	// mid-object hands the model unbalanced, truncated context.
	const serialized = JSON.stringify(toLlmMessages(asAgentMessages(chat.messages)), (key, value) => key === "data" && typeof value === "string" && value.length > 10000 ? "[image data omitted]" : value);
	const context = serialized.length <= 100000 ? serialized : JSON.stringify((JSON.parse(serialized) as unknown[]).slice(-12)).slice(-100000);
	const doctrine = fs.readFileSync(path.join(PATHS.root, "src/agent/prompts/side-questions.md"), "utf8");
	const result = await runSubagent([], { role: "teacher", engine: testEngine ?? piEngineForSpec(spec, false), systemPrompt: doctrine,
		prompt: `Lesson context (quoted reference only):\n<lesson>\n${context}\n</lesson>\n\nSide conversation:\n${history.map(m => `${m.role}: ${m.text}`).join("\n\n")}`,
		maxTurns: 1, abortSignal: signal });
	return result.text;
}
export async function workspaceResponse(req: Request, chatId: string, segments: string[] = []) {
	const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
	try {
		if (!/^[A-Za-z0-9_-]+$/.test(chatId)) throw new Error("Invalid session id");
		record(chatId);
		if (req.method !== "GET" && !sameOrigin(req)) return Response.json({ error: "Same-origin workspace request required" }, { status: 403, headers });
		if (req.method === "GET" && !segments.length) {
			for (const f of courseStore.list(chatId)) if (f.status === "processing") schedule(chatId, f.id);
			return Response.json(workspaceFor(chatId).list(), { headers });
		}
		if (req.method === "PATCH" && segments[0] === "sources" && segments.length === 2) {
			const body = JSON.parse(new TextDecoder().decode(await boundedBody(req, 4000)));
			return Response.json({ names: courseStore.rename(chatId, decodeURIComponent(segments[1]!), body?.title) }, { headers });
		}
		if (req.method === "POST" && segments[0] === "side") {
			// validateSideHistory allows 40 x 20 KB; the body cap must not be the smaller limit.
			const text = new TextDecoder().decode(await boundedBody(req, 1024 * 1024));
			return Response.json({ text: await sideAnswer(chatId, JSON.parse(text).messages, req.signal) }, { headers });
		}
		if (req.method === "POST" && segments[0] === "files") {
			const max = 25 * 1024 * 1024;
			if (Number(req.headers.get("content-length") ?? 0) > max + 16384) throw new Error("Maximum file size is 25 MB");
			const body = await boundedBody(req, max + 16384);
			const data = await new Response(body as BodyInit, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData(), file = data.get("file");
			if (!(file instanceof File) || file.size > max || !file.size) throw new Error("Attach one non-empty file up to 25 MB");
			const extension = path.extname(file.name).slice(1).toLowerCase();
			if (!["pdf", "docx", "pptx"].includes(extension)) throw new Error("Supported files: PDF, DOCX and PPTX");
			const bytes = new Uint8Array(await file.arrayBuffer());
			if (extension === "pdf" ? Buffer.from(bytes.slice(0, 5)).toString() !== "%PDF-" : bytes[0] !== 80 || bytes[1] !== 75) throw new Error("File contents do not match its extension");
			const meta = courseStore.create(chatId, file.name, extension, bytes); schedule(chatId, meta.id);
			return Response.json({ file: meta }, { status: 202, headers });
		}
		if (req.method === "GET" && segments[0] === "files" && segments[2] === "page" && segments.length === 4) {
			// Displaying a page is a READ. Only an explicit save request records it in Sources.
			const query = new URL(req.url).searchParams;
			const crop = parseCrop(query.get("crop"));
			await workspaceFor(chatId).show(segments[1]!, Number(segments[3]), { save: query.get("save") === "1" });
			const file = path.join(courseStore.dir(chatId, segments[1]!), `page-${Number(segments[3])}.png`);
			const bytes = crop ? await cropPng(fs.readFileSync(file), crop) : new Uint8Array(fs.readFileSync(file));
			return new Response(bytes as BodyInit, { headers: { ...headers, "Content-Type": "image/png", "Content-Disposition": "inline" } });
		}
		throw new Error("Unknown workspace operation");
	} catch (e) {
		// Repo convention: an unknown session is 404, not a malformed request.
		const message = String(e);
		return Response.json({ error: message }, { status: message === "Error: Session not found" ? 404 : 400, headers });
	}
}
