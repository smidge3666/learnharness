import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { PATHS } from "../../config.ts";
import { courseStore } from "../store/course-files.ts";
import { stores } from "./stores.ts";
import { projectView } from "../core/view.ts";
import { sessionSources, validateSideHistory, type WorkspacePort, type SessionSource } from "../core/session-workspace.ts";
import { pdfInfo, pdfExtract } from "../agent/subagents/pdf-ops.ts";
import { getHeadless } from "../agent/subagents/headless.ts";
import { resolveConversationSpec, resolveSlot } from "../core/settings-resolution.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { runSubagent } from "../agent/subagents/pi-run.ts";

const inProgress = new Map<string, Promise<void>>();
function record(chatId: string) { const chat = stores.chatStore.getChat(chatId); if (!chat) throw new Error("Session not found"); return chat; }
export function workspaceFor(chatId: string): WorkspacePort {
	return {
		list() { const chat = record(chatId); return { files: courseStore.list(chatId), sources: [...sessionSources(projectView(chat.messages)), ...courseStore.sources(chatId)] }; },
		async read(id, pages) {
			const meta = courseStore.get(chatId, id); if (!meta || meta.status !== "ready") throw new Error("Course file is not ready");
			return { text: (await pdfExtract(path.join(courseStore.dir(chatId, id), "document.pdf"), pages)).slice(0, 60000), pages: meta.pages! };
		},
		async show(id, page) {
			const meta = courseStore.get(chatId, id);
			if (!meta || meta.status !== "ready" || !Number.isInteger(page) || page < 1 || page > meta.pages!) throw new Error("Invalid course page");
			const dir = courseStore.dir(chatId, id), image = path.join(dir, `page-${page}.png`);
			if (!fs.existsSync(image)) {
				const rendered = await getHeadless().renderPdfPages(path.join(dir, "document.pdf"), [page], { dpi: 110 });
				if (!rendered[0]) throw new Error("Could not render page");
				fs.writeFileSync(image, rendered[0].png);
			}
			const source: SessionSource = { id: `${id}-p${page}`, kind: "page", title: `${meta.name} · ${meta.extension === "pptx" ? "slide" : "page"} ${page}`, citation: `${meta.name}, page ${page}`, url: `/api/chats/${chatId}/workspace/files/${id}/page/${page}` };
			courseStore.saveSource(chatId, source);
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
				await new Promise<void>((resolve, reject) => execFile("libreoffice", [`-env:UserInstallation=${pathToFileURL(profile).href}`, "--headless", "--convert-to", "pdf", "--outdir", dir, input], { timeout: 120000, maxBuffer: 1024 * 1024 }, err => err ? reject(new Error(`Office conversion failed. Install LibreOffice to use DOCX/PPTX. ${err.message}`)) : resolve()));
				fs.renameSync(path.join(dir, "original.pdf"), pdf);
			} finally { fs.rmSync(profile, { recursive: true, force: true }); }
		}
		const info = await pdfInfo(pdf);
		courseStore.update(chatId, { ...meta, status: "ready", pages: info.page_count });
	} catch (e) { courseStore.update(chatId, { ...meta, status: "error", error: String(e) }); }
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
export async function sideAnswer(chatId: string, input: unknown, signal: AbortSignal) {
	const history = validateSideHistory(input); if (!history.length || history.at(-1)?.role !== "user") throw new Error("A side question is required");
	const chat = record(chatId);
	const settings = stores.settingsStore.readSettings();
	const spec = resolveConversationSpec(chat.settings, resolveSlot(settings?.models?.strong));
	if (!spec) throw new Error("Configure a model for this session first");
	const context = projectView(chat.messages).map(m => `${m.role}: ${m.parts.filter(p => p.type === "text").map(p => p.text).join("\n")}`).join("\n\n").slice(-100000);
	const doctrine = fs.readFileSync(path.join(PATHS.root, "src/agent/prompts/side-questions.md"), "utf8");
	const result = await runSubagent([], { role: "teacher", engine: piEngineForSpec(spec, false), systemPrompt: doctrine,
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
		if (req.method === "POST" && segments[0] === "side") {
			const text = await req.text(); if (text.length > 200000) throw new Error("Side question too large");
			return Response.json({ text: await sideAnswer(chatId, JSON.parse(text).messages, req.signal) }, { headers });
		}
		if (req.method === "POST" && segments[0] === "files") {
			const max = 25 * 1024 * 1024;
			if (Number(req.headers.get("content-length") ?? 0) > max + 16384) throw new Error("Maximum file size is 25 MB");
			const data = await req.formData(), file = data.get("file");
			if (!(file instanceof File) || file.size > max || !file.size) throw new Error("Attach one non-empty file up to 25 MB");
			const extension = path.extname(file.name).slice(1).toLowerCase();
			if (!["pdf", "docx", "pptx"].includes(extension)) throw new Error("Supported files: PDF, DOCX and PPTX");
			const bytes = new Uint8Array(await file.arrayBuffer());
			if (extension === "pdf" ? Buffer.from(bytes.slice(0, 5)).toString() !== "%PDF-" : bytes[0] !== 80 || bytes[1] !== 75) throw new Error("File contents do not match its extension");
			const meta = courseStore.create(chatId, file.name, extension, bytes); schedule(chatId, meta.id);
			return Response.json({ file: meta }, { status: 202, headers });
		}
		if (req.method === "GET" && segments[0] === "files" && segments[2] === "page" && segments.length === 4) {
			await workspaceFor(chatId).show(segments[1]!, Number(segments[3]));
			const file = path.join(courseStore.dir(chatId, segments[1]!), `page-${Number(segments[3])}.png`);
			return new Response(new Uint8Array(fs.readFileSync(file)), { headers: { ...headers, "Content-Type": "image/png", "Content-Disposition": "inline" } });
		}
		throw new Error("Unknown workspace operation");
	} catch (e) { return Response.json({ error: String(e) }, { status: 400, headers }); }
}
