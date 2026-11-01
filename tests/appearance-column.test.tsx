/**
 * Reading column + figure sizing + SMILES knobs (owner, 2026-10-31):
 * the settings actually reach CSS, figures arrive small and expand to the
 * column, and the SMILES drawer reads its size/thickness from the same vars.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveAppearance, appearanceVars } from "../components/settings/appearance.tsx";
import { ExpandableFigure } from "../components/expandable-figure.tsx";
import { FACTORY_SETTINGS, sanitizeUserSettings } from "../src/core/settings.ts";
import { parseAppearanceSettingsBody } from "../src/server/settings-body.ts";

describe("text margin + image size settings", () => {
	it("defaults: full-width column, figures at 75%", () => {
		assert.equal(FACTORY_SETTINGS.appearance.textMargin, 0);
		assert.equal(FACTORY_SETTINGS.appearance.imageSize, 75);
	});

	it("a margin becomes a px cap; 0 stays 'none' (the old full width)", () => {
		const wide = appearanceVars(resolveAppearance({ textMargin: 720 }));
		assert.equal(wide["--lh-text-margin"], "720px");
		const full = appearanceVars(resolveAppearance({ textMargin: 0 }));
		assert.equal(full["--lh-text-margin"], "none");
	});

	it("image size reaches CSS as a percentage", () => {
		assert.equal(appearanceVars(resolveAppearance({ imageSize: 60 }))["--lh-image-size"], "60%");
		assert.equal(appearanceVars(resolveAppearance(undefined))["--lh-image-size"], "75%");
	});

	it("smiles knobs reach CSS", () => {
		const vars = appearanceVars(resolveAppearance({ smiles: { scale: 2, bondThickness: 2.5, textPercent: 120 } }));
		assert.equal(vars["--lh-smiles-scale"], "2");
		assert.equal(vars["--lh-smiles-thickness"], "2.5");
		assert.equal(vars["--lh-smiles-font"], "120");
	});

	it("sanitizer clamps out-of-range values instead of rejecting them", () => {
		const settings = sanitizeUserSettings({
			version: 1,
			appearance: { textMargin: 99_999, imageSize: 5, smiles: { scale: 99, bondThickness: 0, textPercent: 1 } },
		});
		assert.equal(settings?.appearance?.textMargin, 1600);
		assert.equal(settings?.appearance?.imageSize, 25);
		assert.deepEqual(settings?.appearance?.smiles, { scale: 3, bondThickness: 0.5, textPercent: 60 });
	});

	it("the PUT parser names its bounds and accepts the same shape", () => {
		const ok = parseAppearanceSettingsBody({ textMargin: 700, imageSize: 80, smiles: { scale: 1.5, bondThickness: 2, textPercent: 110 } });
		assert.equal(ok.ok, true);
		if (!ok.ok) return;
		assert.equal(ok.settings.textMargin, 700);
		assert.deepEqual(ok.settings.smiles, { scale: 1.5, bondThickness: 2, textPercent: 110 });
		assert.equal(parseAppearanceSettingsBody({ imageSize: 10 }).ok, false);
		assert.equal(parseAppearanceSettingsBody({ smiles: { scale: 99 } }).ok, false);
	});
});

describe("figures arrive at the configured share and expand on click", () => {
	it("renders as a toggle button, collapsed by default", () => {
		const html = renderToStaticMarkup(<ExpandableFigure label="Expand figure">x</ExpandableFigure>);
		assert.match(html, /class="lh-figure /);
		assert.match(html, /data-expanded="false"/);
		assert.match(html, /aria-pressed="false"/);
		assert.match(html, /aria-label="Expand figure"/);
	});

	it("the stylesheet drives the width from the setting, not a hard-coded size", async () => {
		const css = await import("node:fs").then(fs => fs.readFileSync("app/globals.css", "utf8"));
		assert.match(css, /\.lh-figure \{[^}]*width: var\(--lh-image-size, 75%\)/);
		assert.match(css, /\.lh-figure\[data-expanded="true"\] \{[^}]*width: 100%/);
		assert.match(css, /\.lh-reading-column \{[^}]*max-width: var\(--lh-text-margin, none\)/);
	});
});
