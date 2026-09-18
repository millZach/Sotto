# Memory is hidden for the beta

Accepted September 18, 2026, alongside the Threads page redesign. The first beta ships without memory: no Memory page, no questionnaire greeting the Agents room, and no remembered preferences folded into an agent's turn. The store, the inspector, the questionnaire and their tests stay in the tree, switched off.

## Context

Memory reaches three places. The Memory page is one of the page links in the sidebar foot and the app footer. The questionnaire greets the Agents room the first time it opens and can be requested again from the Memory page. And every agent turn, threaded or personal, retrieves preferences from the store and adds them to its context. Shipping any one of those without the others would show a half feature, and the beta's promise is threads, terminals and dictation.

## Decision

One setting decides: `memoryEnabled` in `src/shared/settings.ts`, a boolean that defaults to false, gated the same way as the voice coordinator (ADR-0012). The renderer reads it through `useMemoryEnabled()` in `src/renderer/src/state/memoryFeature.ts`.

While it is false the Memory link is absent from the sidebar foot and the footer, the Memory address shows the Threads page, the memory surface that would greet the Agents room with the questionnaire is not mounted, and the main process reads the setting once at start and hands neither the agent control nor the personal chats a preferences source, so no turn retrieves memories. The memory store still opens and its IPC stays registered, so a profile that already holds memories keeps them for the day the setting turns on.

Nothing is deleted. The end-to-end specs that cover memory seed the setting through the same helper that seeds the voice coordinator, because the questionnaire's home is the Agents room.

## Consequences

Anything new that reads or writes memory has to ask the hook, or it will appear in a beta that promises none. The main process gate is read at start, like the coordinator's, so flipping the setting takes effect on the next launch; the setting has no control in Settings for the beta and is edited in `settings.json`.
