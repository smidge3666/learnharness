"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { joinDictation, useDictationTarget } from "@/components/dictation";
import { PathInput } from "@/components/path-input";

/**
 * The reading-thinking field (owner design 2026-10-03, "two questions per
 * teaching unit"): a quiet textarea for thinking WHILE READING the
 * teaching prose — the same transfer channel the question dock's "Your
 * thinking" gives the answer, opened one phase earlier. It mounts while a
 * teach-phase check waits behind its reveal (the same cue that collapses
 * the check), rides the check answer as the SEPARATE `readingThinking`
 * channel (never conflated with the quiz thinking), and disappears with
 * the question.
 *
 * Dictation: while the check sits UNREVEALED this field is the primary
 * target (the dock releases its claim — dictated reading-thoughts land
 * here, not in the hidden quiz field); once the learner reveals the
 * check, the dock reclaims and this field is plain typing.
 */
export function ReadingThinkingField({
	value,
	revision,
	onChange,
	onEscape,
	onOpen,
	claim,
	onAsk,
	busy = false,
}: {
	value: string;
	revision: number;
	onChange: (v: string) => void;
	/** Esc in the field stops dictation (threaded from the page's hook). */
	onEscape?: () => void;
	/** The check waits CLOSED — Ctrl/Cmd+Enter opens it; plain Enter is a newline. The caller finishes any live dictation FIRST (the
	 *  flush lands here — the field is the live claim), then reveals.
	 *  Absent = the check is open: Enter keeps the dumping convention. */
	onOpen?: () => void;
	/** Primary dictation claim — true while the check is behind its reveal. */
	claim: boolean;
	/** Ask the main teacher before attempting the waiting check. */
	onAsk?: (question: string) => void;
	busy?: boolean;
}) {
	const [draft, setDraft] = useState(value);
	// Appends may arrive back-to-back before React commits. Like Chat's
	// submit mirror, this ref includes every edit synchronously.
	const draftRef = useRef(value);
	useLayoutEffect(() => { draftRef.current = value; setDraft(value); }, [revision, value]);
	const applyDraft = useCallback((next: string) => {
		draftRef.current = next;
		setDraft(next);
		onChange(next);
	}, [onChange]);
	// Ask-first (fork, 2026-10-31): a question to the teacher before the check.
	const [asking, setAsking] = useState(false);
	const [question, setQuestion] = useState("");
	useDictationTarget(
		useCallback((text: string) => applyDraft(joinDictation(draftRef.current, text)), [applyDraft]),
		claim,
	);
	return (
		<div
			data-testid="reading-thinking-field"
			className="pointer-events-auto mb-2 rounded-2xl border bg-card/60 px-3 py-2 transition-colors focus-within:border-primary/50"
		>
			<div className="pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				Thinking while reading
			</div>
			<PathInput
				value={draft}
				onValueChange={applyDraft}
				/* py-0.5 (owner round, 2026-10-07): the scrollbar fix. Source
				   Sans 3's font box is 22px at 16px; lh-input's 1.25 leading
				   gives a 20px line box — the content area sticks 1px below the
				   line, Chromium counts it in scrollHeight, and a zero-padding
				   textarea turns that into a permanent 1px scroll (the bar shows
				   empty and at every size below max-h). 2px of vertical padding
				   absorbs it — the same absorption the composer and dock fields
				   get implicitly from their py-2. Line-height stays 1.25 (the
				   caret law, typography round 2). */
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						// Esc stops dictation (the strip's rule) — claimed so the
						// window chain doesn't also read it as abort-turn.
						e.preventDefault();
						e.stopPropagation();
						onEscape?.();
						return;
					}
					// ⌘/Ctrl+Enter OPENS THE WAITING CHECK. Plain Enter is a
					// newline (owner bug report: plain Enter jumped straight into
					// the questions mid-thought). The dictation flush lands HERE
					// first via the caller's finishDictation.
					if (e.key === "Enter" && onOpen !== undefined && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						e.stopPropagation();
						onOpen();
						return;
					}
					// The dock's dumping convention: plain Enter is a newline.
					// No submit button here — the check's own submit is this
					// field's carrier — so ⌘↵ just blurs.
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
						e.preventDefault();
						e.currentTarget.blur();
					}
				}}
				placeholder="Whatever comes to mind as you read."
				className="field-sizing-content lh-input max-h-40 w-full resize-none bg-transparent py-0.5 outline-none placeholder:text-muted-foreground/70"
			/>
			{onAsk && asking && <div data-clarify-form="" className="mt-2 space-y-2 border-t border-border pt-2">
				<PathInput aria-label="Question before the check" placeholder="What would you like clarified?" value={question} onValueChange={setQuestion} className="lh-input min-h-12 w-full bg-transparent py-0.5 outline-none" onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (question.trim() && !busy) onAsk(question); } }} />
				<div className="flex justify-end gap-3 font-ui text-xs"><button type="button" onClick={() => setAsking(false)}>Cancel</button><button type="button" disabled={busy || !question.trim()} onClick={() => onAsk(question)}>Send to teacher</button></div>
			</div>}
			{onAsk && !asking && (
				<div className="flex justify-end pt-1">
					<button
						type="button"
						data-testid="reading-ask-first"
						onClick={() => setAsking(true)}
						className="rounded-sm px-2 py-1 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						Ask a question first
					</button>
				</div>
			)}
		</div>
	);
}
