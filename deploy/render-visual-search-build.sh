#!/usr/bin/env bash
# Explicit build-time provisioning. Never invoked by a customer request.
set -euo pipefail
cd "$(dirname "$0")/.."
model_directory="${VISUAL_SEARCH_MODEL_DIR:?Set VISUAL_SEARCH_MODEL_DIR to an absolute private build-artifact path}"
case "$model_directory" in
  /*) ;;
  *) echo 'VISUAL_SEARCH_MODEL_DIR must be absolute' >&2; exit 1 ;;
esac
npm ci --ignore-scripts
npm run visual-search:download -- "$model_directory"
