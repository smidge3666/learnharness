"use client";
import { questionFigureSource, type QuestionFigure as Figure, type SessionSource } from "@/src/core";
import { ExpandableFigure } from "@/components/expandable-figure";
import { MessageResponse } from "@/components/ai-elements/message";
import { ChemicalStructure } from "@/components/chemical-structure";

/**
 * A question's picture (owner, 2026-10-31): the learner must LOOK at
 * something before answering — a course slide region, or a diagram the
 * teacher drew earlier in this session.
 *
 * Deliberately self-contained: it does NOT go through SessionSourceView,
 * whose artifact cards import chat.tsx — a question rendered inside the
 * dock would then re-enter chat's module graph (an import cycle that
 * breaks the dock's height measurement).
 *
 * The figure is display-only. It never becomes a Source on its own (a
 * plain image GET must not write): if the teacher wants it saved, it says
 * so through show_course_page, exactly like any other page.
 *
 * Crops ride the URL (`?crop=x,y,w,h`) and are cut server-side, so the
 * browser only ever receives the region the question is about.
 */
export function QuestionFigure({ figure, chatId }: { figure: Figure; chatId: string }) {
	const base = `/api/chats/${chatId}/workspace`;
	const source = questionFigureSource(figure, base);
	if (!source) return null;
	return (
		<figure className="mb-3" data-testid="question-figure">
			{/* Same law as prose figures (owner, 2026-10-31): arrives at the
			    configured share of the column, click to see it full width. */}
			<ExpandableFigure label={`Expand ${source.title}`}>
				<FigureBody source={source} />
			</ExpandableFigure>
			{source.citation && source.citation !== source.title
				? <figcaption className="mt-1 text-center text-xs text-muted-foreground">{source.citation}</figcaption>
				: null}
		</figure>
	);
}

function FigureBody({ source }: { source: SessionSource }) {
	if (source.kind === "smiles") return <ChemicalStructure source={source.content ?? ""} />;
	if (source.kind === "mermaid") return <MessageResponse>{"```mermaid\n" + (source.content ?? "") + "\n```"}</MessageResponse>;
	// A drawn diagram arrives as SVG: render it as an image, never as markup.
	if (source.kind === "visual") {
		const svg = (source.result as { svg?: string } | undefined)?.svg;
		if (svg) {
			// eslint-disable-next-line @next/next/no-img-element -- a data: SVG, not a fetchable asset
			return <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} alt={source.title} className="max-w-full" />;
		}
	}
	if (source.kind === "demo") {
		const html = (source.result as { html?: string } | undefined)?.html;
		if (html) return <iframe title={source.title} sandbox="allow-scripts" srcDoc={html} className="h-[38vh] w-full border-0" />;
	}
	if (source.url && (source.url.startsWith("/api/chats/") || /^https?:\/\//.test(source.url))) {
		// eslint-disable-next-line @next/next/no-img-element
		return <img src={source.url} alt={source.title} referrerPolicy="no-referrer" className="max-w-full object-contain" />;
	}
	return <p className="text-xs text-muted-foreground">This figure could not be displayed.</p>;
}
