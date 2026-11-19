#!/usr/bin/env bash
# Question 5: every connection the component makes by itself. Runs CEF in its own network namespace (pasta), so the
# pcap holds only its traffic. The local test page is served inside the namespace on loopback, which pasta's capture
# does not see. NetLog records host names. Usage: net.sh <run-name> <idle-seconds> <page-seconds> [switches]
set -euo pipefail
NAME="$1"; IDLE="$2"; PAGE="$3"; SW="${4:-}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
RUNS="${RUNS:-$HOME/.cache/sotto-tmp/runs}"; RUN="$RUNS/$NAME"; DIST="${DIST:-$HOME/.cache/sotto-tmp/wp-dist}"
rm -rf "$RUN"; mkdir -p "$RUN/home/.config" "$RUN/home/.cache"
cat > "$RUN/inside.sh" <<INNER
#!/usr/bin/env bash
python -I "$HERE/server/testserver.py" --pages "$HERE/server/pages" --bind 127.0.0.1 --port 18765 --tcp-canary 18766 --udp-canary 18767 > "$RUN/server.log" 2>&1 &
SRV=\$!
sleep 1
cd "$DIST"
env -u DBUS_SESSION_BUS_ADDRESS HOME="$RUN/home" XDG_CONFIG_HOME="$RUN/home/.config" XDG_CACHE_HOME="$RUN/home/.cache" \
  WP_PREFS="${WP_PREFS:-}" WP_MODE=net WP_BASE=http://127.0.0.1:18765 WP_RUN_DIR="$RUN" WP_IDLE_S="$IDLE" WP_PAGE_S="$PAGE" WP_CACHE="$RUN/cache" \
  WP_SWITCHES="ozone-platform=headless;log-net-log=$RUN/netlog.json;net-log-capture-mode=Default;$SW" \
  unshare --user --map-user=1000 --map-group=1000 -- ./webpane > "$RUN/stdout.log" 2> "$RUN/stderr.log" &
APP=\$!
sleep 25
ps -o pid,ppid,rss,args --ppid \$APP > "$RUN/processes.txt" 2>/dev/null || true
ps -o pid,args -p \$APP >> "$RUN/processes.txt" 2>/dev/null || true
wait \$APP
kill \$SRV
INNER
chmod +x "$RUN/inside.sh"
pasta --config-net -t none -u none -T none -U none --pcap "$RUN/net.pcap" -- "$RUN/inside.sh"
echo "done -> $RUN"
