# A reworked paragraph reads as two paragraphs

## Status

Accepted November 6, 2026: Zach chose this. He picked B, "Two paragraphs", in the throwaway prototype `prose-rewrite`, kept outside the repository in the design pass's own folder (`sotto-council\prototypes\prose-rewrite\` under the laptop's local app data). **Number provisional until merge** (docs/agents/domain.md).

No earlier ADR recorded how prose changes are drawn; `CONTEXT.md` under Diff drawing held it. This one records only that pick.

## Context

A document's change in Changes and in the transcript reads as its page. A line edited lightly (in a place or two, none of them past about eight words) reads once: at each change the words that went, struck through, then the words that came, underlined. A paragraph changed more than that, reworked, read the same way, each pair once and in its place, with **Show earlier wording** under it to open the whole of what it said.

Reviewers found heavily edited prose hard going: "Word-level highlights turn paragraphs into confetti", and the interleaved struck and underlined runs were "so dense that neither the old nor the new text can be read straight through".

The prototype redrew CONTEXT.md's reworked paragraphs in Changes three ways, with light edits kept as they are in all three:

- **A, Today.** Each change in its place, struck then underlined, each pair once, with Show earlier wording opening the old paragraph under it.
- **B, Two paragraphs.** The old paragraph whole, a step quieter, its removed words struck. Under it the new paragraph whole, its new words underlined. Each reads straight through, and there is nothing to open.
- **C, New first.** The new paragraph whole with no marks in its words and a faint mark in the margin beside each line it changed; the old paragraph under Show earlier wording, open when under a third of the words changed and shut when more did.

## Decision

**B.** A reworked paragraph reads as two paragraphs, in Changes and in a thread's edit rows alike:

1. First the paragraph as it was, whole, in the secondary ink, its words that went struck through in the removed role's hairline.
2. Then, 8 pixels under it, the paragraph as it is now, whole, in the body's ink, its words that came underlined in the added role's colour.
3. The edited edge lights beside the lines of the new paragraph that a change reaches, as it does for a light edit.
4. A long paragraph rewritten whole (no words kept to read a change against) reads the same way, with no word marks on either paragraph.
5. **Show earlier wording** and **Hide earlier wording** are gone: with the old paragraph always in view they have no job.

The line between a light edit and a reworked paragraph is the one the code already drew (`diffDrawing.ts`, `editWeight`): more than two changes, or any change past 48 letters on either side, and the paragraph is reworked. The prototype used that line too.

## Consequences

- A reader can read either version through without a press, and the margin still says which lines of the new one changed.
- A reworked paragraph takes about twice the height it did. Light edits, short lines rewritten whole and everything else in Changes are unchanged.
- A screen reader hears the old paragraph with its removed words named, then the new one with its added words named.
