# Sotto on Omarchy

This folder holds configuration Omarchy reads, rather than code Sotto loads. ADR-0062 assigns Omarchy's compositor bindings, shell integration, themes and packaging here. It holds the dictation command and bindings, and the shell plugin; packaging follows in #841.

## Dictation command

Keep Sotto running in the desktop session. A compositor binding is a key Hyprland listens for and uses to run Sotto's dictation command:

```sh
sotto dictation start
sotto dictation stop
sotto dictation toggle
sotto dictation cancel
```

`start` opens the microphone. `stop` finishes the recording. `toggle` starts or stops. `cancel` drops an active recording or cancels processing, following Sotto's existing cancellation rules. A repeated start and a stop without a start do nothing. Releasing F9 while the microphone connects cancels once it is ready, without transcription.

The command sends one of those four words, optionally with an event stamp, through `$XDG_RUNTIME_DIR/sotto/dictation.sock`. The runtime folder must be a real absolute path, owned by you, with mode 0700 and no linked folders in its path. An unsafe runtime folder disables the listener and the command explains how to retry in a desktop session. Sotto's folder is also mode 0700. The stable endpoint is a link to a private socket for that instance, with mode 0600. There is no TCP listener. On quit, main removes its socket and its link only while the link still belongs to it. It recovers a dead instance's leftovers after a crash and leaves another running listener or a replacement endpoint alone. Without a running Sotto the command exits with guidance to open the app; it never launches or focuses it. An acceptance reply stops both idle timers while main delivers the command, including when its window must be recreated. Success means the command reached the main renderer, rather than that transcription succeeded. A start ignored after a newer release also succeeds without opening the microphone.

The `sotto` launcher uses Sotto's bundled Electron in Node mode for the tiny client. No separate Node installation is needed in a packaged install. The packaging contract for #841 is the desktop executable at `/opt/sotto/sotto`, this launcher at `/opt/sotto/bin/sotto`, and a PATH link such as `/usr/bin/sotto` pointing to the launcher. The client and its shared chunk are already built under `out/main/` and included by the existing `out/**/*` package rule. This ticket does not install that package.

From a development checkout, prepare and build with Node 24, then use the launcher's absolute path:

```sh
mise exec node@24.21.0 -- npm ci
mise exec node@24.21.0 -- node node_modules/electron/install.js
mise exec node@24.21.0 -- npm run runtime:prepare
mise exec node@24.21.0 -- npm run build
/absolute/path/to/Sotto/apps/omarchy/sotto
/absolute/path/to/Sotto/apps/omarchy/sotto dictation start
/absolute/path/to/Sotto/apps/omarchy/sotto dictation stop
```

## Install the bindings

The snippet must run after Omarchy's defaults so it can remove Voxtype's bindings. Stock Omarchy guarantees that order for `~/.config/hypr/bindings.lua`. Copy this folder's `bindings.lua` to `~/.config/hypr/sotto-bindings.lua` and add this line to the end of your own `bindings.lua`:

```lua
require("hypr.sotto-bindings")
```

Or paste the snippet at the end of your own file. For a checkout, change `local sotto = "sotto"` to the absolute launcher path. If the path has spaces, include shell quotes inside the Lua string, for example `local sotto = "'/home/me/Sotto checkout/apps/omarchy/sotto'"`.

The snippet uses `sh -c` and `date +%s%N` to stamp each command before the client boots: `sotto dictation start --at <epoch-ns>`. Key-up gets its own stamp. Sotto remembers the latest accepted stamped stop or cancel, including an unpaired one, and ignores a start stamped at or before it. A quick tap cannot leave the microphone open when its clients arrive reversed. Delivery is serialized when the main window must be recreated. Stamps older than 5 seconds or more than 250 ms in the future are rejected; these bounds allow client startup and a small clock skew without letting an old or future release suppress later holds. Commands without `--at` keep the hand-typed behavior above.

The snippet first unbinds F9 and Super+Ctrl+X, which Voxtype owns when Omarchy installed it. Hyprland's [`hl.unbind`](https://wiki.hypr.land/configuring/core/binds/#unbind) removes every occurrence of the key, including F9's release binding. It then binds Sotto's start on F9 key-down, stop on F9 key-up, and toggle on Super+Ctrl+X. Voxtype's engine stays installed for the later local-transcription option (#845).

To cancel from outside Sotto, choose an unused chord and bind it to `sotto dictation cancel`. Escape cancels in Sotto's window. The snippet does not take Escape from other apps.

Check the saved snippet with `luac -p ~/.config/hypr/sotto-bindings.lua`, then check Hyprland's configuration after it reloads. No installer changes these files automatically. Sotto copies your text, then pastes into the focused window on Hyprland, terminals included. If paste does not get through, use Super+V, Omarchy’s universal paste for apps and terminals.

## Shell plugin

`shell-plugin/sotto.dictation/` is Sotto's dictation in the Omarchy shell (#850): Sotto's glyph in the bar and, while you dictate, a pill in the shell's own style with Stop and Cancel. When a transcription fails and the recording is kept, the pill offers Try again and Discard. It takes its colours and font from the Omarchy theme and repaints when the theme changes. While the plugin is installed, Sotto does not show its own floating widget on Linux.

Install it from your desktop session, with the Omarchy shell running:

```sh
apps/omarchy/install-shell-plugin.sh              # runs `sotto` from PATH
apps/omarchy/install-shell-plugin.sh --checkout   # runs this checkout's apps/omarchy/sotto
apps/omarchy/install-shell-plugin.sh --command /absolute/path/to/sotto
```

The script copies the plugin to `~/.config/omarchy/plugins/sotto.dictation/`, where the shell looks for plugins, and puts the glyph on the bar after Omarchy's indicators with `omarchy bar put`. `--command` saves the launcher in the plugin's settings with `omarchy bar set sotto.dictation command <path>`; you can run that yourself later. Run the script again after updating Sotto. A running shell keeps the plugin code it loaded first, so restart it afterwards with `omarchy restart shell`.

How it behaves:

- A click on the glyph runs `sotto dictation toggle`: it starts dictating, or stops a dictation that is running. While Sotto transcribes, a click does nothing. While a recording is kept, a click starts a new dictation and the kept recording is let go.
- The pill appears on the display the mouse is on when dictation starts, which is Hyprland's focused monitor, and stays there until the dictation ends.
- It starts top centre, just under the bar. Drag it, and on release it snaps to the nearest edge of the screen, centred on that edge; Sotto saves the edge with `sotto dictation place <edge>`. On the left and right edges the pill stands upright and its words read top to bottom.
- Stop, Cancel, Try again and Discard run `sotto dictation stop`, `cancel`, `retry` and `discard`. A failure with nothing kept shows Dismiss, which only hides the pill.
- If a command does not get through, the pill says so and what to do, and keeps its buttons so you can press again. The dictation stays on screen until Sotto moves on, since after a Stop that did not get through the recording may still be running. A notice with no dictation behind it lasts five seconds.
- The pill never takes keyboard focus. From the keyboard, use the bindings above, Escape in Sotto's window, or a cancel binding of your own.
- With Hyprland's animations turned off, the pill holds still.

The plugin follows `$XDG_RUNTIME_DIR/sotto/dictation-state.json`, which Sotto writes and which never carries what you said; a missing file means there is nothing to show. It runs the dictation command with its own arguments, never through a shell, and opens no network connection.

To remove it:

```sh
apps/omarchy/install-shell-plugin.sh --uninstall
```

This takes the glyph off the bar and deletes the plugin folder, and Sotto's own widget comes back. `omarchy plugin remove sotto.dictation` does the same and keeps a hidden backup of the folder.

`shell-plugin/verify/nested-proof.sh <out-dir>` checks all of this in an owned, nested copy of the Omarchy shell without touching the running desktop. `docs/verification/omarchy-shell-plugin.md` records a run.
