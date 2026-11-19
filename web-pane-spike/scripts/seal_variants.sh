#!/usr/bin/env bash
# Each layer of the seal on its own and together, so the note can say which layer stops what.
set -u
cd "$(dirname "$0")/.."
for v in "seal-none:none" "seal-pageonly:csp,filter,deny" "seal-netonly:proxy,webrtc" "seal-nocsp:filter,proxy,webrtc,deny" "seal-full:csp,filter,proxy,webrtc,deny" "seal-full-nortc:csp,filter,proxy,webrtc,deny,nortc"; do
  timeout 200 ./scripts/seal.sh "${v%%:*}" "${v#*:}"
done
echo ALL DONE
