# Sotto on Omarchy

This folder holds configuration Omarchy reads, rather than code Sotto loads. ADR-0062 assigns Omarchy's compositor bindings, shell integration, themes and packaging here. This ticket supplies the dictation command and bindings; packaging follows in #841.

## Dictation command

Keep Sotto running in the desktop session. A compositor binding is a key Hyprland listens for and uses to run Sotto's dictation command:

```sh
sotto dictation start
sotto dictation stop
sotto dictation toggle
sotto dictation cancel
```

`start` opens the microphone. `stop` finishes the recording. `toggle` starts or stops. `cancel` drops an active recording or cancels processing, following Sotto's existing cancellation rules. A repeated start and a stop without a start do nothing. Releasing F9 while the microphone connects cancels once it is ready, without transcription.

The command sends only one of those four words through `$XDG_RUNTIME_DIR/sotto/dictation.sock`. The runtime folder must be a real absolute path, owned by you, with mode 0700 and no linked folders in its path. An unsafe runtime folder disables the listener and the command explains how to retry in a desktop session. Sotto's folder is also mode 0700. The stable endpoint is a link to a private socket for that instance, with mode 0600. There is no TCP listener. On quit, main removes its socket and its link only while the link still belongs to it. It recovers a dead instance's leftovers after a crash and leaves another running listener or a replacement endpoint alone. Without a running Sotto the command exits with guidance to open the app; it never launches or focuses it. Success means the command reached the main renderer, rather than that transcription succeeded.

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

Omarchy loads `~/.config/hypr/bindings.lua` after its defaults. Copy this folder's `bindings.lua` to `~/.config/hypr/sotto-bindings.lua` and add this line to the end of your own `bindings.lua`:

```lua
require("sotto-bindings")
```

Or paste the snippet at the end of your own file. For a checkout, change `local sotto = "sotto"` to the absolute launcher path. If the path has spaces, include shell quotes inside the Lua string, for example `local sotto = "'/home/me/Sotto checkout/apps/omarchy/sotto'"`.

The snippet first unbinds F9 and Super+Ctrl+X, which Voxtype owns when Omarchy installed it. Hyprland's [`hl.unbind`](https://wiki.hypr.land/configuring/core/binds/#unbind) removes every occurrence of the key, including F9's release binding. It then binds Sotto's start on F9 key-down, stop on F9 key-up, and toggle on Super+Ctrl+X. Voxtype's engine stays installed for the later local-transcription option (#845).

To cancel from outside Sotto, choose an unused chord and bind it to `sotto dictation cancel`. Escape cancels in Sotto's window. The snippet does not take Escape from other apps.

Check the saved snippet with `luac -p ~/.config/hypr/sotto-bindings.lua`, then check Hyprland's configuration after it reloads. No installer changes these files automatically. Transcripts are copied; paste with Ctrl+V, or Shift+Insert in a terminal. Hyprland paste is #838.
