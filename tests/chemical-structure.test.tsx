/**
 * SMILES chemistry rendering: the fence routes to the structure component,
 * and the local drawer actually produces an SVG (no network, no model).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { ChemicalStructure } from "../components/chemical-structure.tsx";
import { TEXT_THEME } from "../components/chemical-structure.tsx";

describe("chemical structures (SMILES)", () => {
	it("a ```smiles fence renders the structure block, not a code block", () => {
		const html = renderToStaticMarkup(<MessageResponse mode="static">{"```smiles\nCCO\n```"}</MessageResponse>);
		assert.match(html, /data-testid="chemical-structure"/);
		assert.ok(!html.includes('data-testid="md-code"'), "chemistry never falls through to the code renderer");
		assert.match(html, /CCO/, "the SMILES source stays visible as the caption");
	});

	it("mermaid and other fences keep their own renderers", () => {
		const mermaid = renderToStaticMarkup(<MessageResponse mode="static">{"```mermaid\ngraph TD; A-->B\n```"}</MessageResponse>);
		assert.match(mermaid, /data-testid="md-mermaid"/);
		const code = renderToStaticMarkup(<MessageResponse mode="static">{"```python\nprint(1)\n```"}</MessageResponse>);
		assert.match(code, /data-testid="md-code"/);
	});

	it("the component shell carries the source and an accessible figure", () => {
		const html = renderToStaticMarkup(<ChemicalStructure source="c1ccccc1" />);
		assert.match(html, /<figure/);
		assert.match(html, /c1ccccc1/);
	});

	it("draws at the molecule's own aspect ratio, in one colour, on no background (owner, 2026-10-31)", async () => {
		// Regression: the drawer's default scale of 0 pads EVERY structure into a
		// square, so a long chain was drawn tiny inside a big empty box. The
		// component now passes scale:1, all atoms in the text colour, and no
		// background layer.
		const { document, window } = parseHTML("<html><body></body></html>");
		const previous = { document: globalThis.document, SVGSVGElement: (globalThis as Record<string, unknown>).SVGSVGElement };
		Object.assign(globalThis, { document, SVGSVGElement: window.SVGElement });
		try {
			const { default: smiles } = await import("smiles-drawer");
			const aspectOf = (smi: string) => {
				const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
				new smiles.SvgDrawer({ width: 0, height: 0, scale: 1, padding: 8, themes: { text: TEXT_THEME } }).draw(treeOf(smi), svg, "text");
				const [x, y, w, h] = svg.getAttribute("viewBox")!.split(" ").map(Number) as [number, number, number, number];
				assert.ok(Number.isFinite(x) && Number.isFinite(y));
				return { ratio: w / h, html: svg.outerHTML };
			};
			const treeOf = (smi: string) => {
				let tree: unknown;
				smiles.parse(smi, t => { tree = t; }, (e: Error) => assert.fail(`must parse: ${e}`));
				return tree;
			};
			const chain = aspectOf("CCCCCCCCCCCCCCCCCC(=O)O");
			assert.ok(chain.ratio > 4, `a long chain must not be squared off (got ${chain.ratio.toFixed(2)})`);
			assert.ok(Math.abs(aspectOf("CCO").ratio - 1) > 0.2, "ethanol is not square either");
			// One colour for every atom; no background rectangle to paint over the app.
			const colours = new Set((chain.html.match(/#[0-9a-f]{6}/gi) ?? []).map(c => c.toLowerCase()));
			assert.deepEqual([...colours], ["#ffffff"]);
			assert.ok(!/<rect[^>]*fill="#[0-9a-f]{6}"/i.test(chain.html), "no opaque background layer");
		} finally {
			Object.assign(globalThis, previous);
		}
	});

	it("normalizes atom text to the reading size and never stretches a short molecule (owner, 2026-10-31)", async () => {
		// The bug: the SVG was stretched to 100% of the column, so CC(=O)O's
		// 69-unit viewBox became ~1000px wide and its labels ~10x too big.
		// The law now: a drawing's rendered label = prose size x (atomScale%),
		// because the drawer multiplies font size by scale and we divide it back.
		const { document, window } = parseHTML("<html><body></body></html>");
		const previous = { document: globalThis.document, SVGSVGElement: (globalThis as Record<string, unknown>).SVGSVGElement };
		Object.assign(globalThis, { document, SVGSVGElement: window.SVGElement });
		try {
			const { default: smiles } = await import("smiles-drawer");
			// The component's own option derivation, with the vars it reads.
			// Mirrors drawOptions(): px = fontSize * scale * 4/3 (the drawer's
			// font is in POINTS inside a viewBox scaled by `scale`).
			const opts = (scale: number, prose: number, percent: number) => ({
				scale, bondThickness: 1.6,
				fontSize: Math.max(1, Math.round(((prose * percent) / 100 / scale / (4 / 3)) * 10) / 10),
			});
			const size = (smi: string, o: ReturnType<typeof opts>) => {
				let tree: unknown;
				smiles.parse(smi, t => { tree = t; }, (e: Error) => assert.fail(String(e)));
				const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
				new smiles.SvgDrawer({ width: 0, height: 0, padding: 8, themes: { text: TEXT_THEME }, ...o }).draw(tree, svg, "text");
				const [, , w, h] = svg.getAttribute("viewBox")!.split(" ").map(Number) as [number, number, number, number];
				return { w: w * o.scale, h: h * o.scale };
			};
			// A two-atom acid must stay small — it must not be a column-wide banner.
			const acetic = size("CC(=O)O", opts(1.2, 16, 100));
			assert.ok(acetic.w < 200, `CC(=O)O must not fill the column (got ${Math.round(acetic.w)}px)`);
			// Text size is INDEPENDENT of the molecule's length: labels are the
			// same in a 2-atom and a 20-atom drawing (same opts => same fontSize).
			const chain = size("CCCCCCCCCCCCCCCCCC(=O)O", opts(1.2, 16, 100));
			assert.ok(chain.w > acetic.w * 4, "a long chain is wider than a short acid");
			// The atom-size setting scales the TEXT, so a bigger percent must grow it.
			assert.ok(opts(1.2, 16, 150).fontSize > opts(1.2, 16, 100).fontSize);
			const rendered = opts(1.2, 16, 100).fontSize * 1.2 * (4 / 3);
			assert.ok(Math.abs(rendered - 16) < 0.6, `100% of 16px prose renders ~16px (got ${rendered.toFixed(2)})`);
			// Changing the reading font size moves the drawing's text with it.
			const bigger = opts(1.2, 20, 100).fontSize * 1.2 * (4 / 3);
			assert.ok(Math.abs(bigger - 20) < 0.6, `20px prose renders ~20px (got ${bigger.toFixed(2)})`);
		} finally {
			Object.assign(globalThis, previous);
		}
	});

	it("the local drawer parses real SMILES into an SVG and reports invalid input", async () => {
		// The exact call sequence the component runs in the browser.
		const { document, window } = parseHTML("<html><body></body></html>");
		const previous = { document: globalThis.document, SVGSVGElement: (globalThis as Record<string, unknown>).SVGSVGElement };
		Object.assign(globalThis, { document, SVGSVGElement: window.SVGElement });
		try {
			const { default: smiles } = await import("smiles-drawer");
			const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			let drawn = "";
			smiles.parse("CCO", (tree: unknown) => {
				new smiles.SvgDrawer({ width: 440, height: 260 }).draw(tree as never, svg as never, "light");
				drawn = svg.outerHTML;
			}, (e: Error) => assert.fail(`ethanol must parse: ${e}`));
			assert.match(drawn, /^<svg/);
			assert.ok(drawn.length > 200, "a real structure, not an empty root");
			let failure: string | null = null;
			smiles.parse("not a molecule((", () => assert.fail("invalid SMILES must not draw"), (e: Error) => { failure = String(e); });
			assert.ok(failure, "invalid SMILES reaches the error callback the component surfaces");
		} finally {
			Object.assign(globalThis, previous);
		}
	});
});
