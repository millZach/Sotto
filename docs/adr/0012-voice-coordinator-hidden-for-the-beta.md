# The voice coordinator is hidden for the beta

Accepted September 18, 2026 for the Threads page redesign. The beta ships the threads and terminals the user works in every day, and it ships dictation, which is what Sotto is known for. It does not ship the voice coordinator: "Hey Sotto", the Agents room it answers in, the spoken hints and the management it offers to run a thread on the user's behalf. Wake detection depends on a phonetic model whose distribution licence is unresolved, spoken supervision is the least finished part of the product, and a control that cannot be relied on is worse than a control that is not there.

## Context

Voice reaches almost everywhere. The wake session lives in the agent provider, the Agents room is one half of the main window's switch, the floating widget carries microphone and speech buttons, Settings has a whole voice panel behind the Agents section, a personal chat can be talked to instead of typed in, and every thread offers Manage, Pause managing and Stop managing. Deleting that would be weeks of work to undo, and it would take the coordinator's own tests with it. Leaving it visible would make the beta's first impression a feature that half works.

## Decision

One setting decides: `voiceCoordinatorEnabled` in `src/shared/settings.ts`, a boolean that defaults to false. The renderer reads it through `useVoiceCoordinatorEnabled()` in `src/renderer/src/state/voiceCoordinator.ts`, which is a hook over the app context rather than a second copy of the setting.

While it is false the wake phrase is never listened for, because `AgentProvider` requires the flag before it starts the voice session; no announcement is spoken, because the same provider tracks each announcement's identifier but voices none of it; the Agents room and the switch position that reaches it are gone, so the room becomes unreachable code rather than edited code; the floating widget's microphone, speech and thread controls are gone, because the widget runs in its own renderer and is told through a `voiceCoordinator` field on the widget snapshot; Settings shows the Agents section with its reasoning account and projects but no voice panel and no advanced wake settings; a personal chat keeps Dictate and loses Talk, mute and the reply voice; and every Manage, Pause managing, Resume managing and Stop managing control is absent from the Threads page. Dictation is untouched throughout: it has its own microphone path and never asked the coordinator for anything.

Nothing is deleted. Every surface is gated, and the setting turning back on restores all of it. The tests that cover voice still run; they pass settings with the flag on, and each gated surface also has a test proving it is absent with the flag off.

Because the Agents room is unreachable, Threads is the page the application opens on, and the switch now reads Dictate | Threads rather than Dictate | Agents. Threads lights for the threads, chats and memory pages, which are the pages a thread's work leads to.

## Considered Options

- **Deleting the coordinator and restoring it later.** The restore would be a rewrite, and the wake session, the widget controls and the spoken review are all worth keeping. A flag costs one boolean and one hook.
- **Shipping voice as it stands.** Wake detection needs a model Sotto cannot distribute, so most users would meet the feature as an error message.
- **Reading the setting directly at each surface.** Nine surfaces reading `settings.voiceCoordinatorEnabled` by hand is nine chances to read it differently. The hook is the one answer, and the widget's snapshot field is its only other form because the widget has no settings to read.

## Consequences

Anything new that speaks, listens or hands work to Sotto has to ask the hook, or it will appear in a beta that promises no voice. The widget snapshot's `voiceCoordinator` field is optional at the boundary, so a publication that predates the flag reads as off; that is the safe direction, but it means an omitted field silently hides the controls rather than failing. The Agents room keeps its own tests and its own code while nothing renders it, so a change there is unverified in the running app until the flag goes back on.
