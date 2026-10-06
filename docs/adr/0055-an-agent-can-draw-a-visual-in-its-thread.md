# An agent can draw a visual in its thread

## Status

Accepted October 6, 2026, for issue #792, the first of three tickets in `docs/plans/2026-10-06-visualize-tool.md`. The layout is the walkthrough Zach picked from `prototype/visualize-layout` (variant C); this ticket draws the card's header, the diagram and the Read all layout, and #793 adds the step-by-step walkthrough. Interactive pages are #794, with their own ADR. The tool's transport is ADR-0020's and its scoping is ADR-0035's, used for a third server. Amends nothing.

## Context

An agent explaining how something works writes a wall of words, or a Mermaid fence the reader has to find in a long reply. Sotto already draws Mermaid safely in answers (`src/renderer/src/agents/diagrams/`). What it lacked was a way for the agent to say "this is a visual, here is what it shows, step by step", so that Sotto can lay it out as one thing, keep it with the thread and give a phone the words when it cannot show the drawing.

## Decision

**One server, one tool.** `sotto_visual` (handshake `sotto-visual`) is a scoped tool server over `ThreadToolServer` with one tool, `visualize`. It takes a title, a kind (`diagram` only for now), Mermaid source, an optional intro and up to 12 steps, each with names of the diagram's parts it is about. The input is strict, and main runs the same diagram source checks the renderer does (`src/shared/diagramSource.ts`, moved out of the renderer for this), so a source the card would refuse is refused before anything is kept. A turn draws at most 6 visuals and a thread holds at most 100. Every refusal says what happened and that nothing was drawn.

**A list of scoped servers.** The single host setup slot every host layer carried becomes `useThreadTools(ScopedThreadTools[])`, and the host setup tools and the visual tool are two entries. Each adapter offers every entry that answers for the thread at launch. Claude Code, Codex and Grok Build get the visual tool on every project thread. Devin's client ignores supplied servers, personal chats get none, and a host on another machine runs no Sotto tool servers, so none of those get it.

**No prompt, because nothing outside the thread changes.** Drawing a visual changes no file, runs no command, reaches no host and spends nothing; it adds a card to the thread the agent is already writing in, from source the agent could have written into its reply. So it carries no native prompt (Claude's `--allowedTools`, Codex's `default_tools_approval_mode: 'approve'`, Grok's one-time question answered for the server by name) and Sotto asks nothing of its own. That is the reasoning ADR-0035 used for suppressing the host setup tools' native prompts, applied to a tool with nothing to approve at all. It answers no request on the user's behalf, so it is not an exception to "the user answers every permission". **Let agents draw visuals in threads** in Settings, on by default and read live, turns it off: a new launch is offered no server, a running session's call is refused, and visuals already drawn stay.

**Kept in its own table, not as a thread event.** A visual is a row in a `visuals` table in `threads.sqlite`, anchored to the newest message and the newest user message the projection holds when the call arrives, after any provider events still waiting are written. A thread event would not survive: every `messages-reset` rebuilds the projection from the provider's own history, which knows nothing of visuals, and Grok resets by itself when it coalesces streamed chunks. The table follows the thread's history: with Keep local history off it is in memory, turning history off empties it, forgetting a thread or redacting all history deletes its rows, and a confirmed rewind deletes the rows of the turns it took back. A provider's own reset deletes nothing. Only a confirmed rewind deletes; an unconfirmed one keeps the rows, and a visual whose turn did go is left out of every window anyway.

**Delivered as a message.** The workspace slots each visual into the loaded window as an assistant message with ID `visual:<id>`, a `visual` field and, as its text, the visual's title, intro and numbered steps, then "The visual is in Sotto on your computer." A visual goes after the message it was anchored to when that is in the window, else at the end of its turn, else nowhere. All three providers end a reply at a tool call (Claude's next API message, Codex's next agent message item, Grok's next chunk), so this lands the card between the words before the call and the words after it. Adding one publishes the thread, so an open window gets it the way it gets a streamed reply. The message schema reads `visual` leniently and keeps `kind` a string, so a reader that cannot draw a visual shows its text. Sidebar summaries, search and generated titles skip visual messages and keep the agent's own words; the turn fold leaves visuals in view, and a turn's final reply is its last reply that is not a visual.

**Private.** A visual is made on this computer from what the agent sent and contacts no host: the card draws Mermaid through the same sandboxed renderer as an answer's diagram, as an `<img>`. Nothing about a visual is logged. Every socket client is sent visual messages without the `visual` field, so the iPhone, an older desktop and anything reading a host's threads get the words and the line saying the drawing is on the computer.

## Consequences

- The card (`VisualCard`) draws the steps in one component, `VisualReadAll`, so #793's walkthrough replaces it without touching the card, and the steps' highlight names are already kept.
- #794 adds the `interactive` kind to the input and to the card; a desktop on this version shows such a visual as its text.
- A new scoped server is one more list entry: it implements `ScopedThreadTools` and is passed to `useThreadTools`.
- Sotto has no thread deletion today. `ThreadStore.forget`, which a deletion would call, deletes a thread's visuals with its words.
