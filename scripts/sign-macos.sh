#!/usr/bin/env bash
# Local ad-hoc signing; no Developer ID identity or notarization is implied.
set -euo pipefail
bundle="${1:?usage: sign-macos.sh path/to/App.app}"
codesign --force --sign - "$bundle/Contents/MacOS/latte-work-server"
codesign --force --sign - "$bundle"
codesign --verify --deep --strict "$bundle"
