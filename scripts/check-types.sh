#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
output="$(mktemp -t latte-work-types.XXXXXX)"
trap 'rm -f "$output"' EXIT
cargo run -q -p latte-work-protocol --bin export-types --locked |
  node_modules/.bin/prettier --parser typescript > "$output"
cmp apps/desktop/src/protocol.ts "$output" || {
  echo 'Protocol types drifted. Run make types && make fmt.' >&2
  exit 1
}
