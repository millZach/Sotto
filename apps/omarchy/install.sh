#!/bin/bash
# omarchy:summary=Install Sotto and offer its dictation bindings and shell plugin
# omarchy:requires-sudo=true
set -euo pipefail

echo 'Installing Sotto...'
if [[ $# -eq 1 ]]; then
  sudo pacman -U -- "$1"
elif [[ $# -eq 0 ]]; then
  if pacman -Si sotto-bin >/dev/null 2>&1; then
    omarchy-pkg-add sotto-bin
  else
    yay -S --needed sotto-bin
  fi
else
  echo 'Use install.sh [path/to/sotto-bin.pkg.tar.zst].' >&2
  exit 1
fi

echo
echo 'Sotto has been installed. Open it from the application menu.'
read -r -p 'Show the dictation bindings setup? [y/N] ' answer
if [[ $answer =~ ^[Yy]$ ]]; then
  cat <<'BINDINGS'
Copy /usr/share/sotto/bindings.lua to ~/.config/hypr/sotto-bindings.lua.
Add require("hypr.sotto-bindings") at the end of ~/.config/hypr/bindings.lua.
This gives Sotto F9 and Super+Ctrl+X, replacing Voxtype's bindings.
Check with luac -p ~/.config/hypr/sotto-bindings.lua.
BINDINGS
fi
read -r -p 'Show the shell plugin setup? [y/N] ' answer
if [[ $answer =~ ^[Yy]$ ]]; then
  echo 'The shell plugin is separate. Follow apps/omarchy/shell-plugin/README.md in the Sotto source checkout.'
  echo 'Install it in ~/.config/omarchy/plugins/ using that guide.'
fi
