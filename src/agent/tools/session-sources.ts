import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { WorkspacePort } from "../../core/session-workspace.ts";
import { toToolResult } from "../tool-execute.ts";

export function sessionSourceTools(workspace?: WorkspacePort): Record<string, AgentTool<any>> {
	if (!workspace) return {};
	return {
		list_sources: {
			name: "list_sources", label: "Session sources", description: "List this session's attached course files and saved diagrams/demos. Use ids from this list, never invent them.", parameters: Type.Object({}),
			execute: async () => {
				const { files, sources } = workspace.list();
				return toToolResult({ files, sources: sources.map(({ result: _result, content: _content, ...s }) => s) });
			},
		},
		read_course_file: {
			name: "read_course_file", label: "Read course file", description: "Read text from selected PDF/Word/PowerPoint pages or slides. List files first. Inspect diagrams with show_course_page rather than inferring them from text.",
			parameters: Type.Object({ fileId: Type.String(), pages: Type.String({ description: "1-based page range, e.g. 1-3 or 7" }) }),
			execute: async (_id, params) => {
				const input = params as { fileId: string; pages: string };
				return toToolResult(await workspace.read(input.fileId, input.pages));
			},
		},
		show_course_page: {
			name: "show_course_page", label: "Show course page", description: "Display the ORIGINAL lecture slide/document page to the learner and inspect its rendered PNG yourself. Save it in Sources with a citation. Use when teaching from a course diagram; do not redraw it from imagination.",
			parameters: Type.Object({ fileId: Type.String(), page: Type.Integer({ minimum: 1 }) }),
			execute: async (_id, params) => {
				const input = params as { fileId: string; page: number };
				const { source, png } = await workspace.show(input.fileId, input.page);
				// details = the learner card (projected into Sources); the image is for the model to look at.
				const result = toToolResult(source);
				return { ...result, content: [...result.content, { type: "image" as const, data: png, mimeType: "image/png" }] };
			},
		},
		show_source: {
			name: "show_source", label: "Show saved source", description: "Show an existing diagram, molecule, demo or course page from this session again, without regenerating it. Get its id from list_sources.",
			parameters: Type.Object({ sourceId: Type.String() }),
			execute: async (_id, params) => {
				const input = params as { sourceId: string };
				const source = workspace.list().sources.find(s => s.id === input.sourceId);
				if (!source) throw new Error("Source not found in this session");
				return toToolResult(source);
			},
		},
	};
}
