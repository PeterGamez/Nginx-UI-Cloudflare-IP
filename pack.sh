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

# Extract field from plugin.json dynamically
extract_json_field() {
  local field="$1"
  local val=""

  # 1. Try using runtime tools (bun / node / jq / python)
  if command -v bun >/dev/null 2>&1; then
    val=$(bun -e "console.log(require('./plugin.json')['$field'] || '')" 2>/dev/null || true)
  elif command -v node >/dev/null 2>&1; then
    val=$(node -e "console.log(require('./plugin.json')['$field'] || '')" 2>/dev/null || true)
  elif command -v jq >/dev/null 2>&1; then
    val=$(jq -r ".$field // empty" plugin.json 2>/dev/null || true)
  elif command -v python3 >/dev/null 2>&1; then
    val=$(python3 -c "import json; print(json.load(open('plugin.json')).get('$field', ''))" 2>/dev/null || true)
  elif command -v python >/dev/null 2>&1; then
    val=$(python -c "import json; print(json.load(open('plugin.json')).get('$field', ''))" 2>/dev/null || true)
  fi

  # 2. Pure POSIX grep & sed fallback
  if [ -z "$val" ]; then
    val=$(grep -E "\"$field\"[[:space:]]*:" plugin.json | head -n1 | sed -E "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\1/")
  fi

  echo "$val"
}

# Dynamically read id and version from plugin.json
PLUGIN_ID=$(extract_json_field "id")
VERSION=$(extract_json_field "version")

if [ -z "$PLUGIN_ID" ]; then
  echo "ERROR: Failed to extract 'id' from plugin.json." >&2
  exit 1
fi

if [ -z "$VERSION" ]; then
  echo "ERROR: Failed to extract 'version' from plugin.json." >&2
  exit 1
fi

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

# Locate signing key if available
KEY_FILE="${1:-}"
if [ -z "$KEY_FILE" ]; then
  if [ -f "keys/signing.key" ]; then
    KEY_FILE="keys/signing.key"
  elif [ -f "signing.key" ]; then
    KEY_FILE="signing.key"
  fi
fi

# Locate nginx-ui binary for signing and linting
NGINX_UI_BIN=""
if command -v nginx-ui >/dev/null 2>&1; then
  NGINX_UI_BIN="nginx-ui"
elif [ -f "/c/Users/Lenovo/Desktop/nginx-ui-bin/nginx-ui.exe" ]; then
  NGINX_UI_BIN="/c/Users/Lenovo/Desktop/nginx-ui-bin/nginx-ui.exe"
elif [ -f "C:/Users/Lenovo/Desktop/nginx-ui-bin/nginx-ui.exe" ]; then
  NGINX_UI_BIN="C:/Users/Lenovo/Desktop/nginx-ui-bin/nginx-ui.exe"
fi

# Sign package if key and nginx-ui binary exist
if [ -n "$KEY_FILE" ] && [ -f "$KEY_FILE" ]; then
  if [ -n "$NGINX_UI_BIN" ]; then
    echo "==> Signing package using key: ${KEY_FILE}..."
    "$NGINX_UI_BIN" plugin sign "$PACKAGE_NAME" --key "$KEY_FILE"
    echo "==> Package signed successfully!"
  else
    echo "NOTICE: Found signing key (${KEY_FILE}), but 'nginx-ui' CLI was not found on PATH."
    echo "        Run: nginx-ui plugin sign ${PACKAGE_NAME} --key ${KEY_FILE}"
  fi
else
  echo "NOTICE: No signing key found. Package remains unsigned (requires Developer Mode in Nginx UI)."
  echo "        To generate keys and sign, run:"
  echo "        nginx-ui plugin key init --id ${PLUGIN_ID} --out keys"
  echo "        ./pack.sh keys/signing.key"
fi

echo ""
echo "==> Archive file list and permissions:"
tar -ztvf "$PACKAGE_NAME"

if [ -n "$NGINX_UI_BIN" ]; then
  echo ""
  echo "==> Running Nginx UI linter check on package:"
  "$NGINX_UI_BIN" plugin lint "$PACKAGE_NAME" || true
fi
