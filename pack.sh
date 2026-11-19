#!/usr/bin/env bash
# ==============================================================================
# Cloudflare Access Plugin Packaging & Signing Script for Nginx UI v3
# Creates a standard .tar.gz archive complying with Nginx UI packaging constraints.
# Dynamically reads 'id' and 'version' from plugin.json and signs the package.
# ==============================================================================

set -euo pipefail

# Ensure working directory is the script root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Validate required files exist prior to packaging
for required_file in "plugin.json" "README.md" "LICENSE" "server/server.js" "webapp/index.js"; do
  if [ ! -f "$required_file" ]; then
    echo "ERROR: Missing required file '$required_file'. Aborting." >&2
    exit 1
  fi
done

# Read id and version from plugin.json using bun
PLUGIN_ID=$(bun -e "console.log(require('./plugin.json').id)")
VERSION=$(bun -e "console.log(require('./plugin.json').version)")

PACKAGE_NAME="${PLUGIN_ID}-${VERSION}.tar.gz"

echo "==> Packaging Nginx UI plugin: ${PLUGIN_ID} (version: ${VERSION})..."

# Clean up previous archive if present
rm -f "$PACKAGE_NAME"

# Collect list of files to pack
FILES_TO_PACK=(plugin.json README.md LICENSE server webapp)
if [ -f "plugin.signer" ] && [ -f "plugin.signer.minisig" ]; then
  FILES_TO_PACK+=(plugin.signer plugin.signer.minisig)
fi

# Build .tar.gz archive with safe relative paths and no dereference/symlink issues
tar -czvf "$PACKAGE_NAME" \
  --exclude='.git' \
  --exclude='.github' \
  --exclude='*.tar.gz' \
  --exclude='pack.sh' \
  --exclude='keys' \
  --exclude='.DS_Store' \
  --exclude='Thumbs.db' \
  "${FILES_TO_PACK[@]}"

echo ""
echo "==> Package created successfully: ${PACKAGE_NAME}"

# Signing key and nginx-ui binary
KEY_FILE="${1:-keys/signing.key}"
NGINX_UI_BIN="nginx-ui"

echo "==> Signing package using key: ${KEY_FILE}..."
"$NGINX_UI_BIN" plugin sign "$PACKAGE_NAME" --key "$KEY_FILE"
echo "==> Package signed successfully!"

echo ""
echo "==> Archive file list and permissions:"
tar -ztvf "$PACKAGE_NAME"

echo ""
echo "==> Running Nginx UI linter check on package:"
"$NGINX_UI_BIN" plugin lint "$PACKAGE_NAME"
