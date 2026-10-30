"use client";
import { useEffect, useRef, useState } from "react";
import { XIcon, PaperclipIcon } from "lucide-react";
import { sessionSources, type CourseFile, type LhViewMessage, type SessionSource, type SideMessage } from "@/src/core";
import { MessageResponse } from "@/components/ai-elements/message";
import { SessionSourceView } from "@/components/session-source";

export type WorkspaceTab = "side" | "sources";
export const SIDE_QUESTION_EVENT = "lh:side-question";
export interface SideConversation { messages: SideMessage[]; draft: string }
const EMPTY_SIDE: SideConversation = { messages: [], draft: "" };
export function SessionWorkspace({ chatId, messages, tab, setTab }: {
	chatId: string; messages: LhViewMessage[]; tab: WorkspaceTab | null; setTab: (tab: WorkspaceTab | null) => void;
}) {
	const [side, setSide] = useState<SideConversation>(EMPTY_SIDE);
	const [files, setFiles] = useState<CourseFile[]>([]);
	const [saved, setSaved] = useState<SessionSource[]>([]);
	const [busy, setBusy] = useState(false), [uploading, setUploading] = useState(false), [error, setError] = useState("");
	const [selected, setSelected] = useState<SessionSource | null>(null);
	const cancel = useRef<AbortController | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const sideRef = useRef(side); sideRef.current = side;
	const base = `/api/chats/${chatId}/workspace`;
	useEffect(() => {
		setSide(EMPTY_SIDE); setSelected(null); setError("");
		return () => { cancel.current?.abort(); }; // leaving the session discards side history
	}, [chatId]);
	useEffect(() => {
		const handler = (e: Event) => {
			const d = (e as CustomEvent<{ chatId: string; text?: string }>).detail;
			if (d.chatId !== chatId) return;
			setTab("side");
			if (d.text) setSide(s => ({ ...s, draft: d.text! }));
		};
		window.addEventListener(SIDE_QUESTION_EVENT, handler);
		return () => window.removeEventListener(SIDE_QUESTION_EVENT, handler);
	}, [chatId, setTab]);
	useEffect(() => {
		let closed = false;
		const refresh = async () => {
			try {
				const r = await fetch(base); const b = await r.json(); if (!r.ok) throw new Error(b.error);
				if (!closed) { setFiles(b.files); setSaved(b.sources); }
			} catch (e) { if (!closed) setError(String(e)); }
		};
		void refresh();
		const timer = setInterval(() => void refresh(), 4000);
		return () => { closed = true; clearInterval(timer); };
	}, [base]);
	async function send() {
		const text = sideRef.current.draft.trim(); if (!text || busy) return;
		const history: SideMessage[] = [...sideRef.current.messages, { role: "user", text }];
		setSide({ messages: history, draft: "" }); setBusy(true); setError("");
		const controller = new AbortController(); cancel.current = controller;
		try {
			const r = await fetch(base + "/side", { method: "POST", signal: controller.signal,
				headers: { "content-type": "application/json", "x-lh-workspace": "1" }, body: JSON.stringify({ messages: history }) });
			const b = await r.json(); if (!r.ok) throw new Error(b.error);
			if (!controller.signal.aborted) setSide(s => ({ ...s, messages: [...s.messages, { role: "assistant", text: b.text }] }));
		} catch (e) { if (!controller.signal.aborted) { setError(String(e)); setSide(s => ({ ...s, messages: history.slice(0, -1), draft: text })); } }
		finally { if (cancel.current === controller) setBusy(false); }
	}
	async function upload(list: FileList | File[]) {
		if (uploading) return; setUploading(true); setError("");
		try {
			for (const file of Array.from(list)) {
				const form = new FormData(); form.set("file", file);
				const r = await fetch(base + "/files", { method: "POST", headers: { "x-lh-workspace": "1" }, body: form });
				const b = await r.json(); if (!r.ok) throw new Error(b.error);
				setFiles(f => [...f, b.file]);
			}
		} catch (e) { setError(String(e)); } finally { setUploading(false); }
	}
	const sources = [...new Map([...saved, ...sessionSources(messages)].map(s => [s.id, s])).values()];
	if (!tab) return null;
	return <aside aria-label="Session workspace" className="fixed inset-y-0 right-0 z-40 flex w-[min(460px,100vw)] flex-col border-l border-border bg-background shadow-lg lg:static lg:shrink-0 lg:shadow-none">
		<header className="flex h-15 shrink-0 items-center gap-4 border-b border-border px-4 font-ui text-xs">
			{(["side", "sources"] as const).map(t => <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)} className={tab === t ? "text-foreground" : "text-muted-foreground"}>{t === "side" ? "Side questions" : "Sources"}</button>)}
			<button className="ml-auto p-1" aria-label="Close session workspace" onClick={() => setTab(null)}><XIcon className="size-4" /></button>
		</header>
		{error && <p role="alert" className="px-4 py-2 text-xs text-destructive">{error}</p>}
		{tab === "side" ? <>
			<p className="px-4 py-3 text-xs text-muted-foreground">Temporary · uses lesson context · never enters your lesson plan, graph or practice.</p>
			<div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-4">
				{side.messages.map((m, i) => <div key={i} className={m.role === "user" ? "ml-6 rounded-xl bg-muted px-3 py-2" : "lh-prose"}><MessageResponse>{m.text}</MessageResponse></div>)}
				{busy && <p role="status" className="text-xs text-muted-foreground">Answering your side question…</p>}
			</div>
			<div className="space-y-2 border-t border-border p-4">
				<textarea aria-label="Side question" className="lh-input min-h-20 w-full resize-y rounded-xl border bg-card px-3 py-2 outline-none" placeholder="Ask without interrupting the lesson…" value={side.draft} onChange={e => setSide(s => ({ ...s, draft: e.target.value }))} onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
				<div className="flex justify-between font-ui text-xs"><button onClick={() => { cancel.current?.abort(); setSide(EMPTY_SIDE); setBusy(false); }}>Clear conversation</button><button disabled={busy || !side.draft.trim()} onClick={() => void send()}>Send</button></div>
			</div>
		</> : <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" onDragOver={e => { e.preventDefault(); e.stopPropagation(); }} onDrop={e => { e.preventDefault(); e.stopPropagation(); void upload(e.dataTransfer.files); }}>
			<input ref={fileInput} className="hidden" type="file" multiple accept=".pdf,.docx,.pptx" onChange={e => { if (e.target.files) void upload(e.target.files); e.target.value = ""; }} />
			<button disabled={uploading} onClick={() => fileInput.current?.click()} className="flex items-center gap-2 rounded-sm border border-border px-3 py-2 font-ui text-xs"><PaperclipIcon className="size-3.5" />{uploading ? "Uploading…" : "Attach course files"}</button>
			<p className="text-xs text-muted-foreground">PDF, Word (.docx), PowerPoint (.pptx) · 25 MB each. Drop files here. Office files require LibreOffice.</p>
			{files.map(f => <details key={f.id} className="border-b border-border pb-3 text-sm"><summary>{f.name} <span className="text-xs text-muted-foreground">{f.status === "ready" ? `${f.pages} pages` : f.status}</span></summary>
				{f.error && <p role="alert" className="mt-2 text-xs text-destructive">{f.error}</p>}
				{f.status === "ready" && <div className="mt-2 flex flex-wrap gap-2">{Array.from({ length: Math.min(f.pages ?? 0, 500) }, (_, i) => <button key={i} className="rounded border px-2 py-1 text-xs" onClick={() => setSelected({ id: `${f.id}-p${i + 1}`, kind: "page", title: `${f.name} · page ${i + 1}`, citation: `${f.name}, page ${i + 1}`, url: `${base}/files/${f.id}/page/${i + 1}` })}>{i + 1}</button>)}</div>}
			</details>)}
			{selected && <section><div className="flex justify-between text-xs"><span>{selected.title}</span><button onClick={() => setSelected(null)}>Close preview</button></div><SessionSourceView source={selected} /></section>}
			<h3 className="font-ui text-xs uppercase tracking-wide text-muted-foreground">Saved in this session</h3>
			{!sources.length && <p className="text-sm text-muted-foreground">Demos, diagrams, chemical structures and displayed course pages will appear here.</p>}
			{sources.map(s => <details key={s.id} className="border-b border-border py-2"><summary className="cursor-pointer text-sm">{s.title}</summary><SessionSourceView source={s} /></details>)}
		</div>}
	</aside>;
}
