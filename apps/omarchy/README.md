# Sotto on Omarchy

This folder holds configuration Omarchy reads, rather than code Sotto loads. ADR-0062 assigns Omarchy's compositor bindings, shell integration, themes and packaging here. It includes the dictation launcher and bindings, the shell plugin, the `sotto-bin` package recipe, desktop entry, icons and install helper.

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

The `sotto` launcher uses Sotto's bundled Electron in Node mode for the tiny client. No separate Node installation is needed in a packaged install. The packaging contract for #841 is the desktop executable at `/opt/sotto/sotto`, this launcher at `/opt/sotto/bin/sotto`, and a PATH link such as `/usr/bin/sotto` pointing to the launcher. The client and its shared chunk are already built under `out/main/` and included by the existing `out/**/*` package rule. The PKGBUILD in this folder installs that layout.

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

`shell-plugin/sotto.dictation/` is Sotto's dictation in the Omarchy shell (#850): Sotto's glyph in the bar and, while you dictate, a pill in the shell's own style with Stop and Cancel. When a transcription fails and the recording is kept, the pill offers Try again and Discard. It takes its colours and font from the Omarchy theme and repaints when the theme changes. While the plugin is installed and Sotto's dictation socket has started with a live state file, Sotto does not show its own floating widget on Linux. If either is unavailable, its own widget stays available.

Install it from your desktop session, with the Omarchy shell running:

```sh
apps/omarchy/install-shell-plugin.sh              # runs `sotto` from PATH
apps/omarchy/install-shell-plugin.sh --checkout   # runs this checkout's apps/omarchy/sotto
apps/omarchy/install-shell-plugin.sh --command /absolute/path/to/sotto
```

The script copies the plugin to `$HOME/.config/omarchy/plugins/sotto.dictation/` and puts the glyph on the bar after Omarchy's indicators with `omarchy bar put`. That folder is the one Omarchy's shell loads plugins from: its `PluginRegistry` builds the path from `$HOME` and ignores `XDG_CONFIG_HOME`, so the installer and Sotto's folder watch both use it. If `XDG_CONFIG_HOME` points elsewhere and holds a copy of the plugin, the script says the shell does not load it. `--command` saves the launcher in the plugin's settings with `omarchy bar set sotto.dictation command <path>`; you can run that yourself later. Run the script again after updating Sotto. A running shell keeps the plugin code it loaded first, so restart it afterwards with `omarchy restart shell`.

How it behaves:

- A click on the glyph runs `sotto dictation toggle`: it starts dictating, or stops a dictation that is running. While Sotto transcribes, a click does nothing. While a recording is kept, a click starts a new dictation and the kept recording is let go.
- The pill appears on the display the mouse is on when a dictation starts, which is Hyprland's focused monitor, and stays there until that dictation ends. The next dictation chooses again, even while the last one's result or kept recording is still showing. Sotto names each dictation in the state file, so one that starts as another is cancelled is told apart even when the state between them was never written; with an older Sotto that does not, the plugin works it out from the states.
- It starts top centre, just under the bar. Drag it, and on release it snaps to the nearest edge of the screen, centred on that edge; Sotto saves the edge with `sotto dictation place <edge>`. On the left and right edges the pill stands upright and its words read top to bottom. The pill is never longer than the screen it is on allows, so on a small display or at a large scale its words wrap and its buttons stay on screen.
- Stop, Cancel, Try again and Discard run `sotto dictation stop`, `cancel`, `retry` and `discard`. A failure with nothing kept shows Dismiss, which only hides the pill.
- If a command does not get through, the pill says so and what to do, and keeps its buttons so you can press again. The dictation stays on screen until Sotto moves on, since after a Stop that did not get through the recording may still be running. A notice with no dictation behind it lasts five seconds.
- If Sotto quits while the pill shows a dictation, the pill says so within a few seconds, and whether a recording was lost with it; Sotto keeps recordings only in memory. Dismiss puts it away. If a Stop or another press was still on its way when Sotto quit, its failure is not shown: the notice stays, and nothing comes back after Dismiss. An older Sotto that does not name its process in the state file is taken at its word, and one that names it without `pidStart` is checked by its PID alone.
- If the state file is there but cannot be read, the pill keeps what it last showed, with its buttons, says "Could not read Sotto's dictation state. Trying again." and reads it again every few seconds. With nothing on screen, only the glyph says so, in the urgent colour. Only a missing file means there is nothing to show.
- The pill never takes keyboard focus. From the keyboard, use the bindings above, Escape in Sotto's window, or a cancel binding of your own.
- With Hyprland's animations turned off, the pill holds still.

The plugin follows `$XDG_RUNTIME_DIR/sotto/dictation-state.json`, which Sotto writes and which never carries what you said; a missing file means there is nothing to show. While the file shows a dictation, the plugin reads `/proc/<pid>/stat` for the Sotto process it names every few seconds, and counts Sotto alive only while that process's start time is the file's `pidStart`, so a PID another process has taken since does not keep a dictation showing. It runs the dictation command with its own arguments, never through a shell, and opens no network connection.

To remove it:

```sh
apps/omarchy/install-shell-plugin.sh --uninstall
```

This takes the glyph off the bar, checks that `shell.json` no longer names it, and only then deletes the plugin folder; Sotto's own widget comes back. Taking the glyph off needs the Omarchy shell running, so without it the script removes nothing and says so. If `shell.json` cannot be read, before or after the glyph comes off, the script keeps the plugin folder and says why, since it cannot tell whether the glyph is still on the bar. It also takes off a glyph left on the bar after the folder was deleted by hand. `omarchy plugin remove sotto.dictation` also takes the glyph off and keeps a hidden backup of the folder.

`scripts/verify-omarchy-shell-plugin.sh <out-dir>`, from the checkout's root, checks all of this in an owned, nested copy of the Omarchy shell without touching the running desktop. `docs/verification/omarchy-shell-plugin.md` records a run.
## Build and install the package

`PKGBUILD` makes `sotto-bin` for x86_64, using Sotto's own Electron. The first Linux release and AUR publication are pending; the recipe's initial archive checksum belongs to the local verification build. For a published release, update `pkgver` and the SHA-256 from its verified `SHA256SUMS.txt`, then run:

```sh
cd apps/omarchy
makepkg --cleanbuild
sudo pacman -U "$(makepkg --packagelist)"
```

Until a release tarball exists, build one from this checkout with Node 24, then point the recipe at it. Replace the archive checksum in `sha256sums` with `sha256sum ../../release/Sotto-<version>-linux-x64.tar.gz`; local builds still require a checksum, never `SKIP`.

```sh
mise exec node@24.21.0 -- npm run package:linux
cd apps/omarchy
SOTTO_TARBALL="$PWD/../../release/Sotto-<version>-linux-x64.tar.gz" makepkg --cleanbuild --force
pacman -Qlp "$(makepkg --packagelist)"
bsdtar -tvf "$(makepkg --packagelist)"
```

Builds need no root. Installation does. `install.sh path/to/package.pkg.tar.zst` installs the local package with pacman and offers the bindings and shell plugin instructions; it does not change your desktop configuration. Without a path it uses `omarchy-pkg-add sotto-bin` when a package repository carries it, or `yay -S --needed sotto-bin` for the AUR. Do not use that form before publication. The shell plugin is installed separately; follow the shell plugin instructions above.

Regenerate the hicolor icons from `build/icon.svg` with `mise exec node@24.21.0 -- node scripts/generate-brand-assets.mjs --linux` at the repository root. This leaves Windows, macOS and phone outputs alone. Refresh the three icon checksums and run `makepkg --printsrcinfo > .SRCINFO` afterward.

The package installs the app into `/opt/sotto`, links `/usr/bin/sotto` to `/opt/sotto/bin/sotto`, adds `sotto.desktop` and hicolor icons, and sets `chrome-sandbox` to root:root 4755. Arch's user namespaces normally supply the sandbox. The helper supports desktops with user namespaces turned off. The dependency list follows forge's `t3code-bin`, with wl-clipboard and libsecret added. Omarchy supplies gnome-keyring; an unlocked Secret Service is needed to save keys.

Open Sotto from the application menu or run `sotto`. Under Settings → Application, **Launch when you sign in** writes or removes `$XDG_CONFIG_HOME/autostart/sotto.desktop` (normally `~/.config/autostart/sotto.desktop`). uwsm runs it at sign-in. Development builds keep that row disabled. **Start minimized** keeps the main window hidden at sign-in.

Before the AUR publication, install a new package with `sudo pacman -U`. After publication, `omarchy update` brings updates. Sotto never updates itself on Linux. Release steps and the required installed-app checks are in [the release guide](../../docs/release/releasing.md#linux-desktop-package).

Removing `sotto-bin` leaves your autostart entry in place. Its `TryExec` points to the same executable as `Exec`, so sign-in skips it once the package is removed. Turn **Launch when you sign in** off before removing the package to remove Sotto's entry too.
