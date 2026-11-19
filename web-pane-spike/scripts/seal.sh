#!/usr/bin/env bash
# Runs the hostile page in a network namespace whose only link goes to this machine's canaries, with tcpdump on
# both the link and the namespace's loopback. Nothing can leave forge from inside it.
# Usage: seal.sh <run-name> <layers>   (layers: comma list of csp,filter,proxy,webrtc,deny,nortc)
set -euo pipefail
NAME="$1"; LAYERS="$2"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
RUNS="${RUNS:-$HOME/.cache/sotto-tmp/runs}"; RUN="$RUNS/$NAME"; DIST="${DIST:-$HOME/.cache/sotto-tmp/wp-dist}"
NS=wpseal
rm -rf "$RUN"; mkdir -p "$RUN/home/.config" "$RUN/home/.cache"
if ! sudo ip netns list | grep -q "^$NS"; then
  sudo ip netns add $NS
  sudo ip link add wpseal0 type veth peer name wpseal1
  sudo ip link set wpseal1 netns $NS
  sudo ip addr add 10.99.0.1/30 dev wpseal0; sudo ip link set wpseal0 up
  sudo ip netns exec $NS ip addr add 10.99.0.2/30 dev wpseal1
  sudo ip netns exec $NS ip link set wpseal1 up; sudo ip netns exec $NS ip link set lo up
  sudo mkdir -p /etc/netns/$NS; echo "nameserver 10.99.0.1" | sudo tee /etc/netns/$NS/resolv.conf >/dev/null
fi
pids=()
sudo tcpdump -i wpseal0 -nn -U -w "$RUN/link.pcap" 2>/dev/null & pids+=($!)
sudo ip netns exec $NS tcpdump -i lo -nn -U -w "$RUN/lo.pcap" 2>/dev/null & pids+=($!)
python -I "$HERE/server/testserver.py" --pages "$HERE/server/pages" --bind 10.99.0.1 > "$RUN/canary-link.log" 2>&1 & pids+=($!)
sudo ip netns exec $NS sudo -u "$USER" python -I "$HERE/server/testserver.py" --pages "$HERE/server/pages" --bind 127.0.0.1 > "$RUN/canary-loopback.log" 2>&1 & pids+=($!)
sudo python -I "$HERE/server/dnslog.py" --bind 10.99.0.1 > "$RUN/dns.log" 2>&1 & pids+=($!)
sleep 1.5
cd "$DIST"
sudo --preserve-env=HOME ip netns exec $NS sudo -u "$USER" env HOME="$RUN/home" XDG_CONFIG_HOME="$RUN/home/.config" XDG_CACHE_HOME="$RUN/home/.cache" \
  WP_MODE=seal WP_RUN_DIR="$RUN" WP_SEAL="$LAYERS" WP_HOSTILE="$HERE/server/hostile.html" WP_SWITCHES="ozone-platform=headless;${WP_EXTRA:-}" \
  timeout 120 ./webpane > "$RUN/stdout.log" 2> "$RUN/stderr.log" && code=0 || code=$?
sleep 1
for p in "${pids[@]}"; do sudo kill "$p" 2>/dev/null || true; done
sudo pkill -f "dnslog.py --bind 10.99.0.1" 2>/dev/null || true
sudo ip netns pids $NS | xargs -r sudo kill 2>/dev/null || true
wait 2>/dev/null || true
sudo chown "$USER" "$RUN"/*.pcap 2>/dev/null || true
echo "exit $code -> $RUN"
