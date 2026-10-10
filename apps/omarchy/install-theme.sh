#!/bin/bash
# Install Sotto's template and render it with Omarchy, without changing the desktop theme.
set -euo pipefail
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
omarchy_path=${OMARCHY_PATH:-/usr/share/omarchy}
current=$HOME/.local/state/omarchy/current
next=$current/next-theme

if [[ ! -f $current/theme/colors.toml ]]; then
  echo 'Choose an Omarchy theme first, then run this script again.' >&2
  exit 1
fi
if [[ ! -x $omarchy_path/bin/omarchy-theme-set-templates ]]; then
  echo 'Omarchy’s template command is unavailable. Update Omarchy, then try again.' >&2
  exit 1
fi
# Share Omarchy's lock, so installation cannot take a switch's staging folder.
exec 9>"${XDG_RUNTIME_DIR:-/tmp}/omarchy-theme-set.lock"
flock 9
if [[ -e $next || -L $next ]]; then
  echo 'Omarchy has a theme waiting to be applied. Finish switching it, then try again.' >&2
  exit 1
fi
mkdir -p "$HOME/.config/omarchy/themed"
install -m 0644 "$source_dir/sotto.json.tpl" "$HOME/.config/omarchy/themed/sotto.json.tpl"
mkdir "$next"
temporary=''
cleanup() { rm -rf -- "$next"; [[ -z $temporary ]] || rm -f -- "$temporary"; }
trap cleanup EXIT
cp "$current/theme/colors.toml" "$next/colors.toml"
OMARCHY_PATH=$omarchy_path PATH="$omarchy_path/bin:$PATH" "$omarchy_path/bin/omarchy-theme-set-templates"
if [[ ! -f $next/sotto.json ]] || grep -q '{{' "$next/sotto.json"; then
  echo 'This Omarchy theme leaves colours unresolved. Choose another theme, then try again.' >&2
  exit 1
fi
temporary=$(mktemp "$current/theme/.sotto.json.XXXXXX")
install -m 0644 "$next/sotto.json" "$temporary"
mv -- "$temporary" "$current/theme/sotto.json"
temporary=''
echo 'Sotto follows Omarchy. Choose Omarchy in Settings → Appearance if Sotto was already set up.'
