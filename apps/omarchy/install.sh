#!/bin/bash
# omarchy:summary=Install Sotto and open its setup
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
echo 'Press Set up all three in first-run setup, or open Settings → Dictation to finish Omarchy setup.'
