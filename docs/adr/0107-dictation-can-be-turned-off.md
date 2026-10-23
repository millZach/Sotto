# Dictation can be turned off

## Status

Accepted October 22, 2026, by the owner's choice. Builds on [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md), whose Owl features carry it, on [ADR-0071](0071-dictation-transcribes-on-this-computer-with-parakeet.md) and [ADR-0094](0094-dictation-runs-the-speech-model-the-user-chooses.md) for the **speech model**, and on [ADR-0097](0097-dictation-shortcuts-listen-for-held-keys.md) for the shortcuts and the **key listener**. **Number provisional until merge** (docs/agents/domain.md).

The owner asked for a switch in Settings that turns dictation off, for people who dictate with another app. The owner chose each of these when asked: the room switch of variant A in `design/dictation-off/mockup.html`, and the switch at the top of Settings › Dictation with the rest of dictation's settings hidden.

## Context

Dictation is always on. Main registers the dictation hotkey, may run the key listener, loads the chosen speech model and keeps it loaded, and shows the floating widget. Someone who dictates with another app pays for all of it: the hotkey is taken from that app, the model holds memory, and the Dictate room and the widget sit there unused.

## Decision

**1. One setting, in Owl.** `dictationEnabled`, saved with the other settings and on by default. It is the Owl feature `dictation-off`. In stable the switch does not exist and dictation is always on; a saved `dictationEnabled: false` stays saved and is ignored. Dictation is on when the feature is off or the setting is on (`dictationOn` in `src/shared/settings.ts`).

**2. Off, main stops what dictation costs.** With dictation off:

- the dictation hotkey and the other press shortcuts are not registered, hold shortcuts are not watched and the key listener does not run;
- the speech model is not loaded, downloaded or warmed, and a loaded one is let go;
- the floating widget is not shown, and the tray has no dictation item;
- setup and start do not ask for the microphone for dictation;
- a recording is refused, from any source. One under way when dictation goes off ends unsaved, since no shortcut could stop it any more; a dictation already being transcribed finishes, and a kept recording stays kept for when dictation is back on. Requests for the microphone are answered no without asking. On Linux that includes `sotto dictation toggle` and the other commands Hyprland's **compositor bindings** run. Sotto leaves those keys as they are, so they still reach Sotto and do nothing.

**3. Off keeps what the user made.** Transcripts, **dictation records**, the personal dictionary, the downloaded model files and the saved shortcuts stay. Turning dictation back on registers the shortcuts, loads the chosen model and brings the widget and the room back, without a restart.

**4. The room switch drops Dictate.** Off, the switch reads owl | Threads, variant A of the mock-up: the owl keeps its fixed tab and Threads takes the rest. When only Threads would remain, outside Owl's Watcher gate, no switch is drawn. The Dictate room is hidden.

**5. Settings puts the switch first.** "Dictate with Sotto" is the first row of Settings › Dictation, with the line "Turn off if you use another dictation app. Sotto stops listening for the hotkey and unloads the speech model." Off, every other Dictation row hides and a short note under the switch says what off means. The Transcription and Output sections leave the settings list and do not render. Cleanup stays for the thread drafting switches (generated titles, commit messages and pull request text), without its dictation rows.

## Considered options

- **Dim the other rows instead of hiding them.** Shows settings that do nothing while dictation is off. Rejected by the owner.
- **A switch under Settings › Application.** Puts it away from the settings it turns off. Rejected by the owner.
- **Keep the hotkey but ignore it.** The point is to free the hotkey for the other app. Rejected.
- **Rewrite Linux's compositor bindings when dictation goes off.** Would rewrite Hyprland's configuration for a setting that can flip back. Main refuses the command instead.

## Consequences

Main reads the Owl feature once at start and the setting on each change; the update path copies no state. Someone with dictation off sees no Dictate room, so transcripts saved before stay out of sight until dictation is on again. On Linux, Sotto's keys still belong to Sotto while dictation is off; the user removes them from the Omarchy block if another app needs them.
