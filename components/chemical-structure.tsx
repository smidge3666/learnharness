"use client";
import { useEffect, useRef, useState } from "react";

/** Parse real SMILES locally, never evaluate code or interpolate model-authored SVG into the DOM. */
export function ChemicalStructure({ source }: { source: string }) {
	const holder = useRef<HTMLDivElement>(null);
	const [error, setError] = useState("");
	useEffect(() => {
		let closed = false;
		const el = holder.current; if (!el) return;
		el.replaceChildren(); setError("");
		void import("smiles-drawer").then(mod => {
			if (closed) return;
			const smiles = mod.default;
			const lines = source.trim().split(/\r?\n/).filter(s => s.trim());
			if (lines.length > 20 || source.length > 10000) throw new Error("Chemical structure block is too large");
			for (const line of lines) {
				smiles.parse(line.trim(), tree => {
					if (closed) return;
					const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
					new smiles.SvgDrawer({ width: 440, height: 260 }).draw(tree, svg, "light");
					svg.setAttribute("role", "img"); svg.setAttribute("aria-label", `Chemical structure: ${line}`);
					svg.style.maxWidth = "100%"; svg.style.height = "auto";
					el.append(svg);
				}, e => { if (!closed) setError(`Invalid SMILES: ${String(e)}`); });
			}
		}).catch(e => { if (!closed) setError(String(e)); });
		return () => { closed = true; el.replaceChildren(); };
	}, [source]);
	return <figure className="my-4 w-fit max-w-full" data-testid="chemical-structure">
		<div ref={holder} className="rounded-sm bg-white" />
		{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
		<figcaption className="mt-1 break-all font-mono text-xs text-muted-foreground">{source}</figcaption>
	</figure>;
}
