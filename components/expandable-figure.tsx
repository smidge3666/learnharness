"use client";
import { useState, type ReactNode } from "react";

/**
 * A figure inside teaching content (owner, 2026-10-31): it arrives at
 * --lh-image-size (75% of the reading column by default, adjustable in
 * Appearance settings) and expands to the column's full width when
 * clicked. Clicking again shrinks it back.
 *
 * The trigger is a real button, so the whole picture is the hit area and
 * keyboard users get it too (Enter/Space). The width animates through
 * `.lh-figure`; reduced-motion turns that off.
 */
export function ExpandableFigure({
	children,
	label = "Expand figure",
	className = "",
}: {
	children: ReactNode;
	/** Accessible name for the toggle — say WHAT is being expanded. */
	label?: string;
	className?: string;
}) {
	const [expanded, setExpanded] = useState(false);
	return (
		<button
			type="button"
			className={`lh-figure ${className}`}
			data-expanded={expanded}
			data-testid="expandable-figure"
			aria-pressed={expanded}
			aria-label={expanded ? `${label} — collapse` : label}
			onClick={() => setExpanded((e) => !e)}
		>
			{children}
		</button>
	);
}
