#!/bin/bash
# Install Sotto's template and render it with Omarchy, without changing the desktop theme.
set -euo pipefail
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
omarchy_path=${OMARCHY_PATH:-/usr/share/omarchy}
current=$HOME/.local/state/omarchy/current
themed=$HOME/.config/omarchy/themed
template=$themed/sotto.json.tpl
rendered=$current/theme/sotto.json
next=$current/next-theme
action=install
operation=''
while (( $# )); do
  case $1 in
    install|--uninstall) action=$1; shift ;;
    --operation) [[ $# -ge 2 ]] || exit 1; operation=$2; shift 2 ;;
    *) echo 'Use install-theme.sh [--uninstall].' >&2; exit 1 ;;
  esac
done
if [[ -z $operation ]]; then operation=$(</proc/sys/kernel/random/uuid); fi
[[ $operation =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]] || exit 1
staging=$current/.sotto-theme-$operation
template_temporary=$themed/.sotto.json.tpl.$operation
render_temporary=$current/theme/.sotto.json.$operation
marker=.sotto-template-operation

if [[ $action != --uninstall && ! -f $current/theme/colors.toml ]]; then
  echo 'Choose an Omarchy theme first, then run this script again.' >&2
  exit 1
fi
if [[ $action != --uninstall && ! -x $omarchy_path/bin/omarchy-theme-set-templates ]]; then
  echo 'Omarchy’s template command is unavailable. Update Omarchy, then try again.' >&2
  exit 1
fi
# Share Omarchy's lock. Only the nonce recorded by main can clean an interrupted render.
exec 9>"${XDG_RUNTIME_DIR:-/tmp}/omarchy-theme-set.lock"
flock 9
if [[ -L $next || -L $staging || -L $template_temporary || -L $render_temporary ]]; then
  echo 'Sotto found a linked temporary theme file. It was left alone.' >&2
  exit 1
fi
if [[ -e $next ]]; then
  if [[ -f $next/$marker && ! -L $next/$marker && $(<"$next/$marker") == "$operation" ]]; then
    rm -rf -- "$next"
  else
    echo 'Omarchy has a theme waiting to be applied. Finish switching it, then try again.' >&2
    exit 1
  fi
fi
# These nonce-named scratch paths were claimed before main started this operation.
rm -rf -- "$staging"
rm -f -- "$template_temporary" "$render_temporary"
if [[ $action == --uninstall ]]; then
  rm -f -- "$template" "$rendered"
  [[ ! -d $themed ]] || sync -- "$themed"
  [[ ! -d $current/theme ]] || sync -- "$current/theme"
  exit 0
fi
mkdir -p "$themed"
mkdir "$staging"
printf '%s\n' "$operation" > "$staging/$marker"
sync -- "$staging/$marker" "$staging"
cleanup() {
  if [[ -f $next/$marker && ! -L $next/$marker && $(<"$next/$marker") == "$operation" ]]; then rm -rf -- "$next"; fi
  rm -rf -- "$staging"
  rm -f -- "$template_temporary" "$render_temporary"
}
trap cleanup EXIT
template_mode=0644
render_mode=0644
[[ ! -f $template ]] || template_mode=$(stat -c '%a' -- "$template")
[[ ! -f $rendered ]] || render_mode=$(stat -c '%a' -- "$rendered")
install -m "$template_mode" "$source_dir/sotto.json.tpl" "$template_temporary"
sync -- "$template_temporary"
mv -- "$template_temporary" "$template"
sync -- "$themed"
cp "$current/theme/colors.toml" "$staging/colors.toml"
mv -- "$staging" "$next"
sync -- "$current"
OMARCHY_PATH=$omarchy_path PATH="$omarchy_path/bin:$PATH" "$omarchy_path/bin/omarchy-theme-set-templates"
if [[ ! -f $next/sotto.json ]] || grep -q '{{' "$next/sotto.json"; then
  echo 'This Omarchy theme leaves colours unresolved. Choose another theme, then try again.' >&2
  exit 1
fi
install -m "$render_mode" "$next/sotto.json" "$render_temporary"
sync -- "$render_temporary"
mv -- "$render_temporary" "$rendered"
sync -- "$current/theme"
echo 'Sotto follows Omarchy. Choose Omarchy in Settings → Appearance if Sotto was already set up.'
