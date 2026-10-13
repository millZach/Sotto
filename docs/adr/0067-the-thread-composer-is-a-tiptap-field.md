# The thread composer is a Tiptap field

## Status

Accepted October 9, 2026, by the owner's choices in `docs/prototypes/skill-selected-prototype.html` (A) and `docs/prototypes/skill-symbol-prototype.html` (D). The owner chose Tiptap over a hand-written contenteditable field.

## Context

A chosen native skill looked like ordinary typed text. A textarea cannot draw an atomic pill with a wand icon inside its text, or attach a description to that pill. The thread composer and the queued message editor need that distinction without changing what a provider receives or how a draft is kept.

## Decision

**1. These two fields use Tiptap.** The schema has document, paragraph, text, hard break and an inline atomic skill node, with undo and redo. It has no marks, formatting rules, headings or lists. A pill leads with a wand. Pointing at it shows the catalog description. Backspace after it, or Delete before it, removes the whole node.

**2. The draft stays text.** `ComposerDraft.text` remains the persisted text. During editing, the editor's document owns which tokens are pills and supplies the references from those pills. A token typed without picking stays plain, including another occurrence of a chosen skill. External text changes and explicit picker insertions reconcile from text and selected references, converting at most the first boundary-matched occurrence per reference. A pill stores its name, path and exact token and serialises to that token. Typing or pasting directly against it inserts a space wherever the shared mention rule needs one; valid sentence punctuation remains beside it. The pill never becomes editable characters. One paragraph with hard breaks preserves every newline, including trailing newlines and blank lines. The store, queue, dispatch and IPC shapes do not change. Picker selections use offsets in that serialised text, where a pill counts as the length of its token.

**3. Paste stays plain.** Text paste ignores HTML. Screenshot paste and file drop stay with the existing screenshot input. The field keeps the composer's keyboard actions, accessible name, focus target and menu attributes.

**4. Tiptap is bundled in the renderer.** Its packages are exact-version development dependencies. Main's runtime dependencies remain `zod` and `node-pty` (ADR-0018). This adds no network host, log content or permission authority.

## Alternatives considered

An overlay behind a textarea preserves its native editing, but the sigil remains visible and cannot be replaced by an icon. A hand-written contenteditable field permits the pill, but makes Sotto own selection mapping, atomic editing, composition and history. Tiptap provides those editor foundations and was the owner's explicit choice. T3 Code's `ComposerPromptEditorTiptap.tsx` informed the inline atom and React node view pattern; Sotto keeps its own styling.

## Consequences

The renderer bundle grows: the main renderer chunk went from 2,325 kB to 3,068 kB in `npm run build` on Windows. Tests drive the field through prompt helpers and assert serialised text rather than a textarea's value; browser tests can fill the contenteditable and read `data-prompt-text` to include native tokens. External draft updates reconcile the document without echoing to the store or moving an unchanged selection. The floating widget keeps its plain textarea. The ADR number is provisional until merge, as `docs/agents/domain.md` requires.
