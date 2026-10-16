# OpenCode is a thread provider (#1108)

Zach asked on October 16, 2026 for OpenCode the way T3 Code has it, and chose: an Owl feature, OpenCode 2 only, a full provider as Muse is, his own OpenCode data folder shared, and variant C of `prototype/opencode-model-menu` (model source first). [ADR-0087](../adr/0087-opencode-is-a-thread-provider.md) governs behaviour; [the research note](../research/2026-10-16-t3-opencode.md) has the wire facts from T3 Code and from OpenCode 2.0.31.

## Tickets, in dependency order

1. **#1101 Let a sixth provider fit Sotto's provider lists.** Derive the provider-count caps from `providerIdSchema`, drop the duplicated enum in `agentSkills.ts`, make side writing and Sotto tools opt-in per provider, and have the browser and iPhone surfaces ask the shared predicate. No change for the five providers.
2. **#1102 Gate a held provider in one place.** One gate, keyed by provider and Owl feature, replaces Muse's hand-written checks. Muse's behaviour and tests unchanged.
3. **#1103 Add OpenCode 2 as an Owl thread provider.** The adapter over OpenCode's HTTP server and event stream, a fake OpenCode 2 server for the adapter contract, registration behind the gate, and the documents.
4. **#1104 Find and update OpenCode 2 like every other client.** Discovery, version floor, Settings controls, `opencode upgrade`, Update all.
5. **#1105 Open OpenCode's model menu on its model sources.** Variant C, the chip naming the source, OpenCode's mark and colour token, **Model source** in the glossary.
6. **#1106 Give OpenCode threads Sotto's tools and side writing.** MCP on the thread's own server; deny-all side writing that falls back when a free model refuses it.
7. **#1107 Run OpenCode threads on hosts and phones.** Host contracts, host tiles, and the phone clients' provider lists.

1 and 2 run side by side; 4, 5 and 6 run side by side once 3 has merged; 7 follows 3 and 4.

## Acceptance checks for the whole

- With OpenCode 2 installed and signed in on the Windows laptop, an Owl build offers OpenCode in Settings → Providers, lists its model sources and models, and runs a thread that streams, asks for a permission, asks a question, takes an image, is steered and stopped, and resumes after Sotto restarts.
- A stable build shows nothing of OpenCode and keeps its saved records.
- The same on a paired host (forge, with OpenCode 2 from Arch's `extra`), and from the iPhone.
- Light, dark and reduced motion at 1600x1000, 1280x800 and 820x560 for the menu and the Providers tile; the keyboard path through the model sources.
- Each ticket runs the four CI gates and the Playwright specs it touches, gets a two-axis review, and leaves a verification note where it changed what the running app shows.
