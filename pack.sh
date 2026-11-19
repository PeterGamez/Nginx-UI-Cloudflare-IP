#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Read plugin metadata
PLUGIN_ID=$(bun -e "console.log(require('./plugin.json').id)")
VERSION=$(bun -e "console.log(require('./plugin.json').version)")
PACKAGE_NAME="${PLUGIN_ID}-${VERSION}.tar.gz"
KEY_FILE="${1:-keys/signing.key}"

echo "=========================================="
echo " Plugin  : ${PLUGIN_ID}"
echo " Version : ${VERSION}"
echo " Package : ${PACKAGE_NAME}"
echo " Key     : ${KEY_FILE}"
echo "=========================================="

# 1. Archive
echo ""
echo "==> [1/3] Archiving files..."
rm -f "$PACKAGE_NAME"
tar -czf "$PACKAGE_NAME" plugin.json README.md LICENSE server webapp
echo "    Done: ${PACKAGE_NAME}"

# 2. Sign
echo ""
echo "==> [2/3] Signing package..."
nginx-ui plugin sign "$PACKAGE_NAME" --key "$KEY_FILE"

# 3. Lint
echo ""
echo "==> [3/3] Linting package..."
nginx-ui plugin lint "$PACKAGE_NAME"

echo ""
echo "=========================================="
echo " SUCCESS: ${PACKAGE_NAME}"
echo "=========================================="
