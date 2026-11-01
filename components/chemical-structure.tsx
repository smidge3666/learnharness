"use client";
import { useEffect, useRef, useState } from "react";

/** Every atom the same colour as the text (owner, 2026-10-31): one white
 *  drawing on the app background, no per-element rainbow. */
export const TEXT_THEME = {
	FOREGROUND: "#ffffff",
	BACKGROUND: "transparent",
	C: "#ffffff",
	O: "#ffffff",
	N: "#ffffff",
	F: "#ffffff",
	CL: "#ffffff",
	BR: "#ffffff",
	I: "#ffffff",
	P: "#ffffff",
	S: "#ffffff",
	B: "#ffffff",
	SI: "#ffffff",
	H: "#ffffff",
};

/** The drawing knobs from Appearance settings, read off the root at draw
 *  time (the provider sets them as CSS vars, so a change needs no prop
 *  threading and no re-render of the transcript).
 *
 *  TEXT NORMALIZATION (owner report, 2026-10-31): the drawer's rendered
 *  label size is fontSize x scale, so a raw fontSize made short molecules
 *  look enormous once the SVG was sized naturally. fontSize is a PERCENT
 *  of the reading text instead, and the drawer value is divided by scale —
 *  every molecule then prints its atoms at the prose size.
 */
export function drawOptions(): { scale: number; bondThickness: number; fontSize: number } {
	const read = (name: string, fallback: number) => {
		if (typeof window === "undefined") return fallback;
		const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
		const n = Number(raw);
		return Number.isFinite(n) && n > 0 ? n : fallback;
	};
	const scale = read("--lh-smiles-scale", 1.2);
	const prose = read("--lh-prose-size", 16);
	const percent = read("--lh-smiles-font", 100); // textPercent: 100 = prose size
	return {
		scale,
		bondThickness: read("--lh-smiles-thickness", 1.6),
		// The drawer sets `font: Xpt` inside a viewBox scaled by `scale`, and
		// 1pt = 4/3 px. So rendered px = X * scale * 4/3; invert all three to
		// land the glyphs on the prose size.
		fontSize: Math.max(1, Math.round(((prose * percent) / 100 / scale / (4 / 3)) * 10) / 10),
	};
}

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
					const opts = drawOptions();
					new smiles.SvgDrawer({
						// width 0 lets the drawer size the viewBox to the molecule's own
						// bounding box; a POSITIVE scale keeps the real aspect ratio (the
						// library's default scale of 0 pads every drawing into a SQUARE —
						// the reason a long chain was unreadable). CSS then stretches it
						// to the container width and the height follows.
						width: 0, height: 0,
						scale: opts.scale,
						padding: 8,
						bondThickness: opts.bondThickness,
						fontSizeLarge: opts.fontSize,
						fontSizeSmall: Math.max(1.5, Math.round((opts.fontSize / 4) * 10) / 10),
						themes: { text: TEXT_THEME },
					}).draw(tree, svg, "text");
					svg.setAttribute("role", "img"); svg.setAttribute("aria-label", `Chemical structure: ${line}`);
					// NATURAL size, never stretched (owner report, 2026-10-31: a short
					// molecule like CC(=O)O filled the whole column because CSS
					// stretched a 69-unit viewBox to 100% — which also blew its atom
					// labels up ~10x). The viewBox is in drawer units and `scale` is
					// units-to-px, so width = units x scale gives every molecule the
					// SAME text size. max-width only shrinks genuinely wide chains.
					const [, , vw = 1, vh = 1] = (svg.getAttribute("viewBox") ?? "0 0 1 1").split(" ").map(Number);
					const px = (n: number) => Math.round(n * opts.scale);
					svg.removeAttribute("width"); svg.removeAttribute("height");
					svg.style.width = `${px(vw)}px`;
					svg.style.height = `${px(vh)}px`;
					svg.style.maxWidth = "100%";
					svg.style.maxHeight = "70vh";
					svg.style.display = "block";
					svg.style.background = "transparent";
					el.append(svg);
				}, e => { if (!closed) setError(`Invalid SMILES: ${String(e)}`); });
			}
		}).catch(e => { if (!closed) setError(String(e)); });
		return () => { closed = true; el.replaceChildren(); };
	}, [source]);
	return <figure className="my-4 w-fit max-w-full" data-testid="chemical-structure">
		<div ref={holder} className="w-fit max-w-full bg-transparent" />
		{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
		<figcaption className="mt-1 break-all font-mono text-xs text-muted-foreground">{source}</figcaption>
	</figure>;
}
