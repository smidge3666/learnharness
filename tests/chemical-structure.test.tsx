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
