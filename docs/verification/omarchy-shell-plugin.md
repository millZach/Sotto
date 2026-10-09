# Omarchy shell plugin

October 9, 2026. Widget B for [#850](https://github.com/millZach/Sotto/issues/850), on `feat/linux-omarchy-shell-plugin` at `82869695`, branched from `main` at `6495c602`. Run on forge: Omarchy 4.0.4, Hyprland 0.56.2, Quickshell 0.3.1, Qt 6.11.2, an NVIDIA GPU. This run follows the review of `d0d31db8`, which asked for fixes first, and the contract addendum in the last comment on #850.

**VERIFIED: the plugin in an owned, nested copy of the Omarchy shell, installed by `install-shell-plugin.sh`; 71 checks passed.** The checks cover the bar glyph and its `toggle`, every dictation state, the four buttons and Dismiss, and drag and snap to all four edges with `place`. They cover a Stop and a Cancel that do not get through, Sotto quitting mid-dictation and under a kept recording, and a state file without `pid`. Rule A is checked on two displays, including a new dictation while the last one's result shows. An upright failure pill is checked on an 820x560 display and on a full-HD display at 200%. The rest are a bar on the left edge, Hyprland's animations off, Tokyo Night and Catppuccin Latte, installing with `XDG_CONFIG_HOME` pointing elsewhere, and `--uninstall` with and without the shell. Forge's live session stayed locked and received nothing: no key, click, shell IPC call or config write. Its `shell.json` and plugins folder were unchanged after every run, and no process outlived one.

**Not verified here.** Sotto itself. The state file's writer, its `pid`, the `retry`, `discard` and `place` verbs, saving the edge and hiding the Electron widget are the Sotto side of #850, which is not merged. Stand-in launchers record the verbs, and a stand-in process plays Sotto's main process; Sotto quitting is that stand-in killed with `SIGKILL`, not a real crash. Also not verified: tooltips, since the bar's shared tooltip does not draw in the nested session, for Omarchy's own Bluetooth icon either; a screen reader, since accessible names are set but were not heard; a physical mouse and two physical displays, since a virtual pointer and nested outputs stood in. Not tried: a replacement Omarchy bar (`kind: "bar"`) in place of the built-in one, where the glyph cannot reach the plugin's service and shows a failed command's notice itself.

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

`detail` is shown word for word. Without one, the plugin says "Transcription failed. Recording kept." or "Dictation failed. Nothing was kept." The holds after delivered and copied count from `since` and only stop a finished dictation from staying up if Sotto never writes idle. Dismiss hides that one failure in the plugin and runs nothing.

## Decisions worked out for this build

- **Upright on the side edges.** On the left and right edges the pill turns a quarter turn, as the Windows pill does and as Omarchy's bar does on a side edge. Its glyph stays upright and its words read top to bottom, so the pill keeps its thickness against the edge.
- **One full-screen, click-through surface per pill.** The shell's OSD and notifications draw this way: a layer-shell surface on the overlay layer that never takes keyboard focus. Its input region is the pill alone, so the compositor never stretches a surface while it changes size. While the pill is held, the whole surface takes the pointer, since Hyprland gives a held button's motion to whatever surface is under the pointer.
- **Snapping.** The pill snaps to the nearest edge of the area the bar leaves free, centred on that edge, `Style.gapsOut` (5 px) in. Ties go bottom, top, left, right, as `snapToEdge` does on Windows. P1 is therefore 26 + 5 px under a top bar. While dragging, a faint outline shows where it will land, drawn like the bar's own preview when it is moved to another edge. A drag's edge holds until the pill closes, or until Sotto reports an edge of its own.
- **Length.** The pill is never longer than its edge of the work area less 5 px at each end, in logical pixels. Its words take what the glyph and buttons leave, at most 470 px, room for about 60 characters. Words that do not fit are broken between sentences, up to three lines, so the pill grows thicker rather than longer. Sotto's copy is short sentences, and a line then reads as one thought.
- **Rule A, per dictation.** A new dictation is Sotto writing starting or listening under a new state and `since`, except listening right after the same dictation's start. Coalesced writes can hide the idle in between, so the plugin does not wait for one. A new dictation takes Hyprland's focused display and keeps it until it ends, even when the pill was already up for the last one's result. A pill that appears without one, such as a notice, takes the focused display too.
- **A command that does not get through never hides a dictation.** The pill keeps its state's buttons and says what did not get through and what to do:

  | Command | Notice |
  | --- | --- |
  | Stop, or the glyph while recording | Stop did not get through. Recording may still be running. Open Sotto to stop it. |
  | Cancel while recording | Cancel did not get through. Recording may still be running. Open Sotto to cancel it. |
  | Cancel while transcribing | Cancel did not get through. Open Sotto to cancel. |
  | Try again | Try again did not get through. Recording kept. Open Sotto to try again. |
  | Discard | Discard did not get through. Recording kept. Open Sotto to discard it. |
  | `place` | Sotto did not save this edge. Open Sotto and drag again. |
  | the glyph, otherwise | Sotto did not answer. Open Sotto and try again. Or, when the command cannot start: Could not run sotto. Check the command path. |

  A notice about a dictation on screen stays until Sotto writes another state or the user presses again. Only a notice with nothing behind it, or a failed `place`, lasts five seconds. Only a delivered or copied hold and Dismiss put a pill away.
- **Sotto quitting.** The state file has no heartbeat, so the plugin checks the process instead. While the file shows anything but idle and names `pid`, the plugin reads `/proc/<pid>/stat` with Quickshell's `FileView`, never a shell, when the file changes and every three seconds. A missing entry, or a process that has exited and not been reaped, means Sotto has gone. The dictation is put away and the pill says "Sotto quit. This dictation was lost. Open Sotto to dictate again.", "Sotto quit. The kept recording was lost. Open Sotto to dictate again." or, for a failure with nothing kept, "Sotto quit. Open Sotto to dictate again." Audio lives only in Sotto's memory, so a crash loses it. That notice goes up before the dictation is put away, so it stays on the display and surface the pill was already on. It has only Dismiss and stays until it is dismissed or Sotto writes again. A delivered or copied result goes quietly. A file without `pid`, from an older Sotto, is taken at its word.
- **Reduced motion.** Omarchy has no such setting. When Hyprland's `animations:enabled` is off, the level bars sit level and still, the track gives way to the word Transcribing alone, and the pill does not glide to its edge.
- **Words.** The bar glyph's tooltip says what a press does. While a recording is kept it says a press starts a new dictation and lets the kept recording go, which is what toggle does then (`CONTEXT.md`, Kept recording).
- **`Model.mjs`.** The rules are an ECMAScript module, which QML imports as one shared copy and which `eslint .` parses. `tests/unit/omarchy/shellPluginModel.test.ts` imports it in CI; `Model.d.mts` types it for that, and the installer leaves it out of the copy the shell loads.
- **Plugin folder.** Omarchy's `PluginRegistry` reads `$HOME/.config/omarchy/plugins/` and ignores `XDG_CONFIG_HOME`, so the script installs there and the addendum names that folder for Sotto too. The script mentions `XDG_CONFIG_HOME` only when the folder it names holds a copy of the plugin, which the shell never loads.
- **Uninstall.** The glyph comes off the bar first, through the running shell, and the folder goes only once `shell.json` no longer names it. Without a shell the script removes nothing, says so, and exits non-zero. It also takes off a glyph whose folder was deleted by hand.
- **Updates.** Omarchy 4.0.4 reloads a changed plugin folder, but keeps the QML and JavaScript it loaded first until the shell restarts. `install-shell-plugin.sh` says so after an update.

## The nested shell

```sh
scripts/verify-omarchy-shell-plugin.sh /tmp/sotto-shell-proof-out
```

It refuses a destination under `~/.config/omarchy`, `~/.config/hypr` or `~/.local/state/omarchy`, after resolving every link, before it writes anything. Nested Hyprland A runs as a window of the live session, found by reading the environment of the live session's own `quickshell`. The live session tiles that window, and no request goes to the live compositor to change it. So nested B runs inside A, and A floats B's displays at exact sizes: 1600x1000 and 1280x800, then 820x560 and 1920x1080 at 2x for the small-display scene. `hyprctl output create headless` cannot allocate its buffers on this NVIDIA GPU, so B's second display is a second nested Wayland output, still inside the instance this run owns.

The Omarchy shell runs in B with its own `HOME`, XDG folders, runtime folder and D-Bus session. The config is copied from forge with polkit, lock, idle and night light turned off. The theme is generated with Omarchy's own templates. The runtime folder is `/tmp/ssp-*`, because Hyprland's socket path must fit in 108 bytes. `omarchy-shell`, `omarchy bar` and `omarchy plugin` reach only that shell, since Quickshell finds instances through the runtime folder. A wlr virtual pointer (`scripts/omarchy-nested-pointer.c`) refuses any display but B's, and moves, clicks and drags there. Captures come from `grim` on B's outputs, with the pointer parked away from the pill. The pill's bounds are what differs from an idle capture of the same desktop.

Cleanup is armed before anything is made. Every process runs in one systemd slice and is recorded by the PID it started with. Each Hyprland instance folder is recorded by the PID in its lock, when hyprctl finds it and again at cleanup, so a compositor that fails discovery still has its folder found. After the slice stops, a process still in it or still running under a recorded PID fails the run. Only the recorded folders are removed, after their inode and lock are checked.

## Results

Every image below was opened and checked. Failure `detail` is the plumbing branch's own kept-failure sentences, which now end in "Recording kept."

[The desktop in Tokyo Night](../../artifacts/omarchy-shell-plugin/desktop-tokyo-night.png): two tiled terminals, Sotto's mark and timer in the bar beside the clock, and the listening pill at P1 over the tops of the windows. The left terminal shows the install's output, including its word about the copy under `XDG_CONFIG_HOME`. [The same in Catppuccin Latte](../../artifacts/omarchy-shell-plugin/desktop-catppuccin-latte.png), after `background themeTransition` repainted the running shell.

[Every state in Tokyo Night](../../artifacts/omarchy-shell-plugin/states-tokyo-night.png), top to bottom: idle, starting, listening, transcribing, delivered, copied, failed with the recording kept ("The transcription service is busy. Recording kept.", word for word), and failed with nothing kept, in the plugin's own words. Each pill is centred 31 px from the top. [Latte](../../artifacts/omarchy-shell-plugin/states-catppuccin-latte.png): idle, listening, transcribing, failed with the recording kept. Text is the theme's foreground on its background: #a9b1d6 on #1a1b26 in Tokyo Night and #4c4f69 on #eff1f5 in Latte, both above 7:1.

[A Stop that does not get through](../../artifacts/omarchy-shell-plugin/failed-stop-keeps-pill.png), top to bottom: listening; Stop pressed with a launcher that fails, and the pill keeps Stop and Cancel under "Stop did not get through. Recording may still be running. Open Sotto to stop it."; the same six seconds later, while the bar's timer runs on; Cancel pressed and refused too. Once the launcher worked again, Stop reached it.

[Sotto quits](../../artifacts/omarchy-shell-plugin/sotto-quit.png), top to bottom: listening while the stand-in named in `pid` runs; the stand-in killed, and within three and a half seconds "Sotto quit. This dictation was lost. Open Sotto to dictate again." with Dismiss, and the bar's glyph back at rest; a kept failure naming the dead process, shown as "Sotto quit. The kept recording was lost. Open Sotto to dictate again." with Dismiss rather than Try again; and a listening state without `pid`, still showing after four and a half seconds. Dismiss ran nothing.

[Drag and snap](../../artifacts/omarchy-shell-plugin/drag-and-snap.png), each row mid-drag and then released: to the left, to the bottom, to the right and back to the top. The pill lands at x = 5 on the left, 5 px above the bottom, at x = 1551 on the right and 31 px down at the top, centred each time. Each release ran `dictation place <edge>`. [A closer look mid-drag](../../artifacts/omarchy-shell-plugin/drag-ghost-left.png) shows the outline on the left edge and the grabbing hand. [The upright pill](../../artifacts/omarchy-shell-plugin/upright-left.png) has its mark upright and its timer and buttons reading top to bottom; its Stop and Cancel ran their verbs.

[An upright failure on small displays](../../artifacts/omarchy-shell-plugin/upright-small-displays.png), left at 820x560 and right at 1920x1080 at 200%, halved to its logical 960x540. The kept failure "Text could not be delivered. Recording kept. Open Sotto." breaks between its sentences, and the pill is 447 logical pixels long on both, centred beside the bar with Try again and Discard on screen. Discard was pressed on each and ran `dictation discard`.

[Rule A on two displays](../../artifacts/omarchy-shell-plugin/rule-a-two-displays.png), each row showing the 1600x1000 display, then the 1280x800 one. In the first row the pointer is on the second display when dictation starts, and the pill opens there only. In the second the pointer has moved back to the first display mid-dictation, which Hyprland now has focused, and the pill stays where it opened. In the third, the next dictation opens on the first display. [A new dictation while a copied result shows](../../artifacts/omarchy-shell-plugin/rule-a-after-copied.png): above, Copied on the first display, where its dictation started, with the pointer already on the second; below, the next dictation, started then, on the second display only. The same was checked with a kept failure in place of Copied, and with Sotto quitting mid-dictation after the pointer had moved: its notice stayed on the first display.

[A bar on the left](../../artifacts/omarchy-shell-plugin/bar-on-the-left.png): the top pill moves up to 5 px, centred on the area beside the bar. A left-edge pill sits at x = 33, clear of the 28 px bar. The glyph in the vertical bar shows no timer, as Omarchy's widgets drop their text there.

[Notices with nothing behind them](../../artifacts/omarchy-shell-plugin/notices.png): a click on the glyph with a command that does not exist, and a new dictation replacing that notice at once. [Without motion](../../artifacts/omarchy-shell-plugin/without-motion.png): listening with level, still bars, and transcribing without the track.

[The verbs the stand-ins received](../../artifacts/omarchy-shell-plugin/verbs-received.png), in order. The bar glyph's click reached the launcher named by `--command`, which the script saved in the widget's settings. Clicking Stop and Cancel left keyboard focus on the terminal that had it. The [proof log](../../artifacts/omarchy-shell-plugin/nested-proof.txt) records all 71 checks, the install and uninstall output, and the cleanup:

```text
PASS: 71 checks
no process outlived the proof
instance folders after cleanup: efb50993780079460b0cbed1363e2166a2de1d9f_1789793874_889692923
live shell.json unchanged
live plugins folder unchanged
```

The one folder left is the live session's. Uninstall without the shell said "Sotto's glyph is on the bar, and only a running Omarchy shell can take it off. Nothing was removed. Run this again in your desktop session." and left both in place.

## What Sotto's side must match

- Write `$XDG_RUNTIME_DIR/sotto/dictation-state.json` atomically, as schema v1, with `pid`: the main process's ID as a positive whole number, the process whose exit loses a kept recording. A missing file, a `version` other than 1 or an unknown `state` reads as idle, and unknown fields are ignored. Remove the file, or write idle, when Sotto quits or starts.
- `since` must change for each new dictation. The plugin reads a new dictation from starting or listening under a new state and `since`, except listening right after starting, so a dictation must not go back to starting after it has listened.
- For failed, `detail` says whether the recording was kept, in under 60 characters, and the plugin shows it word for word. Short sentences break best; the plugin puts line breaks only between them. Outside failed, the plugin uses its own words, so copied's `detail` is not shown.
- Exit 0 once a verb is accepted and non-zero otherwise. The plugin takes any non-zero exit as not got through and keeps the pill.
- `place <edge>` is sent after every drag, even to the edge already saved. Write the saved edge in `edge` from then on.
- Hide the Electron widget while `$HOME/.config/omarchy/plugins/sotto.dictation/` exists, ignoring `XDG_CONFIG_HOME`; that is the folder the shell reads. Install backups from `omarchy plugin remove` start with a dot and do not count.
