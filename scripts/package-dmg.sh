#!/usr/bin/env bash
# Keep packaging tools private to this checkout's build directory.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'DMG packaging requires macOS.' >&2
  exit 2
fi
# ensurepip can spawn Python children without isolated flags.
unset PYTHONHOME PYTHONPATH
target_dir="${CARGO_TARGET_DIR:-$PWD/target}"
mkdir -p "$target_dir"
target_dir="$(cd "$target_dir" && pwd -P)"
venv="$target_dir/dmg-tools"
requirements="$PWD/scripts/dmg-requirements.txt"
venv_is_private() {
  [[ -x "$venv/bin/python" ]] && "$venv/bin/python" -I -c '
from pathlib import Path
import sys
sys.exit(sys.prefix == sys.base_prefix or Path(sys.prefix).resolve() != Path(sys.argv[1]).resolve())
' "$venv"
}
# Cached targets may retain an executable after losing pyvenv.cfg. Never let
# that interpreter install into the base Python environment.
if ! venv_is_private 2>/dev/null; then python3 -I -m venv --clear "$venv"; fi
if ! venv_is_private; then
  echo 'DMG packaging could not initialize its private Python environment.' >&2
  exit 1
fi
if ! cmp -s "$requirements" "$venv/requirements.installed"; then
  "$venv/bin/python" -I -m pip install --disable-pip-version-check -r "$requirements"
  cp "$requirements" "$venv/requirements.installed"
fi
exec "$venv/bin/python" -I scripts/package-dmg.py \
  --app "$target_dir/release/bundle/macos/Latte Work.app" \
  --output-dir "$target_dir/release/bundle/dmg" "$@"
