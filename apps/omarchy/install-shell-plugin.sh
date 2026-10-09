#!/bin/bash

# Install Sotto's Omarchy shell plugin, sotto.dictation, and put its glyph on
# the bar; or remove both with --uninstall. Run it in your desktop session.

set -euo pipefail

id="sotto.dictation"
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
source_dir="$here/shell-plugin/$id"
# Where omarchy-shell and `omarchy plugin` look for plugins, and where Sotto
# looks for this one. Omarchy's PluginRegistry builds it from $HOME and
# ignores XDG_CONFIG_HOME, so this script does too.
plugins_dir="$HOME/.config/omarchy/plugins"
target="$plugins_dir/$id"
# The shell's own settings, which hold the bar's layout.
config="$HOME/.config/omarchy/shell.json"

usage() {
  cat <<USAGE
Usage: $(basename "$0") [--command <path> | --checkout]
       $(basename "$0") --uninstall

Copies the plugin to $target,
then puts Sotto's glyph on the bar next to Omarchy's indicators.

  --command <path>  Run this sotto launcher instead of \`sotto\` on PATH.
  --checkout        Run the launcher in this checkout:
                    $here/sotto
  --uninstall       Take the glyph off the bar, which needs the shell running,
                    then remove the plugin folder.
USAGE
}

fail() {
  echo "$(basename "$0"): $*" >&2
  exit 1
}

command_path=""
uninstall=0
while (( $# > 0 )); do
  case "$1" in
    --command)
      command_path="${2:-}"
      [[ -n $command_path ]] || fail "--command needs a path"
      shift 2
      ;;
    --checkout)
      command_path="$here/sotto"
      shift
      ;;
    --uninstall)
      uninstall=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1 (see --help)"
      ;;
  esac
done

for tool in omarchy omarchy-shell jq; do
  command -v "$tool" >/dev/null || fail "$tool was not found. This script needs Omarchy's shell."
done

shell_running() {
  omarchy-shell shell ping >/dev/null 2>&1
}

# Whether shell.json still names the plugin, on the bar or among plugins.
on_bar() {
  [[ -f $config ]] || return 1
  jq -e --arg id "$id" '
    [(.bar.layout? // {} | objects | .[] | arrays | .[]), (.plugins? // [] | arrays | .[])]
    | any(.[]; (if type == "object" then .id else . end) == $id)
  ' "$config" >/dev/null 2>&1
}

plugin_known() {
  omarchy-shell shell listPlugins 2>/dev/null | jq -e --arg id "$id" 'any(.[]; .id == $id)' >/dev/null 2>&1
}

# A copy under an XDG_CONFIG_HOME other than ~/.config is one the shell never
# loads. Only then is the difference worth a word.
note_elsewhere() {
  [[ -n ${XDG_CONFIG_HOME:-} && $XDG_CONFIG_HOME == /* ]] || return 0
  local copy="$XDG_CONFIG_HOME/omarchy/plugins/$id"
  [[ -e $copy || -L $copy ]] || return 0
  [[ $(realpath -m -- "$copy") != "$(realpath -m -- "$target")" ]] || return 0
  echo "There is another copy of the plugin in $copy. Omarchy's shell does not load it, since it reads plugins only from $plugins_dir, so you can delete that copy."
}

# Refuse to replace or delete a folder this script did not put there.
ours() {
  [[ -L $target ]] && return 0
  [[ -f $target/manifest.json ]] && [[ $(jq -r '.id // ""' "$target/manifest.json" 2>/dev/null) == "$id" ]]
}

if (( uninstall )); then
  [[ -n $command_path ]] && fail "--uninstall takes no other option"
  installed=0
  if [[ -e $target || -L $target ]]; then
    ours || fail "$target is not Sotto's plugin; it was left alone"
    installed=1
  fi
  # The glyph comes off the bar first, and the folder goes only once
  # shell.json no longer names it, so no entry is left behind that a second
  # run could not see. The shell takes the entry off even when the folder
  # has already gone.
  if on_bar; then
    shell_running || fail "Sotto's glyph is on the bar, and only a running Omarchy shell can take it off. Nothing was removed. Run this again in your desktop session."
    omarchy plugin disable "$id" >/dev/null || fail "'omarchy plugin disable $id' did not take Sotto's glyph off the bar. Nothing was removed."
    for (( attempt = 0; attempt < 50; attempt++ )); do
      on_bar || break
      sleep 0.1
    done
    on_bar && fail "Sotto's glyph is still in the bar's layout in $config. Nothing else was removed. Run this again in your desktop session."
    echo "Took Sotto's glyph off the bar."
  elif (( ! installed )); then
    echo "Sotto's shell plugin is not installed in $plugins_dir, and its glyph is not on the bar."
    note_elsewhere
    exit 0
  fi
  if (( installed )); then
    rm -rf -- "$target"
    shell_running && { omarchy-shell shell rescanPlugins >/dev/null 2>&1 || true; }
    echo "Removed Sotto's shell plugin from $plugins_dir."
  else
    echo "Its plugin folder had already gone from $plugins_dir."
  fi
  note_elsewhere
  exit 0
fi

[[ -f $source_dir/manifest.json ]] || fail "the plugin's source is missing: $source_dir"
omarchy plugin validate "$source_dir" >/dev/null || fail "the plugin in $source_dir did not pass 'omarchy plugin validate'"

if [[ -n $command_path ]]; then
  [[ $command_path == /* ]] || fail "--command needs an absolute path"
  [[ -x $command_path ]] || fail "$command_path is not an executable file"
elif ! command -v sotto >/dev/null; then
  echo "There is no sotto command on PATH yet. In a Sotto checkout, run this again with --checkout."
fi

# Copy into a hidden folder first, which the shell ignores, then swap it in,
# so the shell reloads a whole plugin once rather than a file at a time.
mkdir -p -- "$plugins_dir"
if [[ -e $target || -L $target ]]; then
  ours || fail "$target exists and is not Sotto's plugin; it was left alone"
fi
staging=$(mktemp -d "$plugins_dir/.$id.install.XXXXXX")
previous=""
updated=0
cleanup() {
  [[ -n $staging && -d $staging ]] && rm -rf -- "$staging"
  [[ -n $previous && -e $previous ]] && rm -rf -- "$previous"
  return 0
}
trap cleanup EXIT
cp -R -- "$source_dir/." "$staging/"
# Model.d.mts types the model for the tests; the shell has no use for it.
rm -f -- "$staging"/*.d.mts
chmod -R u+rwX,go+rX,go-w -- "$staging"
if [[ -e $target || -L $target ]]; then
  previous=$(mktemp -u "$plugins_dir/.$id.previous.XXXXXX")
  mv -- "$target" "$previous"
  updated=1
fi
mv -- "$staging" "$target"
staging=""
echo "Copied the plugin to $target."
note_elsewhere

if ! shell_running; then
  echo "omarchy-shell is not running, so Sotto is not on the bar yet. Run this again in your desktop session."
  exit 0
fi

omarchy-shell shell rescanPlugins >/dev/null 2>&1 || true
for (( attempt = 0; attempt < 100; attempt++ )); do
  plugin_known && break
  sleep 0.1
done
plugin_known || fail "omarchy-shell did not pick up $id; run 'omarchy-shell shell rescanPlugins' and try again"

omarchy bar put "$id" --section center --after omarchy.indicators
if [[ -n $command_path ]]; then
  omarchy bar set "$id" command "$command_path" >/dev/null
  echo "Sotto's glyph runs $command_path."
fi
# A running shell keeps the plugin code it loaded first.
if (( updated )); then
  echo "The shell still runs the version it loaded before. Restart it to load this one: omarchy restart shell"
fi
