#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mode="${1:-dev}"
case "$mode" in dev|build|package|prepare) ;; *) echo 'usage: desktop.sh dev|build|package' >&2; exit 2;; esac
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target}"
if command -v sccache >/dev/null && [[ -z "${RUSTC_WRAPPER:-}" ]]; then export RUSTC_WRAPPER=sccache; fi
profile=debug
flags=(--locked)
if [[ "$mode" == package ]]; then profile=release; flags+=(--release); fi
cargo build -p latte-work-server "${flags[@]}"
triple="$(rustc -vV | sed -n 's/^host: //p')"
mkdir -p apps/desktop/src-tauri/binaries
cp "$CARGO_TARGET_DIR/$profile/latte-work-server" "apps/desktop/src-tauri/binaries/latte-work-server-$triple"
if [[ "$mode" == prepare ]]; then exit 0; fi
cd apps/desktop
case "$mode" in
 dev) exec ../../node_modules/.bin/tauri dev ;;
 build) ../../node_modules/.bin/tauri build --debug --bundles app ;;
 package) ../../node_modules/.bin/tauri build ;;
esac

if [[ "$(uname -s)" == Darwin ]]; then
  ../../scripts/sign-macos.sh "$CARGO_TARGET_DIR/$profile/bundle/macos/Latte Work.app"
fi
