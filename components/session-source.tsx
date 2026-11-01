"use client";
import type { ArtifactPartProps, SessionSource } from "@/src/core";
import { DemoOutputCard } from "@/components/artifacts/demo-card";
import { VisualOutputCard } from "@/components/artifacts/visual-card";
import { ChemicalStructure } from "@/components/chemical-structure";
import { MessageResponse } from "@/components/ai-elements/message";
import { ExpandableFigure } from "@/components/expandable-figure";

export function SessionSourceView({ source }: { source: SessionSource }) {
	if (source.kind === "demo") return <DemoOutputCard output={source.result} />;
	if (source.kind === "visual") return <VisualOutputCard output={source.result} />;
	if (source.kind === "smiles") return <ChemicalStructure source={source.content ?? ""} />;
	if (source.kind === "mermaid") return <MessageResponse>{"```mermaid\n" + source.content + "\n```"}</MessageResponse>;
	if (source.url && (source.url.startsWith("/api/chats/") || /^https?:\/\//.test(source.url))) return <div className="my-4">
		{/* Original course pages are private same-origin images. Remote images keep their source link.
		    The picture is click-to-expand (owner, 2026-10-31): it arrives at the
		    configured share of the reading column and grows to full width. */}
		<ExpandableFigure label={`Expand ${source.title}`}>
			{/* eslint-disable-next-line @next/next/no-img-element */}
			<img src={source.url} alt={source.title} referrerPolicy="no-referrer" />
		</ExpandableFigure>
		<figcaption className="mt-2 text-center text-xs text-muted-foreground"><a href={source.url} target="_blank" rel="noopener noreferrer">{source.citation ?? source.title}</a></figcaption>
	</div>;
	return <p className="text-xs text-muted-foreground">This source could not be displayed.</p>;
}
export function SessionSourceCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available" || !part.output) return null;
	return <SessionSourceView source={part.output as SessionSource} />;
}
