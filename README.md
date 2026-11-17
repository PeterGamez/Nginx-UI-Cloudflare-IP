# Cloudflare IP Plugin for Nginx UI v3

A production-ready plugin for **Nginx UI `>= 3.0.0`** that automatically fetches and synchronizes official Cloudflare edge IP ranges into Nginx UI **Access Lists**, with independent UI toggles for **IPv4**, **IPv6**, and **Combined (IPv4 & IPv6)**.

---

## Key Features

- **Triple Independent Toggles:** Independently enable, disable, or combine synchronization:
  - `Cloudflare IPv4`: Syncs 15 official Cloudflare IPv4 CIDRs.
  - `Cloudflare IPv6`: Syncs 7 official Cloudflare IPv6 CIDRs.
  - `Cloudflare Combined (IPv4 & IPv6)`: Syncs all 22 IPv4 and IPv6 CIDRs into a single Access List.
- **Strict CIDR Validation:** Fetches official ranges directly from `https://www.cloudflare.com/ips-v4` and `https://www.cloudflare.com/ips-v6`. Validates every CIDR line before updating rules. If Cloudflare returns an invalid response or network error, updates abort and existing Access List rules are preserved.
- **Automatic Lifecycle Cleanup:** When any toggle is disabled, the corresponding Access List is automatically removed from Nginx UI.
- **Multi-Node Cluster Aware:** Automatically detects the active node in multi-node clusters. The "Cloudflare IP" button dynamically verifies plugin availability on the selected node and hides itself on nodes where the plugin is not installed.
- **24-Hour Scheduled Auto-Sync:** Automatically resynchronizes Cloudflare IP ranges in the background every 24 hours while any toggle remains active.
- **Zero-Build Architecture:** Written entirely in pure, native JavaScript (`.js`) without external build tools, bundlers, or `node_modules`. Runs natively on Bun or Node.js.
- **Native Nginx UI Styling:** Frontend ES Module injects a native "Cloudflare IP" button adjacent to `+ Create Access List` with full theme adaptation (Light and Dark dashboard modes) and keyboard accessibility (`Escape`).
- **Host KV Persistence:** Toggle states, last sync timestamp, and loaded CIDR counts are persisted using the Nginx UI Host Key-Value Store (`host.kv`).

---

## Directory Structure

```text
cloudflare-ip/
├── plugin.json          # Manifest (id, version, min_nginx_ui_version, permissions, webapp, server)
├── README.md            # Installation and usage documentation
├── LICENSE              # MIT License
├── pack.sh              # Bash script to package and sign the .tar.gz archive
├── server/
│   └── server.js        # JSON-RPC 2.0 server, Cloudflare fetcher, Host KV & REST API integration
└── webapp/
    └── index.js         # Native ESM frontend component injecting button + modal into Access Lists
```

---

## Supported Platforms

This plugin is implemented in pure JavaScript (Bun / Node.js runtime) and runs on all operating systems and architectures supported by Nginx UI:
- Linux (`amd64`, `arm64`, `armv7`, etc.)
- macOS (`amd64`, `arm64` Apple Silicon)
- Windows (`amd64`, `arm64`)

---

## Architecture & Specification Compliance

This plugin strictly complies with the **Nginx UI v3 Plugin Specification** ([nginxui.com/plugin](https://nginxui.com/plugin/)):

### 1. Server Process Protocol
- **Communication:** Communicates with the Nginx UI host supervisor via newline-delimited **JSON-RPC 2.0** over `stdin` and `stdout`.
- **Supported Methods:**
  - `plugin.initialize`: Receives host metadata, settings, and granted permissions; returns API version and capability declarations (`http`).
  - `plugin.start` / `plugin.initialized`: Restores state from the Host KV store and initiates scheduled background sync.
  - `plugin.health` / `plugin.ping`: Reports heartbeat, status, uptime, and sync health.
  - `plugin.stop` / `plugin.shutdown` / `plugin.exit`: Safely terminates background timers and drains pending requests.
  - `http.handle`: Serves HTTP REST endpoints mapped behind Nginx UI authentication at `/api/plugins/com.github.petergamez.cloudflare-ip/http/*`.
- **Host API Calls:**
  - `host.kv.get`, `host.kv.set`: Used to store and retrieve `cloudflare_config`, `cloudflare_ipv4_cidrs`, and `cloudflare_ipv6_cidrs`.
  - `host.log`: Sends structured logs (`info`, `warn`, `error`) to the Nginx UI supervisor.
  - `host.notify`: Triggers system notifications on sync completion or error.

### 2. Frontend Webapp Bundle
- **Module Format:** Native ES Module registered through `window.NginxUI.registerPlugin` (`webapp.bundle_path`).
- **DOM Integration:** Uses `MutationObserver` and SPA route watchers to detect the **Access Lists** view and inject the `Cloudflare IP` button directly adjacent to the `+ Create Access List` button.
- **Node Visibility:** Inspects `registry.host.nodeId` and cluster state to ensure buttons are only rendered when viewing a node that has the plugin installed.
- **Theme Adaptation:** Automatically matches Nginx UI's light/dark mode CSS tokens.

---

## Configuration & Environment Variables

The server process uses smart defaults to connect to the local Nginx UI Host API. If your Nginx UI instance runs on a custom port or requires a service token, set the following environment variables:

| Variable | Default Value | Description |
| :--- | :--- | :--- |
| `NGINX_UI_API_URL` | `http://127.0.0.1:9000` | Base URL of Nginx UI API |
| `NGINX_UI_API_TOKEN` | *(empty)* | Optional Bearer token for Nginx UI API authorization |
| `NGINX_UI_ACCESS_LISTS_ENDPOINT` | `/api/access_lists` | Endpoint path for Nginx UI Access Lists |

---

## Packaging & Signing

Run the included `pack.sh` script to package the plugin into a standard `.tar.gz` archive conforming to all Nginx UI packaging constraints (safe relative paths, root-level manifest, no symlinks):

```bash
chmod +x pack.sh
./pack.sh keys/signing.key
```

This generates a signed archive: `com.github.petergamez.cloudflare-ip-<version>.tar.gz`.

---

## Verification & Linting

Verify package integrity and contract compliance using the official `nginx-ui` CLI:

```bash
# Lint the packaged archive
nginx-ui plugin lint com.github.petergamez.cloudflare-ip-<version>.tar.gz
```

---

## Installation in Nginx UI

### Method A: Web Dashboard (Recommended)
1. In the Nginx UI web dashboard, navigate to **Plugins** $\rightarrow$ **Install Plugin**.
2. Select **Upload Archive** and choose `com.github.petergamez.cloudflare-ip-<version>.tar.gz`.
3. Review and grant the requested permissions:
   - `kv`: Access key-value storage for settings and CIDR cache.
   - `network`: Outbound network access to fetch Cloudflare IP ranges from `www.cloudflare.com`.
   - `notify`: Send desktop / UI notification on sync completion or failure.
   - `core_api`: Manage Nginx UI Access Lists (`/api/access_lists`).
4. Click **Install & Enable**.

### Method B: CLI Installation
```bash
nginx-ui plugin install com.github.petergamez.cloudflare-ip-<version>.tar.gz
```

---

## Usage

1. Open **Access Lists** in Nginx UI.
2. Click the orange **Cloudflare IP** button in the header (next to `+ Create Access List`).
3. Toggle any of the desired options:
   - **Cloudflare IPv4 Range**
   - **Cloudflare IPv6 Range**
   - **Cloudflare Combined (IPv4 & IPv6)**
4. Click **Save & Sync** to apply changes, or **Force Sync Now** to trigger an immediate Cloudflare re-fetch.
5. In your site proxy configurations, select `Cloudflare IPv4`, `Cloudflare IPv6`, or `Cloudflare Combined (IPv4 & IPv6)` as Access Lists to ensure only legitimate Cloudflare traffic reaches your upstream origin.

---

## License

This project is licensed under the [MIT License](LICENSE).
