import type { LhViewMessage } from "./view.ts";

export interface CourseFile {
	id: string; name: string; extension: string; status: "processing" | "ready" | "error";
	pages?: number; error?: string; createdAt: string;
}
export interface SessionSource {
	id: string; kind: "demo" | "visual" | "mermaid" | "smiles" | "image" | "page";
	title: string; content?: string; url?: string; citation?: string; result?: unknown;
}
export interface WorkspacePort {
	/** `names`: learner renames by source id, already applied to `sources`. */
	list(): { files: CourseFile[]; sources: SessionSource[]; names?: Record<string, string> };
	read(fileId: string, pages: string): Promise<{ text: string; pages: number }>;
	/** The saved source plus the rendered page PNG (base64) for the model to inspect.
	 *  `save: false` displays without recording the page in Sources (a GET must not write). */
	show(fileId: string, page: number, options?: { save?: boolean }): Promise<{ source: SessionSource; png: string }>;
}
/** Short, stable content fingerprint (FNV-1a, base36). Not a security hash —
 *  it exists so a source's id survives edits elsewhere in the same message. */
function contentKey(value: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(36);
}

/** Derived from delivered lesson content, not side questions. Stable ids avoid duplicate saves. */
export function sessionSources(messages: readonly LhViewMessage[]): SessionSource[] {
	const sources = new Map<string, SessionSource>();
	for (const message of messages) {
		for (const [index, part] of message.parts.entries()) {
			const id = `${message.id}-${index}`;
			if (part.type === "data-subagent-artifact") {
				const data = part.data as { kind?: string; result?: { html?: string; svg?: string; title?: string } } | undefined;
				if (data?.kind === "demo" && data.result?.html) sources.set(id, { id, kind: "demo", title: data.result.title ?? "Demo", result: data.result });
				if (data?.kind === "visual" && data.result?.svg) sources.set(id, { id, kind: "visual", title: "Drawn diagram", result: data.result });
			}
			if ((part.type === "tool-show_source" || part.type === "tool-show_course_page") && part.state === "output-available") {
				const source = part.output as SessionSource;
				if (source?.id && source.kind) sources.set(source.id, source);
			}
			if (part.type !== "text" || !part.text || message.role !== "assistant") continue;
			let count = 0;
			// Ids hash the CONTENT, not the position: inserting an earlier diagram
			// must not re-bind a learner's rename to a different figure.
			for (const fence of part.text.matchAll(/```(mermaid|smiles)\s*\n([\s\S]*?)```/g)) {
				const body = fence[2]!.trim();
				const key = `${id}-f${count++}-${contentKey(body)}`;
				sources.set(key, { id: key, kind: fence[1] as "mermaid" | "smiles", title: fence[1] === "smiles" ? "Chemical structure" : "Diagram", content: body });
			}
			for (const image of part.text.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+|\/api\/chats\/[^\s)]+)\)/g)) {
				const key = `${id}-i${count++}-${contentKey(image[2]!)}`;
				sources.set(key, { id: key, kind: "image", title: image[1] || "Image", url: image[2] });
			}
		}
	}
	return [...sources.values()];
}
export interface SideMessage { role: "user" | "assistant"; text: string }
export function validateSideHistory(value: unknown): SideMessage[] {
	if (!Array.isArray(value) || value.length > 40) throw new Error("Side chat supports up to 40 messages; clear it to start again.");
	return value.map(m => {
		if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.text !== "string" || !m.text.trim() || m.text.length > 20000) throw new Error("Invalid side chat message");
		return { role: m.role, text: m.text };
	});
}
