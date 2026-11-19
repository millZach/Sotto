#!/usr/bin/env bash
# zed-sparse.sh [dir]: checks out only Zed's Apache-2.0 GPUI crates (and the Apache-2.0 crates they need) at the pinned
# revision, with no blobs of any other crate on disk, and writes a Cargo config that points the build at them:
#   cargo build --release --config "$dir-patch.toml"
# A plain `cargo build` would clone Zed's whole repository, GPL application crates included, into ~/.cargo/git.
set -euo pipefail
dir=${1:-$HOME/.cache/sotto-gpui-zed}
rev=4e161e70b5c02b0f63a50beb6937f9cd249c1678
crates=(gpui gpui_platform gpui_linux gpui_wgpu gpui_macros gpui_util gpui_shared_string gpui_windows gpui_macos gpui_ios
        gpui_web gpui_apple collections sum_tree scheduler refineable http_client bench_metrics util_macros zlog ztracing
        ztracing_macro)
[ -d "$dir/.git" ] || git clone --filter=blob:none --no-checkout --sparse https://github.com/zed-industries/zed "$dir"
cd "$dir"
paths=(/Cargo.toml /LICENSE-APACHE /tooling/perf/)
for c in "${crates[@]}"; do paths+=("/crates/$c/"); done
git sparse-checkout set --no-cone "${paths[@]}"
git checkout -q "$rev"
# Every crate checked out must be Apache-2.0.
for c in crates/* tooling/perf; do
  grep -q '^license = "Apache-2.0"' "$c/Cargo.toml" || { echo "not Apache-2.0: $c" >&2; exit 1; }
done
{ echo '[patch."https://github.com/zed-industries/zed"]'
  for c in crates/* crates/refineable/derive_refineable tooling/perf; do
    name=$(sed -n 's/^name = "\(.*\)"/\1/p' "$c/Cargo.toml" | head -1)
    echo "$name = { path = \"$dir/$c\" }"
  done; } > "$dir-patch.toml"
echo "wrote $dir-patch.toml"
