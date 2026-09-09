#!/bin/bash
# From any directory: /path/to/repo/art/blender/render.sh
# Explicit fallback: art/blender/render.sh --software
# Default never silently substitutes a different renderer after Blender fails.
set -euo pipefail
ART_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BLENDER_BIN="${BLENDER_BIN:-/Applications/Blender.app/Contents/MacOS/Blender}"
ART_PYTHON="${ART_PYTHON:-/Applications/Blender.app/Contents/Resources/5.2/python/bin/python3.13}"
mkdir -p "$ART_DIR/renders" "$ART_DIR/verification"
for ART_ARG in "$@"; do
  if [[ "$ART_ARG" == --only* ]]; then
    echo 'render.sh requires a full build; use kit.py or software.py directly for --only.' >&2
    exit 2
  fi
done
if [[ "${1:-}" == "--software" ]]; then
  shift
  "$ART_PYTHON" "$ART_DIR/blender/software.py" "$@"
else
  "$BLENDER_BIN" --background --factory-startup --offline-mode --python-exit-code 1 \
    --python "$ART_DIR/blender/kit.py" -- "$@"
fi
"$ART_PYTHON" "$ART_DIR/pack.py"
