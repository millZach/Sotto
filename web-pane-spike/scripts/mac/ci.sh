#!/usr/bin/env bash
# The macOS half of the web pane spike, as one GitHub Actions job runs it (.github/workflows/web-pane-spike-mac.yml).
# Every phase writes into $OUT and carries on when one fails; summaries/ holds what the note cites.
# Usage: ci.sh <webpane.app> <CEF dir> <out dir> [phase ...]   (no phases: all of them)
# Needs passwordless sudo (pf, tcpdump, purge), which GitHub's macOS runners have. Nothing here signs anything.
set -uo pipefail
APP="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"; CEF="$2"; OUT="$3"; shift 3
PHASES="${*:-info cdp iphone sandbox osr media embed remote ax lifecycle static netdefault nethardened seal}"
HERE="$(cd "$(dirname "$0")" && pwd)"; SPIKE="$(cd "$HERE/../.." && pwd)"
RUNS="$OUT/runs"; SUM="$OUT/summaries"; TOOLS="$OUT/tools"
mkdir -p "$RUNS" "$SUM" "$TOOLS"
PY="python3 -I"
EXE="$APP/Contents/MacOS/webpane"
HARD="$(grep -v '^\s*$' "$SPIKE/config/hardened-switches.txt" | paste -sd ';' -)"
PREFS="$SPIKE/config/hardened-prefs.json"
log() { echo "[ci $(date +%H:%M:%S)] $*"; }
has() { [[ " $PHASES " == *" $1 "* ]]; }
run() { $PY "$HERE/run.py" "$APP" "$RUNS" "$@"; }
clean() { rm -rf "$RUNS/$1/cache"; }   # profiles are not evidence; keep the artifact small
pid_of() { cat "$RUNS/$1/pid" 2>/dev/null; }

# ---------------------------------------------------------------- servers
$PY "$SPIKE/server/testserver.py" --pages "$SPIKE/server/pages" > "$OUT/server.log" 2>&1 &
python3 -m http.server 8770 --bind 127.0.0.1 --directory "$SPIKE/server/media" > "$OUT/media-server.log" 2>&1 &
sleep 1

if has info; then
  log info
  {
    sw_vers; uname -m; sysctl -n machdep.cpu.brand_string hw.ncpu hw.memsize
    system_profiler SPDisplaysDataType 2>/dev/null | grep -v -i -E 'serial|uuid'
    echo "csrutil: $(csrutil status 2>&1)"
    echo "user: $(id -un) groups: $(id -Gn)"
    echo "console user: $(stat -f %Su /dev/console)"
  } > "$SUM/info.txt" 2>&1
  swiftc -O "$SPIKE/tools/macprobe.swift" -o "$TOOLS/macprobe" > "$SUM/macprobe-build.txt" 2>&1 || true
  "$TOOLS/macprobe" trust > "$SUM/ax-trust.txt" 2>&1 || true
  # Which clients the runner's own TCC database already allows (paths only; read, not changed, here).
  sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "select service, client, auth_value from access where service in ('kTCCServiceAccessibility','kTCCServiceScreenCapture','kTCCServicePostEvent')" >> "$SUM/ax-trust.txt" 2>&1 || true
fi

# ---------------------------------------------------------------- 1. the command list, the iPhone, the sandbox
if has cdp; then
  log cdp
  run cdp cdp 180 WP_NO_SANDBOX=1
  $PY "$SPIKE/scripts/summarize.py" "$RUNS/cdp/cdp.json" > "$SUM/q1-cdp.txt" 2>&1
  cp "$RUNS/cdp/cdp.json" "$SUM/q1-cdp.json" 2>/dev/null; clean cdp
fi
if has iphone; then
  log iphone
  run iphone iphone 180 WP_NO_SANDBOX=1
  $PY "$SPIKE/scripts/summarize.py" "$RUNS/iphone/iphone.json" > "$SUM/q3-iphone.txt" 2>&1
  cp "$RUNS/iphone/iphone.json" "$SUM/q3-iphone.json" 2>/dev/null; clean iphone
fi
if has sandbox; then
  # The same command list with CEF's sandbox on: the helpers start it before loading the framework (main.rs).
  log sandbox
  run cdp cdp-sandbox 180
  $PY "$SPIKE/scripts/summarize.py" "$RUNS/cdp-sandbox/cdp.json" > "$SUM/q1-cdp-sandbox.txt" 2>&1
  { echo "processes with --no-sandbox while it ran: see stderr"; tail -20 "$RUNS/cdp-sandbox/stderr.log"; } >> "$SUM/q1-cdp-sandbox.txt"; clean cdp-sandbox
fi

# ---------------------------------------------------------------- 4. what off screen leaves to build, and CEF's AX feed
if has osr; then
  log osr
  run osr osr 120 WP_NO_SANDBOX=1 WP_SCALE=2
  $PY "$SPIKE/scripts/summarize.py" "$RUNS/osr/osr.json" > "$SUM/q4-osr.txt" 2>&1
  cp "$RUNS/osr/osr.json" "$SUM/q4-offscreen-probes.json" 2>/dev/null
  cp "$RUNS/osr/ax-sample.json" "$SUM/q4-offscreen-ax-sample.json" 2>/dev/null; clean osr
fi

# ---------------------------------------------------------------- 9. codecs, played
if has media; then
  log media
  run eval media 90 WP_NO_SANDBOX=1 "WP_URL=http://127.0.0.1:8765/media.html?media=http://127.0.0.1:8770" "WP_EVAL=probe()" WP_WAIT_MS=500
  cp "$RUNS/media/eval.json" "$SUM/q9-codecs-playback.json" 2>/dev/null; clean media
fi

# ---------------------------------------------------------------- 2. embedding, in process
if has embed; then
  for path in accelerated software; do
    for view in 1280x800 2560x1600; do
      name="embed-$path-$view"; log "$name"
      run embed "$name" 60 WP_NO_SANDBOX=1 WP_PATH=$path WP_VIEW=$view WP_SCALE=1 WP_EMBED_SECONDS=20 WP_SHOT="$RUNS/$name/shot.bmp" &
      bg=$!; sleep 8
      p="$(pid_of "$name")"; [ -n "$p" ] && $PY "$HERE/treestat.py" "$p" 10 "$RUNS/$name/tree.json"
      [ "$path$view" = "accelerated1280x800" ] && screencapture -x "$SUM/q2-screen-embed.png" 2>> "$SUM/screencapture.txt"
      wait $bg
      cp "$RUNS/$name/embed.json" "$SUM/q2-$name.json" 2>/dev/null
      cp "$RUNS/$name/tree.json" "$SUM/q2-$name-tree.json" 2>/dev/null
      [ -f "$RUNS/$name/shot.bmp" ] && sips -s format png "$RUNS/$name/shot.bmp" --out "$SUM/q2-$name.png" > /dev/null 2>&1
      grep -i -E "error|fatal|metal|iosurface" "$RUNS/$name/stderr.log" | head -20 > "$SUM/q2-$name-stderr.txt"
      clean "$name"
    done
  done
fi

# ---------------------------------------------------------------- 3. the helper process: Mach link, cycles, input
if has remote; then
  log remote-cycles
  run embed remote-cycles 120 WP_NO_SANDBOX=1 WP_REMOTE=1 WP_REMOTE_CYCLES=5 WP_VIEW=1280x800 WP_SCALE=1 WP_EMBED_SECONDS=75
  cp "$RUNS/remote-cycles/embed.json" "$SUM/q3-remote-cycles.json" 2>/dev/null
  for h in "$RUNS"/remote-cycles/helper*/; do echo "$(basename "$h"): $(cat "$h/helper.json" 2>/dev/null)"; done > "$SUM/q3-remote-cycles-helpers.txt"
  rm -rf "$RUNS"/remote-cycles/helper*/cache
  log remote-input
  # One pane for 40 s: the window's own scripted input at 1.5 s, then real clicks and keys from outside.
  run embed remote-input 90 WP_NO_SANDBOX=1 WP_REMOTE=1 WP_REMOTE_HOLD_S=30 WP_VIEW=1280x800 WP_SCALE=1 WP_EMBED_SECONDS=40 WP_SELF_INPUT=1 WP_SHOT="$RUNS/remote-input/shot.bmp" WP_SHOT_FRAMES=240 &
  bg=$!; sleep 9
  p="$(pid_of remote-input)"
  if [ -n "$p" ]; then
    $PY "$HERE/treestat.py" "$p" 10 "$RUNS/remote-input/tree.json"
    "$TOOLS/macprobe" windows "$p" > "$SUM/q3-remote-window.txt" 2>&1
    "$TOOLS/macprobe" ax "$p" > "$SUM/q4-ax-offscreen-pane.txt" 2>&1
    "$TOOLS/macprobe" click "$p" 600 200 >> "$SUM/q3-remote-window.txt" 2>&1   # into the page, off the field: page takes focus
    sleep 0.5
    "$TOOLS/macprobe" click "$p" 340 76 >> "$SUM/q3-remote-window.txt" 2>&1    # the field (page 100,20)
    sleep 0.5
    "$TOOLS/macprobe" type " real keys" >> "$SUM/q3-remote-window.txt" 2>&1
    sleep 1
    screencapture -x "$SUM/q3-screen-remote.png" 2>> "$SUM/screencapture.txt"
  fi
  wait $bg
  cp "$RUNS/remote-input/embed.json" "$SUM/q3-remote-input.json" 2>/dev/null
  cp "$RUNS/remote-input/helper0/helper.json" "$SUM/q3-remote-input-helper-side.json" 2>/dev/null
  cp "$RUNS/remote-input/tree.json" "$SUM/q3-remote-input-tree.json" 2>/dev/null
  [ -f "$RUNS/remote-input/shot.bmp" ] && sips -s format png "$RUNS/remote-input/shot.bmp" --out "$SUM/q3-remote-typed.png" > /dev/null 2>&1
  rm -rf "$RUNS"/remote-input/helper*/cache
  echo "bundle processes alive after the remote runs:" > "$SUM/q3-left.txt"; pgrep -fl "$APP" >> "$SUM/q3-left.txt" || echo none >> "$SUM/q3-left.txt"
fi

# ---------------------------------------------------------------- 4. accessibility from outside: CEF's own window
if has ax; then
  log ax-windowed
  run windowed windowed 80 WP_NO_SANDBOX=1 WP_HOLD_S=25 &
  bg=$!
  for i in $(seq 1 60); do grep -q WINDOW_READY "$RUNS/windowed/stdout.log" 2>/dev/null && break; sleep 0.5; done
  p="$(pid_of windowed)"
  if [ -n "$p" ]; then
    sleep 2
    "$TOOLS/macprobe" windows "$p" > "$SUM/q4-ax-windowed.txt" 2>&1
    "$TOOLS/macprobe" ax "$p" >> "$SUM/q4-ax-windowed.txt" 2>&1
    screencapture -x "$SUM/q4-screen-windowed.png" 2>> "$SUM/screencapture.txt"
  fi
  wait $bg; clean windowed
  if ! grep -q "AXIsProcessTrusted true" "$SUM/ax-trust.txt" 2>/dev/null; then
    # Not trusted: try granting the probe in the system TCC database (works only where SIP lets root write it), then
    # say what the walk sees. This changes only this throwaway runner.
    {
      echo "--- grant attempt for $TOOLS/macprobe"
      sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, flags) VALUES ('kTCCServiceAccessibility', '$TOOLS/macprobe', 1, 2, 4, 1, 0)" 2>&1
      "$TOOLS/macprobe" trust 2>&1
    } >> "$SUM/ax-trust.txt"
  fi
fi

# ---------------------------------------------------------------- 7. start, stop
if has lifecycle; then
  log lifecycle
  $PY "$HERE/lifecycle.py" "$APP" "$RUNS/lifecycle" "http://127.0.0.1:8765/anim.html" 4 > "$SUM/q7-lifecycle.txt" 2>&1
  cp "$RUNS/lifecycle/lifecycle.json" "$SUM/q7-lifecycle.json" 2>/dev/null
  rm -rf "$RUNS"/lifecycle/run*/cache
fi

# ---------------------------------------------------------------- 7, 8, 9: size, signing, codec linkage (read only)
if has static; then
  log static
  command -v zstd > /dev/null || brew install zstd > /dev/null 2>&1
  FW="$APP/Contents/Frameworks/Chromium Embedded Framework.framework"
  {
    echo "== archive"; for a in "$(dirname "$CEF")"/*.tar.bz2; do ls -l "$a"; shasum -a 256 "$a"; done
    echo "== framework binary"; shasum -a 256 "$FW/Chromium Embedded Framework"; ls -l "$FW/Chromium Embedded Framework"
    echo "== sizes (KB)"; du -sk "$FW" "$FW/Libraries" "$FW/Resources" "$APP" 2>&1
    echo "locales: $(ls -d "$FW/Resources/"*.lproj | wc -l) folders, $(du -ck "$FW/Resources/"*.lproj | tail -1)"
    echo "== compressed, all locales"; tar -C "$(dirname "$FW")" -cf - "$(basename "$FW")" | zstd -12 -T0 -q -c | wc -c
    echo "== compressed, en only"; tar -C "$(dirname "$FW")" --exclude '*.lproj' -cf - "$(basename "$FW")" | zstd -12 -T0 -q -c | wc -c
    echo "== files"; (cd "$FW" && find . -type f | sed 's|/[^/]*\.lproj/.*|/*.lproj/...|' | sort | uniq -c | sort -rn | head -40)
    echo "== libraries"; ls -l "$FW/Libraries"
    echo "== architecture"; lipo -info "$FW/Chromium Embedded Framework"
    echo "== stripped?"; nm -a "$FW/Chromium Embedded Framework" 2>/dev/null | wc -l
  } > "$SUM/q7-size.txt" 2>&1
  {
    echo "== the framework as published"; codesign -dvvv "$FW" 2>&1
    echo "== verify"; codesign --verify --strict --verbose=2 "$FW" 2>&1
    echo "== entitlements"; codesign -d --entitlements - "$FW" 2>&1
    for lib in "$FW/Libraries/"*.dylib; do echo "== $(basename "$lib")"; codesign -dvv "$lib" 2>&1 | grep -E "Authority|TeamIdentifier|Signature|flags|Identifier"; done
    echo "== the spike's binary (linker signature only)"; codesign -dvv "$EXE" 2>&1
    echo "== Gatekeeper's view of the unsigned bundle"; spctl --assess --type execute -vv "$APP" 2>&1
    echo "== CEF's helper entitlements shipped in the distribution?"; ls "$CEF" | grep -i -E "entitle|plist" || echo "none at the top of the distribution"
  } > "$SUM/q8-signing.txt" 2>&1
  {
    echo "== linked frameworks"; otool -L "$FW/Chromium Embedded Framework" | grep -i -E "videotoolbox|audiotoolbox|coremedia|avfoundation"
    echo "== VideoToolbox decoder symbols named in the binary"; strings -a "$FW/Chromium Embedded Framework" | grep -c VTDecompressionSession
    echo "== H.264 / AAC parser and decoder names in the binary"; strings -a "$FW/Chromium Embedded Framework" | grep -c -E "^(h264|aac)$"
    echo "== proprietary_codecs in the build's args, if present"; strings -a "$FW/Chromium Embedded Framework" | grep -m3 -i "proprietary_codecs"
  } > "$SUM/q9-codecs-static.txt" 2>&1
  cp "$CEF/../archive.json" "$SUM/q7-archive.json" 2>/dev/null || cp "$CEF/archive.json" "$SUM/q7-archive.json" 2>/dev/null
fi

# ---------------------------------------------------------------- 5. its own network calls
net_capture_start() { # <run-dir>: pktap on every interface with process names, pf logging the spike's group
  local r="$1"
  sudo ifconfig pflog0 create 2>/dev/null
  echo "pass out log (all) quick proto { tcp udp } group wpnet keep state" > "$r/pf.conf"
  sudo pfctl -a com.apple/wpspike -f "$r/pf.conf" > "$r/pfctl.txt" 2>&1
  sudo pfctl -E >> "$r/pfctl.txt" 2>&1
  sudo tcpdump -n -s 128 -i pktap,all -P -w "$r/pktap.pcapng" > /dev/null 2>&1 &
  echo $! > "$r/tcpdump.pid"
  sudo tcpdump -n -e -s 128 -i pflog0 -w "$r/pflog.pcap" > /dev/null 2>&1 &
  echo $! > "$r/tcpdump-pf.pid"
  sleep 2
}
net_capture_stop() {
  local r="$1"
  sudo kill "$(cat "$r/tcpdump.pid")" "$(cat "$r/tcpdump-pf.pid")" 2>/dev/null; sleep 2
  sudo pfctl -a com.apple/wpspike -vvsr > "$r/pf-rules.txt" 2>&1
  sudo pfctl -a com.apple/wpspike -F all >> "$r/pfctl.txt" 2>&1
  sudo tcpdump -n -r "$r/pktap.pcapng" -k NP > "$r/pktap.txt" 2>/dev/null
  sudo tcpdump -n -e -r "$r/pflog.pcap" > "$r/pflog.txt" 2>/dev/null
  sudo rm -f "$r/pktap.pcapng" "$r/pflog.pcap"   # packet dumps never leave the runner
}
group_setup() { sudo dseditgroup -o read wpnet > /dev/null 2>&1 || sudo dseditgroup -o create -i 3901 wpnet; }
keychain_names() { security dump-keychain 2>/dev/null | grep -E '"svce"|"labl"' | grep -i -E "safe storage|chromium|webpane|cef" | sort | uniq -c; }

if has netdefault; then
  # CEF's defaults, 240 s with no page then 60 s with one, with extensions planted where Chrome on macOS reads other
  # programs' extensions (the macOS twin of the Windows registry finding), and the keychain watched.
  log netdefault; group_setup
  r="$RUNS/net-default"; mkdir -p "$r"
  EXT='{"external_update_url": "https://clients2.google.com/service/update2/crx"}'
  ID=ghbmnnjooekpmoecnnnilnnbdlolhkhi   # Google Docs Offline, a Google-published extension
  for d in "$HOME/Library/Application Support/Google/Chrome/External Extensions" "$HOME/Library/Application Support/Chromium/External Extensions"; do mkdir -p "$d"; echo "$EXT" > "$d/$ID.json"; done
  for d in "/Library/Application Support/Google/Chrome/External Extensions" "/Library/Application Support/Chromium/External Extensions"; do sudo mkdir -p "$d"; echo "$EXT" | sudo tee "$d/$ID.json" > /dev/null; done
  keychain_names > "$r/keychain-before.txt"
  net_capture_start "$r"
  run net net-default 420 WP_AS_GROUP=wpnet WP_NO_SANDBOX=1 WP_IDLE_S=240 WP_PAGE_S=60 "WP_SWITCHES=log-net-log=$r/netlog.json;net-log-capture-mode=Default"
  net_capture_stop "$r"
  keychain_names > "$r/keychain-after.txt"
  { echo "before:"; cat "$r/keychain-before.txt"; echo "after:"; cat "$r/keychain-after.txt"; } > "$r/keychain.txt"
  { echo "profile extension folders:"; sudo ls -la "$r/cache/profile/Extensions" 2>&1; echo "Preferences extension entries:"; sudo python3 -I -c "import json,sys; p=json.load(open(sys.argv[1])); s=p.get('extensions',{}).get('settings',{}); print(len(s), 'entries'); [print(' ', k[:6]+'…', v.get('location'), v.get('disable_reasons'), v.get('from_webstore')) for k,v in s.items()]" "$r/cache/profile/Preferences" 2>&1; } > "$r/extensions.txt"
  sudo rm -rf "$HOME/Library/Application Support/Google/Chrome/External Extensions" "$HOME/Library/Application Support/Chromium/External Extensions" "/Library/Application Support/Google/Chrome/External Extensions" "/Library/Application Support/Chromium/External Extensions"
  $PY "$HERE/summary.py" net "$r" > "$SUM/q5-net-default.txt" 2>&1
  sudo rm -rf "$r/cache"
fi
if has nethardened; then
  log nethardened; group_setup
  r="$RUNS/net-hardened"; mkdir -p "$r"
  keychain_names > "$r/keychain-before.txt"
  net_capture_start "$r"
  run net net-hardened 720 WP_AS_GROUP=wpnet WP_NO_SANDBOX=1 WP_IDLE_S=540 WP_PAGE_S=60 WP_PREFS="$PREFS" "WP_SWITCHES=log-net-log=$r/netlog.json;net-log-capture-mode=Default;use-mock-keychain;$HARD"
  net_capture_stop "$r"
  keychain_names > "$r/keychain-after.txt"
  { echo "before:"; cat "$r/keychain-before.txt"; echo "after:"; cat "$r/keychain-after.txt"; } > "$r/keychain.txt"
  $PY "$HERE/summary.py" net "$r" > "$SUM/q5-net-hardened.txt" 2>&1
  sudo rm -rf "$r/cache"
fi

# ---------------------------------------------------------------- 6. the seal, behind pf
if has seal; then
  group_setup
  IP2="$(ipconfig getifaddr en0 || ipconfig getifaddr en1)"
  echo "second address: the runner's own en0 address (reached over lo0)" > "$SUM/q6-seal-setup.txt"
  sed "s/10\.99\.0\.1/$IP2/g" "$SPIKE/server/hostile.html" > "$OUT/hostile-mac.html"
  $PY "$SPIKE/server/testserver.py" --pages "$SPIKE/server/pages" --bind "$IP2" > "$OUT/canary-second.log" 2>&1 &
  sleep 1
  sudo ifconfig pflog0 create 2>/dev/null
  for variant in "none:none" "pageonly:csp,filter,deny" "all:csp,filter,proxy,webrtc,deny" "all-hardened:csp,filter,proxy,webrtc,deny"; do
    name="seal-${variant%%:*}"; layers="${variant#*:}"; log "$name"
    r="$RUNS/$name"; mkdir -p "$r"
    {
      echo "pass out quick on lo0 all"
      echo "block drop out log quick proto { tcp udp } group wpnet"
    } > "$r/pf.conf"
    sudo pfctl -a com.apple/wpspike -f "$r/pf.conf" > "$r/pfctl.txt" 2>&1; sudo pfctl -E >> "$r/pfctl.txt" 2>&1
    sudo tcpdump -n -e -s 128 -i pflog0 -w "$r/pflog.pcap" > /dev/null 2>&1 & pf_pid=$!
    sudo tcpdump -n -l -s 256 -i pktap,all -k NP "port 53 or port 5353" > "$r/dns.txt" 2>/dev/null & dns_pid=$!
    sudo tcpdump -n -s 128 -i pktap,all -P -w "$r/pktap.pcapng" > /dev/null 2>&1 & pk_pid=$!
    sleep 2
    hard=""; prefs=""
    [ "$name" = "seal-all-hardened" ] && hard=";use-mock-keychain;$HARD" && prefs="WP_PREFS=$PREFS"
    t0=$(date +%s)
    run seal "$name" 150 WP_AS_GROUP=wpnet WP_NO_SANDBOX=1 "WP_SEAL=$layers" "WP_HOSTILE=$OUT/hostile-mac.html" "WP_SWITCHES=log-net-log=$r/netlog.json;net-log-capture-mode=Default$hard" $prefs
    sleep 2; t1=$(date +%s)
    sudo kill $pf_pid $dns_pid $pk_pid 2>/dev/null; sleep 2
    sudo pfctl -a com.apple/wpspike -vvsr > "$r/pf-rules.txt" 2>&1; sudo pfctl -a com.apple/wpspike -F all >> "$r/pfctl.txt" 2>&1
    sudo tcpdump -n -e -r "$r/pflog.pcap" > "$r/pflog.txt" 2>/dev/null
    sudo tcpdump -n -r "$r/pktap.pcapng" -k NP > "$r/pktap.txt" 2>/dev/null
    sudo rm -f "$r/pflog.pcap" "$r/pktap.pcapng"
    $PY "$HERE/summary.py" seal "$r" "$t0" "$t1" "$OUT/server.log" "$OUT/canary-second.log" > "$SUM/q6-$name.txt" 2>&1
    sudo rm -rf "$r/cache"
  done
fi

log "done"
pkill -f "testserver.py" 2>/dev/null; pkill -f "http.server 8770" 2>/dev/null
exit 0
