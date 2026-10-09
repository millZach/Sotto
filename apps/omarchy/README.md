# Sotto on Omarchy

This folder holds configuration Omarchy reads, rather than code Sotto loads. ADR-0062 assigns Omarchy's compositor bindings, shell integration, themes and packaging here. It includes the dictation launcher and bindings, the `sotto-bin` package recipe, desktop entry, icons and install helper.

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

Builds need no root. Installation does. `install.sh path/to/package.pkg.tar.zst` installs the local package with pacman and offers the bindings and shell plugin instructions; it does not change your desktop configuration. Without a path it uses `omarchy-pkg-add sotto-bin` when a package repository carries it, or `yay -S --needed sotto-bin` for the AUR. Do not use that form before publication. The shell plugin is shipped separately by #850; follow its own README in `shell-plugin/` when available.

Regenerate the hicolor icons from `build/icon.svg` with `mise exec node@24.21.0 -- node scripts/generate-brand-assets.mjs --linux` at the repository root. This leaves Windows, macOS and phone outputs alone. Refresh the three icon checksums and run `makepkg --printsrcinfo > .SRCINFO` afterward.

The package installs the app into `/opt/sotto`, links `/usr/bin/sotto` to `/opt/sotto/bin/sotto`, adds `sotto.desktop` and hicolor icons, and sets `chrome-sandbox` to root:root 4755. Arch's user namespaces normally supply the sandbox. The helper supports desktops with user namespaces turned off. The dependency list follows forge's `t3code-bin`, with wl-clipboard and libsecret added. Omarchy supplies gnome-keyring; an unlocked Secret Service is needed to save keys.

Open Sotto from the application menu or run `sotto`. Under Settings → Application, **Launch when you sign in** writes or removes `$XDG_CONFIG_HOME/autostart/sotto.desktop` (normally `~/.config/autostart/sotto.desktop`). uwsm runs it at sign-in. Development builds keep that row disabled. **Start minimized** keeps the main window hidden at sign-in.

Before the AUR publication, install a new package with `sudo pacman -U`. After publication, `omarchy update` brings updates. Sotto never updates itself on Linux. Release steps and the required installed-app checks are in [the release guide](../../docs/release/releasing.md#linux-desktop-package).

Removing `sotto-bin` leaves your autostart entry in place. Its `TryExec` points to the same executable as `Exec`, so sign-in skips it once the package is removed. Turn **Launch when you sign in** off before removing the package to remove Sotto's entry too.
