import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PATHS } from "../../config.ts";
import type { CourseFile, SessionSource } from "../core/session-workspace.ts";

export function createCourseStore(root = path.join(PATHS.data, "course-files")) {	const dir = (chatId: string) => {
		if (!/^[A-Za-z0-9_-]+$/.test(chatId)) throw new Error("Invalid session id");
		return path.join(root, chatId);
	};
	const fileDir = (chatId: string, id: string) => {
		if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid file id");
		return path.join(dir(chatId), id);
	};
	const read = (file: string, fallback: any) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw e; } };
	const write = (file: string, value: unknown) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const temp = `${file}.${randomUUID()}.tmp`;
		try { fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temp, file); }
		finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
	};
	return {
		remove(chatId: string) { fs.rmSync(dir(chatId), { recursive: true, force: true }); },
		list(chatId: string): CourseFile[] {
			const base = dir(chatId); if (!fs.existsSync(base)) return [];
			return fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory() && /^[a-f0-9-]{36}$/.test(d.name)).map(d => read(path.join(base, d.name, "meta.json"), null)).filter(Boolean);
		},
		get(chatId: string, id: string): CourseFile | null { return read(path.join(fileDir(chatId, id), "meta.json"), null); },
		create(chatId: string, name: string, extension: string, bytes: Uint8Array): CourseFile {
			if (!["pdf", "docx", "pptx"].includes(extension)) throw new Error("Invalid course file extension");
			const id = randomUUID(); const base = fileDir(chatId, id);
			fs.mkdirSync(base, { recursive: true });
			fs.writeFileSync(path.join(base, "original." + extension), bytes, { mode: 0o600 });
			const meta: CourseFile = { id, name: path.basename(name).slice(0, 200), extension, status: "processing", createdAt: new Date().toISOString() };
			write(path.join(base, "meta.json"), meta); return meta;
		},
		update(chatId: string, file: CourseFile) { write(path.join(fileDir(chatId, file.id), "meta.json"), file); },
		dir: fileDir,
		sources(chatId: string): SessionSource[] { return read(path.join(dir(chatId), "sources.json"), []); },
		/** Learner-chosen titles; keyed by source id so derived (unsaved) sources can be renamed too. */		names(chatId: string): Record<string, string> { return read(path.join(dir(chatId), "source-names.json"), {}); },
		rename(chatId: string, id: string, title: string) {
			if (typeof id !== "string" || !id || id.length > 200) throw new Error("Invalid source");
			const name = typeof title === "string" ? title.trim() : "";
			if (name.length > 120) throw new Error("Source names are limited to 120 characters");
			const f = path.join(dir(chatId), "source-names.json"); const names: Record<string, string> = read(f, {});
			if (name) names[id] = name; else delete names[id]; // empty restores the original title
			write(f, names); return names;
		},
		saveSource(chatId: string, source: SessionSource) {
			const f = path.join(dir(chatId), "sources.json"); const sources: SessionSource[] = read(f, []);
			write(f, [...sources.filter(s => s.id !== source.id), source]);
		},
	};
}
export const courseStore = createCourseStore();
