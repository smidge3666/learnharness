import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
(globalThis as Record<string, unknown>).React = React;
import { renderToStaticMarkup } from "react-dom/server";
import { after, describe, it } from "node:test";
import { inputAppends, parseChatInput, ChatInputError } from "../src/core/input-events.ts";
import { compactAnswerForModel, questionFigureSource } from "../src/core/question-core.ts";
import { sessionSources, validateSideHistory } from "../src/core/session-workspace.ts";
// The data seam MUST precede the first config-dependent import.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "lh-workspace-tests-"));
process.env.LH_DATA_DIR = path.join(SCRATCH, "data");
process.env.LH_AUTH_FILE = path.join(SCRATCH, "auth.json");
const { createCourseStore } = await import("../src/store/course-files.ts");
after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));
import { ReadingThinkingField } from "../components/reading-thinking.tsx";
import type { LhMessage } from "../src/core/native-messages.ts";

const pendingCheck: LhMessage[] = [{
	id: "a1", role: "assistant", stopReason: "toolUse", timestamp: 0, api: "x", provider: "x", model: "x",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	content: [{ type: "toolCall", id: "q1", name: "quiz", arguments: { type: "check", nodeId: "n", question: "Why?", options: [{ label: "a" }, { label: "b" }], correctAnswer: "a", explanation: "e" } }],
} as unknown as LhMessage];

describe("Ask a question first (deferred check)", () => {
	it("parses and validates clarify input", () => {
		assert.deepEqual(parseChatInput({ type: "clarify", toolCallId: "q1", text: "What is x?" }), { type: "clarify", toolCallId: "q1", text: "What is x?", readingThinking: undefined });
		assert.throws(() => parseChatInput({ type: "clarify", toolCallId: "q1", text: "  " }), ChatInputError);
		assert.throws(() => parseChatInput({ type: "clarify", text: "x" }), ChatInputError);
	});
	it("defers the check (not graded, not dismissed-as-skip) and carries the question + reading thoughts", () => {
		const out = inputAppends({ messages: pendingCheck }, { type: "clarify", toolCallId: "q1", text: "What is x?", readingThinking: "I got lost at step 2" });
		assert.equal(out.length, 2);
		const result = out[0] as unknown as { role: string; toolCallId: string; details: { deferred: boolean }; content: { text: string }[] };
		assert.equal(result.role, "toolResult");
		assert.equal(result.toolCallId, "q1");
		assert.equal(result.details.deferred, true);
		assert.match(result.content[0]!.text, /NOT an answer/);
		const user = out[1] as unknown as { content: string };
		assert.match(user.content, /I got lost at step 2/);
		assert.match(user.content, /What is x\?/);
	});
	it("refuses a clarify that targets no pending check", () => {
		assert.throws(() => inputAppends({ messages: [] }, { type: "clarify", toolCallId: "q1", text: "x" }), ChatInputError);
		assert.throws(() => inputAppends({ messages: pendingCheck }, { type: "clarify", toolCallId: "other", text: "x" }), ChatInputError);
	});
	it("the model sees deferred, never a skip", () => {
		assert.deepEqual(compactAnswerForModel({ kind: "quiz", questionText: "q", dontKnow: false, answers: [], dismissed: true, deferred: true, answeredAt: "" }), { kind: "quiz", deferred: true });
	});
	it("the reading field offers the button and plain Enter no longer opens the check", () => {
		const html = renderToStaticMarkup(<ReadingThinkingField value="" revision={0} onChange={() => {}} claim onOpen={() => {}} onAsk={() => {}} />);
		assert.match(html, /Ask a question first/);
	});
});

describe("side questions", () => {
	it("validates temporary history and bounds it", () => {
		assert.deepEqual(validateSideHistory([{ role: "user", text: "why?" }]), [{ role: "user", text: "why?" }]);
		assert.throws(() => validateSideHistory([{ role: "system", text: "x" }]));
		assert.throws(() => validateSideHistory(Array.from({ length: 41 }, () => ({ role: "user", text: "x" }))));
	});
	it("side chats are never stored in the lesson: sources derive only from the lesson transcript", () => {
		// The side endpoint has no write path; the only persisted session state is the transcript + sources file.
		const src = fs.readFileSync(new URL("../src/server/session-workspace.ts", import.meta.url), "utf8");
		const side = src.slice(src.indexOf("export async function sideAnswer"), src.indexOf("export async function workspaceResponse"));
		assert.doesNotMatch(side, /saveMessages|saveSource|graphStore|jobStore|practice|writeFileSync/);
	});
});

describe("session sources", () => {
	it("collects demos, figures, mermaid, smiles and images from the lesson", () => {
		const view = [
			{ id: "m1", role: "assistant" as const, parts: [{ type: "text", text: "See:\n```smiles\nCCO\n```\n```mermaid\ngraph TD; A-->B\n```\n![Cell](https://example.com/cell.png)" }] },
			{ id: "m2", role: "user" as const, parts: [{ type: "data-subagent-artifact", data: { kind: "visual", result: { svg: "<svg/>" } } }] },
			{ id: "m3", role: "user" as const, parts: [{ type: "data-subagent-artifact", data: { kind: "demo", result: { html: "<p/>", title: "Pendulum" } } }] },
			{ id: "m4", role: "user" as const, parts: [{ type: "text", text: "```smiles\nC\n```" }] },
		];
		const kinds = sessionSources(view).map(s => s.kind).sort();
		assert.deepEqual(kinds, ["demo", "image", "mermaid", "smiles", "visual"], "learner-authored fences are not saved as teaching sources");
		assert.equal(sessionSources(view).find(s => s.kind === "demo")?.title, "Pendulum");
	});
});

describe("course file store", () => {
	it("stores per session, rejects traversal ids and keeps sources", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-"));
		const store = createCourseStore(root);
		const meta = store.create("chat_1", "../../lecture.pdf", "pdf", new TextEncoder().encode("%PDF-1.4"));
		assert.equal(meta.name, "lecture.pdf");
		assert.equal(store.list("chat_1")[0]!.id, meta.id);
		assert.deepEqual(store.list("chat_2"), []);
		assert.throws(() => store.dir("../x", meta.id));
		assert.throws(() => store.dir("chat_1", "../../etc"));
		store.saveSource("chat_1", { id: "p", kind: "page", title: "Lecture · page 1" });
		store.saveSource("chat_1", { id: "p", kind: "page", title: "Lecture · page 1 (again)" });
		assert.equal(store.sources("chat_1").length, 1);
		fs.rmSync(root, { recursive: true, force: true });
	});
	it("renames sources per session, trims, bounds length, and restores on empty", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-"));
		const store = createCourseStore(root);
		assert.deepEqual(store.names("chat_1"), {});
		assert.deepEqual(store.rename("chat_1", "m1-0-f0", "  Krebs cycle  "), { "m1-0-f0": "Krebs cycle" });
		assert.deepEqual(store.names("chat_2"), {});
		assert.throws(() => store.rename("chat_1", "m1-0-f0", "x".repeat(121)));
		assert.throws(() => store.rename("../x", "m1", "y"));
		assert.deepEqual(store.rename("chat_1", "m1-0-f0", ""), {});
		fs.rmSync(root, { recursive: true, force: true });
	});
});

describe("side answers end-to-end (scripted engine, temp data)", () => {
	it("answers from lesson context and leaves the lesson record byte-identical", async () => {
		const root = SCRATCH;
		const { createFauxCore, fauxAssistantMessage, fauxText } = await import("@earendil-works/pi-ai");
		const { stores } = await import("../src/server/stores.ts");
		const { sideAnswer } = await import("../src/server/session-workspace.ts");
		const chat = stores.chatStore.createChat("side");
		stores.chatStore.saveMessages(chat.id, pendingCheck);
		stores.settingsStore.writeSettings({ version: 1, models: { strong: { model: { provider: "x", id: "y" } } } });
		const before = fs.readFileSync(path.join(SCRATCH, "data", "chats", `${chat.id}.json`), "utf8");
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage([fauxText("Side answer.")])]);
		const text = await sideAnswer(chat.id, [{ role: "user", text: "tangent?" }], new AbortController().signal, { model: faux.getModel(), streamFn: faux.streamSimple });
		assert.equal(text, "Side answer.");
		assert.equal(fs.readFileSync(path.join(SCRATCH, "data", "chats", `${chat.id}.json`), "utf8"), before);
		assert.equal(fs.existsSync(path.join(SCRATCH, "data", "graph")), false, "no graph writes");
		fs.rmSync(root, { recursive: true, force: true });
	});
});

describe("question figures (owner, 2026-10-31)", () => {
	const base = "/api/chats/chat_1/workspace";
	it("resolves a course page region into a cropped image URL", () => {
		const source = questionFigureSource({ fileId: "f1", page: 4, crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.25 }, caption: "Figure B" }, base);
		assert.equal(source?.kind, "page");
		assert.equal(source?.title, "Figure B");
		assert.equal(source?.url, `${base}/files/f1/page/4?crop=0.1,0.2,0.5,0.25`);
	});
	it("resolves a saved source by id, keeping its own render path", () => {
		const found = { id: "m1-0-f0-x", kind: "mermaid" as const, title: "Diagram", content: "graph TD; A-->B" };
		assert.equal(questionFigureSource({ sourceId: "m1-0-f0-x" }, base, id => (id === found.id ? found : undefined))?.title, "Diagram");
		assert.equal(questionFigureSource({ sourceId: "missing" }, base, () => undefined), undefined);
	});
	it("has no figure when neither form is given", () => {
		assert.equal(questionFigureSource(undefined, base), undefined);
		assert.equal(questionFigureSource({ caption: "orphan" }, base), undefined);
	});
	it("keeps a question's figure out of Sources until it is explicitly saved", () => {
		// A question figure is a display URL only: no `save=1`, so the page route
		// records nothing (the review's GET-with-side-effects finding).
		const url = questionFigureSource({ fileId: "f1", page: 2 }, base)!.url!;
		assert.ok(!url.includes("save=1"));
	});
});
