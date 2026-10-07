# A visualize tool for threads

An agent in a project thread calls `visualize` to show how something works. Sotto draws the visual in the thread itself, with steps that walk through it one part at a time. Claude Code, Codex and Grok Build get the tool; Devin does not (its client ignores supplied MCP servers, ADR-0020, ADR-0035), and threads on a remote host do not (a host runs no Sotto tool servers).

## Decisions with Zach (2026-10-06)

- **Kinds.** A diagram is Mermaid source drawn through the existing safe renderer (`src/renderer/src/agents/diagrams/`). An interactive visual is an agent's HTML page in a sandbox that never reaches the network.
- **Kept with the thread.** A visual is back after a restart. It follows Keep local history, a confirmed rewind and deleting the thread the way messages do. The iPhone shows its explanation with a line saying the visual is on the computer.
- **On by default**, with a Settings switch. No permission prompt: drawing in the thread changes nothing outside it.
- **Agents decide** when a visual helps (a flow, an architecture, a state machine, a sequence), and use it when asked.
- **Walkthrough layout.** Of three variants (card, side by side, walkthrough), Zach picked the walkthrough as the clearest. The prototype is on the `prototype/visualize-layout` branch. The card has a header (title, kind, Show source, Copy source, Expand, Read all), the visual, then "Step n of N", progress dots, Back and Next ("Start over" on the last step) and the current step's text. The active step's part of the visual is lit and the rest dimmed. Arrow keys step while focus is in the stepper. Read all swaps the stepper for the intro and the numbered list. A visual with no steps shows the visual and its intro.

## Architecture

1. **One server, one tool.** `sotto_visual` (handshake `sotto-visual`) with the tool `visualize`, a `ScopedThreadTools` over `ThreadToolServer` shaped like `HostSetupToolServer` (`src/main/hosts/hostSetupTools.ts`).
2. **A list of tool servers.** The single host-setup slot (`useHostSetupTools` in `host.ts`, `workspace.ts`, `providerSwitch.ts`, `threads.ts`, `inactiveLocalHost.ts`) becomes `useThreadTools(ScopedThreadTools[])`, so a server is a list entry rather than seven methods.
3. **Shared checks.** `src/shared/visuals.ts` holds the zod input, limits and the plain-text version of a visual. `diagramSource.ts` moves to `src/shared` (it imports nothing) so main runs the same source checks.
4. **Own table, not a thread event.** A `visuals` table in threads.sqlite (a migration), anchored to the newest message and newest user message in the projection when the call arrives. A thread event would not survive: every `messages-reset` rebuilds the projection from the provider's own history (`threadStore.ts` ~568), and Grok resets by itself when it coalesces streamed history (`grok.ts` ~683).
5. **Delivered as a message.** The workspace slots each visual into the loaded window as an assistant message with id `visual:<id>`, an optional `visual` field and a markdown `text`: title, intro, numbered steps and "The visual is in Sotto on your computer." Older desktops drop the unknown field and show the text; the socket strips `visual` for every client, so the iPhone shows the text.
6. **Placement.** All three providers end a reply at a tool call (Claude's next API message, Codex's next `agentMessage` item, Grok's next chunk id), so anchoring to the newest stored message puts the card between the words before the call and the words after it. If the anchor is outside the window the card goes at the end of its turn, or is left out.
7. **Privacy follows the store.** With history off the store is in memory; `forget` and `redactAll` delete the rows; an accepted rewind deletes the rows for the turns it removes. Grok's own resets delete nothing.
8. **Out of summaries.** `summarizeThread` (sidebar rows, search) and generated titles skip visual messages, so they keep the agent's own words. The turn fold leaves visuals out, and "final reply" means the last reply that is not a visual.
9. **Diagram steps** render Mermaid once and light each step by editing the sanitized SVG (marking targets, dimming the rest), still shown as an `<img>`. Targets: flowchart node ids, subgraph ids and `A->B` edges; state ids; class and entity names; for sequence diagrams participant names and arrow numbers from 1. Unknown names are ignored; a step that matches nothing leaves the drawing lit.
10. **Interactive pages** are served on a `sotto-visual:` scheme. An iframe shares the main window's session, and no CSP directive covers WebRTC, so the containment is decided by a spike: a guest webContents on an in-memory partition with every request but the page cancelled, permissions denied, a proxy that answers nothing and WebRTC limited to it; or an iframe if a per-webContents switch can remove WebRTC. Steps and theme reach the page by message; height is measured by Sotto and clamped. Decided in ADR-0056: a `<webview>` guest on an in-memory session, tested with ordinary loads only.
11. **No provider prompts.** Claude's `--allowedTools`, Codex's `default_tools_approval_mode: 'approve'`, and Grok's one-time question answered for the server by name, as for the browser and host setup tools.
12. **Switch** `visualsInThreads`, read live. Off: new launches get no server, running sessions' calls are refused, visuals already in threads stay.

## Tool contract

- Input (strict): `title` 1-120 characters; `kind` `diagram` (and `interactive` from ticket 3); `source` up to 12,000 characters passing the diagram source checks (interactive: up to 60,000); `intro` up to 2,000; `steps` up to 12 of `{ text: 1-1,000, highlight?: up to 12 names }`, or of sentences alone (a live Codex turn sent its steps that way). The visual server takes requests up to 512 KiB, which fits the worst case with interactive sources; the browser and host setup servers keep 128 KiB.
- Main checks the schema, the source checks, the thread, the switch, at most 6 visuals per turn and 100 per thread, and that history can be written. Only the renderer learns of a Mermaid syntax error or which highlight names matched; the card then shows the source with the reason and keeps the steps readable.
- Every refusal says what happened and that nothing was drawn.

## Tickets

1. **Visuals reach the thread.** The server, the tool, the list refactor, shared checks, the table and its privacy handling, delivery and placement, the three providers, the switch, a card with the diagram and Read all layout, ADR, CONTEXT.md, guide and agent-control docs.
2. **Walk through a visual step by step.** The stepper, Read all switching, SVG highlighting per diagram type, highlighting in Expand, reduced motion, design captures.
3. **Interactive visuals.** The containment spike, the `interactive` kind, the bridge (steps, theme, height), the safety spec, its own ADR.
