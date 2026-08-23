#!/bin/bash
set -e

cd "$(dirname "$0")/.."

# Load .env (handles values with spaces)
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Clean previous bundle
rm -rf src-tauri/target/release/bundle

# Build
bun tauri build "$@"

echo ""
echo "✓ Build complete! Output:"
ls -la src-tauri/target/release/bundle/macos/*.app
