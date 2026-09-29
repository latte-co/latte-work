#!/usr/bin/env bash
# Keep packaging tools private to this checkout's build directory.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'DMG packaging requires macOS.' >&2
  exit 2
fi
target_dir="${CARGO_TARGET_DIR:-$PWD/target}"
mkdir -p "$target_dir"
target_dir="$(cd "$target_dir" && pwd -P)"
venv="$target_dir/dmg-tools"
requirements="$PWD/scripts/dmg-requirements.txt"
if [[ ! -x "$venv/bin/python" ]]; then python3 -m venv "$venv"; fi
if ! cmp -s "$requirements" "$venv/requirements.installed"; then
  "$venv/bin/python" -m pip install --disable-pip-version-check -r "$requirements"
  cp "$requirements" "$venv/requirements.installed"
fi
exec "$venv/bin/python" scripts/package-dmg.py \
  --app "$target_dir/release/bundle/macos/Latte Work.app" \
  --output-dir "$target_dir/release/bundle/dmg" "$@"
