# Dictation shortcuts listen for held keys

## Status

Accepted October 19, 2026, by the owner's choice. Builds on [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md), whose Owl features carry most of it, and on [ADR-0062](0062-the-desktop-app-runs-on-linux-omarchy-first.md): Linux keeps its **compositor bindings**, which since October 20, 2026 the same rows write (decision 9). It amends ADR-0062's consequence that the hotkey setting means something different on Linux. **Number provisional until merge** (docs/agents/domain.md).

The owner found the dictation shortcut setting messy and broken on a Mac, and asked for Willow's flow in Sotto's design: one shortcut held to talk, one pressed to start and stop, each a row of key chips that can be changed, added and removed. The owner chose each of these when asked: all of Willow (hold shortcuts, Fn on a Mac, several shortcuts per row); the look of variant C (Compact) from the mock-up; the release split below; and Fn and Ctrl+Win as the hold default for new installs.

## Context

Settings showed the shortcut as a text field that saved only when it lost focus. Enter did nothing, closing Settings lost the edit, the keys had to be typed as words, glyphs without "+" did not parse and Fn was refused. On a Mac that left most people unable to change it.

Electron's global shortcut fires once on key-down. It never says when a key goes up, so it cannot run a shortcut that talks while held, and it cannot see Fn at all. Holding a shortcut, and Fn, need a listener of Sotto's own.

## Decision

**1. Two kinds of shortcut, recorded by pressing them.** A **press shortcut** starts dictation and, pressed again, finishes it. A **hold shortcut** starts dictation while its keys are down and finishes when they go up. Settings › Dictation shows them as two rows, "Hold to dictate" and "Press to start and stop", each with up to four shortcuts. Pressing a shortcut records new keys: hold them, then let go to save; Esc or clicking away cancels. Settings suspends every dictation shortcut while it records.

**2. The release is split.** The recorder for today's single start/stop shortcut goes straight to stable, because it fixes the Mac. Hold shortcuts, Fn and extra shortcuts are the Owl feature `dictation-hold-shortcuts`. With it off, Settings shows only the press row with its one shortcut, with no + Add and no ×; the key listener never starts; and saved hold and extra shortcuts stay whole for a run where the feature is on.

**3. The main press shortcut always works without the listener.** The first press shortcut is the `hotkey` setting, registered through Electron as before. It must have a key besides Fn and modifiers. Fn and modifier-only chords may be extra press shortcuts or hold shortcuts only. The press row is never empty: removing the main shortcut promotes the first extra that Electron can register, and when there is none the main shortcut has no ×. A saved `hotkey` from an older version is never rewritten or refused while it is unchanged, and chords are compared as sets of keys, not as strings.

**4. New installs hold Fn on macOS and Ctrl+Win on Windows.** The press default stays `Control+Shift+Space` on macOS and `Ctrl+Shift+Space` on Windows. Existing installs keep what they saved and get no hold shortcut. The hold default acts only while the Owl feature is on. Linux holds F9, for new and existing installs alike (decision 9).

**5. A native key listener, with no new npm dependency.** On macOS it is a small Swift helper with a listen-only `CGEventTap` on key-down, key-up and modifier changes, which reads Fn from its own modifier event. It is built with `swiftc`, signed ad hoc and bundled as `sotto-key-listener` in the app's resources. On Windows it is a C# file, `native/key-listener/win32.cs`, that PowerShell compiles with `Add-Type` and that installs a `WH_KEYBOARD_LL` hook. Main spawns either one directly and talks to it over a line protocol on stdin and stdout.

**6. macOS needs Input Monitoring, not Accessibility.** A listen-only tap asks only for Input Monitoring. Settings says so beside the rows when a shortcut needs the listener and the grant is missing, and offers Open System Settings. Shortcuts that need the listener look dimmed until it is granted. Windows asks for nothing.

**7. The listener reports only what a shortcut needs, and keeps nothing.** It reports every modifier going down and up. It reports any other key only while a modifier is down: by name if a shortcut uses it, otherwise as an anonymous "other key". A shortcut's F1 to F24 key is reported on its own. A key's release is reported only if its press was. Synthetic keys are ignored. Only while Settings records new keys, with Sotto's own page holding the keyboard, does it name every key: main refuses a recording while the window is behind another app or a site in the in-app browser or the cloud iPhone has the keys, ends one when the window loses the focus, hides or minimises, or the screen locks or the computer sleeps, and lets at most ten recordings a minute reach this mode; past that the page records, which hears only Sotto's window. A key outside the shortcut table ends the recording with a plain refusal rather than leaving the modifiers alone. Nothing it sees is logged, saved or sent.

**8. It runs only when it is needed.** Main starts it when a hold shortcut, an Fn shortcut, a modifier-only shortcut or a recording needs it, and stops it when none does. It never runs on Linux, in stable, or with the Owl feature off. When it stops unexpectedly main restarts it up to three times a minute, then gives up and logs that it did.

**9. On Linux the same rows write Hyprland bindings.** Amended October 20, 2026, by the owner's choice: Linux gets the recorder too, with the keys Omarchy names. Wayland gives Sotto no global key grab, so the keys stay **compositor bindings** (ADR-0062), and Sotto writes them.

- **The rows are the same.** Stable shows the press row with its one shortcut; the hold row, extra shortcuts, × and + Add come with `dictation-hold-shortcuts`, as on the other platforms. There is no Fn and no key listener on Linux: Hyprland holds any chord, so a hold needs no helper.
- **The defaults do not move.** Linux holds F9 and presses Super+Ctrl+X, the keys its bindings have always had. A Linux profile saved before `holdShortcuts` existed reads as those two, whatever its `hotkey` said, since Wayland never registered it. Stable keeps the hold shortcuts bound without showing their row, so F9 still talks there; it binds the first press shortcut only.
- **A save is the user's press.** It rewrites only `~/.config/hypr/sotto-bindings.lua`, the snippet Sotto's Omarchy setup owns, from the bundled `apps/omarchy/bindings.lua`: a press shortcut binds `sotto dictation toggle`, a hold shortcut binds `start` on key-down and `stop` on key-up, and the snippet unbinds exactly the chords it binds. With the defaults the bundled file comes back unchanged, so existing keys stay as they are. `bindings.lua` keeps its require and the backup made at setup stays the original, so a save makes no new backup. The rules of ADR-0062 apply: the snippet must still be Sotto's, `luac -p` checks it, Hyprland's active bindings are read first and a chord bound to anything other than Sotto or Voxtype is refused with what it runs, a new Hyprland error after the reload puts the previous snippet back, and Sotto checks that Hyprland loaded the new keys. The answer, Hyprland's words included, appears only in the row and never in a log. Keys set up by hand, and a snippet changed by hand, are left alone.
- **Until the keys are set up, the rows say so.** They show their keys read-only and offer the setup's own **Set up the keys** rather than writing a file. Setup writes the keys the rows hold.
- **The page records.** Wayland gives the page only the keys Hyprland passes to Sotto's window, so a chord Hyprland binds never reaches it; the recording ends with the modifiers alone and the row says Hyprland already uses the key. While a recording is open, main ignores `start` and `toggle` from Sotto's own bindings and tells the recording whose keys they were, under the same stand-down as the other platforms (60 s at most, ended by a save, a cancel, a blur, a reload, a crash, a lock or a sleep).
- **The settings queue never waits on Hyprland.** The Omarchy setup writes the keys in its own lane, then saves the shortcuts through the settings coordinator, the order theme setup already takes. Reset settings therefore leaves Linux's keys as they are: they change only from their row.

## Considered options

- **uiohook-napi.** A ready npm module for global key events. It creates an active tap, so macOS asks for Accessibility, a wider grant than listening needs; it never reports Fn; and it is a new native dependency. Rejected.
- **Electron's global shortcut only.** No key-up and no Fn, so no hold shortcut and no Fn. It stays for the main press shortcut and for extra press shortcuts that have a key.
- **Linux: unbinding Sotto's keys while a recording is open.** Each recording would rewrite and reload Hyprland's configuration twice, and a crash would leave the keys unbound until the next start. Ignoring Sotto's own commands in the running app changes no file. Rejected.
- **Linux: Omarchy's own key picker, or editing `bindings.lua` in place.** The first does not exist for third-party bindings; the second puts Sotto's writes in the user's file, where ownership cannot be checked. Rejected: Sotto rewrites only its own snippet.
- **A free-text field with better parsing.** Fixes the parsing, not the flow, and still cannot hold or see Fn.

## Consequences

Sotto ships a macOS helper binary and a Windows C# file. The Mac packaging path builds the binary before electron-builder, and the packaged-resources check looks for it. It adds no npm dependency and contacts no host.

Known limits:

- The listener only listens. A hold shortcut's keys still reach the app in front, so a hold shortcut ending in Space also types a space.
- Owl now also ships for Apple silicon Macs, ad-hoc signed, and its Mac packaging builds the helper like the stable path. Ad-hoc signing means macOS may drop the Input Monitoring grant on each update and leave a ticked entry that no longer works. Settings tells the user to turn Sotto off and on again in that list.
- Sotto's own in-app shortcut checks still consult only the main press shortcut, and the widget's hint names it during a hold. Deferred.
- On Windows, PowerShell compiling a low-level hook may be flagged by antivirus or blocked under WDAC's constrained language mode. Windows CI compiles the C# with PowerShell 5.1 and installs the hook; no real keypress has gone through it, and it has not been checked on a Windows machine with Defender. Windows silently removes a low-level hook that answers too slowly.
- A key's release can be lost at the lock screen, during sleep or behind a system prompt. Both helpers check the physical state of every key they report down every half second while the queue is idle, and report the release themselves, so no key stays stuck; macOS needs two readings in a row, counts a Sticky Keys latch as held and skips the check while secure input is on.
- Locking the screen or sleeping cancels a hold in progress.
- Synthetic keys, such as Sotto's own paste, are ignored by their source, so they never start or end a shortcut.
- On Linux the floating widget, the Threads tour and first-run setup still name F9 and Super+Ctrl+X after the keys change; Settings, Dictate and Help follow the saved keys. Omarchy's shell pill names no keys. Hyprland bindings by keycode (`code:10`) are not matched by name, which matters little because such a key never reaches the recording.
- A single modifier cannot be a shortcut. A modifier-only shortcut is Fn alone or two modifiers together, because one modifier is part of too many other shortcuts.
