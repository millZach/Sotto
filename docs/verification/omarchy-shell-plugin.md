# Omarchy shell plugin

October 9, 2026. Widget B for [#850](https://github.com/millZach/Sotto/issues/850), on `feat/linux-omarchy-shell-plugin` at `e92ede7f`, branched from `main` at `6495c602`. Run on forge: Omarchy 4.0.4, Hyprland 0.56.2, Quickshell 0.3.1, Qt 6.11.2, an NVIDIA GPU.

**VERIFIED: the plugin in an owned, nested copy of the Omarchy shell, installed by `install-shell-plugin.sh`; 50 checks passed.** The checks cover the bar glyph and its `toggle`, every dictation state, the four buttons and Dismiss, and drag and snap to all four edges with `place`. They also cover failure notices, rule A on two displays, a bar on the left edge, Hyprland's animations off, Tokyo Night and Catppuccin Latte, and `--uninstall`. Forge's live session stayed locked and received nothing: no key, click, shell IPC call or config write. Its `shell.json` and plugins folder were unchanged after every run.

**Not verified here.** Sotto itself: the state file's writer, the `retry`, `discard` and `place` verbs, saving the edge and hiding the Electron widget are the Sotto side of #850, built in parallel; stand-in launchers record the verbs instead. Also not verified: tooltips, since the bar's shared tooltip does not draw in the nested session, for Omarchy's own Bluetooth icon either; a screen reader, since accessible names are set but were not heard; a physical mouse and two physical displays, since a virtual pointer and nested outputs stood in. Not tried: a replacement Omarchy bar (`kind: "bar"`) in place of the built-in one, where the glyph cannot reach the plugin's service and shows a failed command's notice itself.

## What the plugin does

`apps/omarchy/shell-plugin/sotto.dictation/` is a service plus a bar widget in Omarchy's manifest format. The service follows `$XDG_RUNTIME_DIR/sotto/dictation-state.json` and owns the pill. The widget is the glyph. Both run `<command> dictation <verb>` as a process with its own arguments. `<command>` is the widget's `command` setting, `sotto` by default.

| State | Bar glyph | Pill |
| --- | --- | --- |
| idle, or no file | Sotto's mark | none |
| starting | mark in the theme's urgent colour | mark, still level bars, `00:00`, Stop, Cancel |
| listening | mark and timer in urgent | mark, moving level bars, timer, Stop, Cancel |
| transcribing | hourglass | hourglass, travelling track, Transcribing, Cancel |
| delivered | check | Pasted, for 1.5 s |
| copied | copy | Copied, paste with Super+V, for 4 s |
| failed, kept | Try again's arrow in urgent | arrow, `detail`, Try again, Discard |
| failed, nothing kept | alert in urgent | alert, `detail`, Dismiss |

The holds after delivered and copied count from `since` and only stop a finished dictation from staying up if Sotto never writes idle. Dismiss hides that one failure in the plugin and runs nothing.

## Decisions worked out for this build

- **Upright on the side edges.** On the left and right edges the pill turns a quarter turn, as the Windows pill does and as Omarchy's bar does on a side edge. Its glyph stays upright and its words read top to bottom, so the pill keeps its 44 px thickness against the edge.
- **One full-screen, click-through surface per pill.** The shell's OSD and notifications draw this way: a layer-shell surface on the overlay layer that never takes keyboard focus. Its input region is the pill alone, so the compositor never stretches a surface while it changes size. This replaces the prototype's sketch of changing the surface's margins. While the pill is held, the whole surface takes the pointer. Hyprland gives a held button's motion to whatever surface is under the pointer, and the first run showed a quick drag slipping off the pill.
- **Snapping.** The pill snaps to the nearest edge of the area the bar leaves free, centred on that edge, `Style.gapsOut` (5 px) in. Ties go bottom, top, left, right, as `snapToEdge` does on Windows. P1 is therefore 26 + 5 px under a top bar. While dragging, a faint outline shows where it will land, drawn like the bar's own preview when it is moved to another edge. A drag's edge holds until the pill closes, or until Sotto reports an edge of its own.
- **Rule A.** The display is Hyprland's focused monitor at the moment the pill opens, and it is kept until the pill closes.
- **Notices.** A command that cannot start says "Could not run sotto. Check the command path." One Sotto does not take says "Sotto did not answer. Open Sotto and try again." and then puts that dictation's pill away, since nothing is there to finish it. A failed `place` says the edge was not saved and keeps the dictation. A notice lasts five seconds or until Sotto moves to another state.
- **Reduced motion.** Omarchy has no such setting. When Hyprland's `animations:enabled` is off, the level bars sit level and still, the track gives way to the word Transcribing alone, and the pill does not glide to its edge.
- **Words.** The bar glyph's tooltip says what a press does. While a recording is kept it says a press starts a new dictation and lets the kept recording go, which is what toggle does then (`CONTEXT.md`, Kept recording).
- **`Model.mjs`.** The rules are an ECMAScript module, which QML imports as one shared copy and which `eslint .` parses. It was checked with the repository's rule sets.
- **Plugin folder.** The shell and `omarchy plugin` read `$HOME/.config/omarchy/plugins/`, so the script installs there. That equals `$XDG_CONFIG_HOME/omarchy/plugins/` on Omarchy, whose session sets `XDG_CONFIG_HOME=$HOME/.config`.
- **Updates.** Omarchy 4.0.4 reloads a changed plugin folder, but the run showed it keeps the QML and JavaScript it loaded first until the shell restarts. `install-shell-plugin.sh` says so after an update.

## The nested shell

```sh
scripts/verify-omarchy-shell-plugin.sh /tmp/sotto-shell-proof-out
```

Nested Hyprland A runs as a window of the live session, found by reading the environment of the live session's own `quickshell`. The live session tiles that window, and no request goes to the live compositor to change it. So nested B runs inside A, and A floats B's two displays at 1600x1000 and 1280x800. `hyprctl output create headless` was tried first: on this NVIDIA GPU a headless output cannot allocate its buffers (`GBM: Failed to allocate a GBM buffer`), so B's second display is a second nested Wayland output, still inside the instance this run owns.

The Omarchy shell runs in B with its own `HOME`, XDG folders, runtime folder and D-Bus session. The config is copied from forge with polkit, lock, idle and night light turned off. The theme is generated with Omarchy's own templates. The runtime folder is `/tmp/ssp-*`, because Hyprland's socket path must fit in 108 bytes. `omarchy-shell`, `omarchy bar` and `omarchy plugin` reach only that shell, since Quickshell finds instances through the runtime folder. A wlr virtual pointer (`scripts/omarchy-nested-pointer.c`) refuses any display but B's, and moves, clicks and drags there. Captures come from `grim` on B's outputs, with the pointer parked in a corner. The pill's bounds are what differs from an idle capture of the same desktop. Every process runs in one systemd slice that is stopped at the end, and only the Hyprland runtime folders this run made are removed, after their inode and lock PID are checked.

## Results

Every image below was opened and checked. The failures written use Sotto's own sentences from the plumbing branch (`dictationStateFile.ts`), its longest among them.

[The desktop in Tokyo Night](../../artifacts/omarchy-shell-plugin/desktop-tokyo-night.png): two tiled terminals, Sotto's mark and timer in the bar beside the clock, and the listening pill at P1 over the tops of the windows. [The same in Catppuccin Latte](../../artifacts/omarchy-shell-plugin/desktop-catppuccin-latte.png), after `background themeTransition` repainted the running shell.

[Every state in Tokyo Night](../../artifacts/omarchy-shell-plugin/states-tokyo-night.png), top to bottom: idle, starting, listening, transcribing, delivered, copied, failed with the recording kept ("OpenRouter has no credit left. Add credit, then try again.", 58 characters, shown whole), failed with nothing kept. Each pill is centred 31 px from the top. [Latte](../../artifacts/omarchy-shell-plugin/states-catppuccin-latte.png): idle, listening, transcribing, failed with the recording kept. Text is the theme's foreground on its background: #a9b1d6 on #1a1b26 in Tokyo Night and #4c4f69 on #eff1f5 in Latte, both above 7:1.

[Drag and snap](../../artifacts/omarchy-shell-plugin/drag-and-snap.png), each row mid-drag and then released: to the left, to the bottom, to the right and back to the top. The pill lands at x = 5 on the left, 5 px above the bottom, at x = 1551 on the right and 31 px down at the top, centred each time. Each release ran `dictation place <edge>`. [A closer look mid-drag](../../artifacts/omarchy-shell-plugin/drag-ghost-left.png) shows the outline on the left edge and the grabbing hand. [The upright pill](../../artifacts/omarchy-shell-plugin/upright-left.png) has its mark upright and its timer and buttons reading top to bottom; its Stop and Cancel ran their verbs.

[Rule A on two displays](../../artifacts/omarchy-shell-plugin/rule-a-two-displays.png), each row showing the 1600x1000 display, then the 1280x800 one. In the first row the pointer is on the second display when dictation starts, and the pill opens there only. In the second the pointer has moved back to the first display mid-dictation, which Hyprland now has focused, and the pill stays where it opened. In the third, the next dictation opens on the first display. Both bars show the glyph and timer throughout.

[A bar on the left](../../artifacts/omarchy-shell-plugin/bar-on-the-left.png): the top pill moves up to 5 px, centred on the area beside the bar. A left-edge pill sits at x = 33, clear of the 28 px bar. The glyph in the vertical bar shows no timer, as Omarchy's widgets drop their text there.

[Notices](../../artifacts/omarchy-shell-plugin/notices.png), top to bottom: a click on the glyph with a command that does not exist; a new dictation replacing that notice at once; Stop answered by a failing stand-in; the pill gone five seconds later. [Without motion](../../artifacts/omarchy-shell-plugin/without-motion.png): listening with level, still bars, and transcribing without the track.

[The verbs the stand-ins received](../../artifacts/omarchy-shell-plugin/verbs-received.png), in order. The bar glyph's click reached the launcher named by `--command`, which the script saved in the widget's settings. Clicking Stop and Cancel left keyboard focus on the terminal that had it. The [proof log](../../artifacts/omarchy-shell-plugin/nested-proof.txt) records all 50 checks, the install and uninstall output, and the cleanup:

```text
PASS: 50 checks
processes left in the proof slice: []
note: efb50993780079460b0cbed1363e2166a2de1d9f_1791560999_344366579, not this proof's, changed meanwhile
instance folders after cleanup: efb50993780079460b0cbed1363e2166a2de1d9f_1789793874_889692923
live shell.json unchanged
live plugins folder unchanged
```

The one folder left is the live session's. Other agents ran their own nested proofs on forge at the same time; the note is one of their instance folders going away during this run, left alone. `--uninstall` checked `shell.json` afterwards and said "Its glyph is off the bar."

## What Sotto's side must match

- Write `$XDG_RUNTIME_DIR/sotto/dictation-state.json` atomically, as schema v1. A missing file, a `version` other than 1 or an unknown `state` reads as idle. `since` must change for each new dictation, since the plugin tells dictations apart by `state` and `since`. Remove the file, or write idle, when Sotto quits or starts, so a crash cannot leave a pill up.
- `detail` is shown only in the failed state, word for word, as the pill's whole sentence. The plumbing branch's sentences say what happened and what to do, and fit. For a kept recording the pill's Try again and Discard show it is kept, but the words do not say so; the prototype read "Could not reach OpenRouter. Recording kept." The pill cuts a sentence off past about 60 characters at Omarchy's default text size. Without a `detail`, the plugin says "Transcription failed. Recording kept." or "Dictation failed. Nothing was kept."
- Exit 0 once a verb is accepted and non-zero otherwise. The plugin treats any non-zero exit as Sotto not answering.
- `place <edge>` is sent after every drag, even to the edge already saved. Write the saved edge in `edge` from then on.
- Hide the Electron widget while `$HOME/.config/omarchy/plugins/sotto.dictation/` exists; that path is the one the shell reads. Install backups from `omarchy plugin remove` start with a dot and do not count.
