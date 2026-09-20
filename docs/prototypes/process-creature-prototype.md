# Background process creature prototype

Question: How should a little pixel creature with a magnifying glass walk along the thread composer's top edge while an agent monitors a background process?

Desktop target inherited from Sotto. Throwaway visual study with synthetic thread content, no provider calls and no persistence. Three variants share the thread view: A patrols the whole edge; B inspects a short stretch beside the status; C walks to a small process readout on the edge. Zach selected C, The process perch.

Acceptance checks:
- Preserve Sotto's thin strip, Figtree, quiet room, sidebar and rounded composer. Reference: current composer CSS, ADR-0011 and the existing effort-slider mock-up.
- The pixel creature and readable magnifying glass are the focal change. Feet touch the composer edge, including turns and inspection pauses. No covering typed text or controls.
- Use theme roles for every color; check dark and light, readable text, and desktop sizes 1600x1000, 1280x800 and 820x560.
- Choreograph walking, stopping, looking through the glass and resuming. Reduced motion holds a readable inspection pose. Simulated completion and attention stop patrol.
- Floating bottom switcher updates ?variant=A/B/C, wraps with buttons and arrow keys, and leaves textarea arrow keys alone. Show current simulated state.
- Keep the existing thread context; the five-element copy budget applies to added presentation copy, not the required host UI. No marketing text or extra cards.
- Inspect all variants, motion extremes, keyboard controls, light and reduced motion in the browser. Record evidence before handoff.

Approved direction: C, The process perch. Archive to a throwaway branch when the decision is made; do not promote this code into the app.


Monitoring trigger refinement (September 20, 2026): the creature is for an agent actively monitoring a background task, not general command execution or a busy thread. Following the T3 source study, Zach approved removing the provisional 10-second delay. Require both verified background-task identity and confirmed active monitoring of that task; show C immediately when those facts hold. Ordinary quick commands never show it. A genuinely confirmed short watch can appear, and hides as soon as it ends. A long foreground command and an unattended server never qualify. Hide immediately on completion, interruption, attention, loss of monitoring or loss of reliable evidence. Repeated updates for the same monitored task must not replay its entrance. Elapsed command time does not establish eligibility. Unknown evidence stays hidden. The prototype uses explicit synthetic facts for these cases.

Implementation gap: src/shared/agentActivity.ts has running status and timing but no explicit monitoring relationship. CodexActivityProjection currently retains command display fields, not a background-process monitoring link. ClaudeActivity handles shell task notifications, but task_started also includes ordinary shell work and ambient watchers. Neither generic running status nor task_started is a sufficient trigger. Production needs verified provider-specific signals projected to a shared observation before this UI can be wired. Do not infer monitoring from assistant text or run an LLM to classify it. No production adapter or schema changes are part of this preview.


Accepted lifecycle rule: live background task + confirmed active monitoring = visible; completed, stopped, attention, unconfirmed monitoring or agent moved on = hidden. No time buffer. A short confirmed watch is deliberately included in the prototype so its behavior is reviewable. This adopts T3's lifecycle approach, not its broad surviving-shell heuristic or post-turn-only visibility. Research: [T3 monitoring source study](../research/2026-09-20-t3-monitoring-popup.md).

Final prototype approval: Zach confirmed that C and the revised monitoring-only behavior look good on September 20, 2026. Keep immediate appearance on confirmed active monitoring, no fixed delay, and immediate hiding when monitoring ends. Ordinary commands, unattended processes, and unknown monitoring states remain excluded. Production integration is not yet implemented.
