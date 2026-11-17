/**
 * Cloudflare Access Plugin for Nginx UI v3.0.3+
 * JSON-RPC 2.0 Server, Cloudflare IP Sync Engine & Host API Integration
 *
 * Runtime: Bun or Node.js (Zero external dependencies)
 * Protocol: JSON-RPC 2.0 over stdin / stdout
 */

const readline = require('node:readline');
const https = require('node:https');
const http = require('node:http');
const net = require('node:net');

// Plugin Constants
let PLUGIN_ID = 'com.github.petergamez.cloudflare-ip';
try {
  const manifest = require('../plugin.json');
  if (manifest && manifest.id) {
    PLUGIN_ID = manifest.id;
  }
} catch (_) {}
const API_VERSION = 1;

const CF_IPV4_URL = 'https://www.cloudflare.com/ips-v4';
const CF_IPV6_URL = 'https://www.cloudflare.com/ips-v6';

const LIST_NAME_IPV4 = 'Cloudflare IPv4';
const LIST_NAME_IPV6 = 'Cloudflare IPv6';
const LIST_NAME_COMBINED = 'Cloudflare Combined (IPv4 & IPv6)';

const AUTO_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Configurable Host API Settings (Environment Variables with Smart Defaults)
let NGINX_UI_API_URL = process.env.NGINX_UI_CTL_ENDPOINT || process.env.NGINX_UI_API_URL || 'http://127.0.0.1:9000';
let NGINX_UI_API_TOKEN = process.env.NGINX_UI_CTL_TOKEN || process.env.NGINX_UI_API_TOKEN || '';
let NGINX_UI_ACCESS_LISTS_ENDPOINT = process.env.NGINX_UI_ACCESS_LISTS_ENDPOINT || '/api/access_lists';

// State Management
let isInitialized = false;
let autoSyncTimer = null;
let reqIdCounter = 0;
const pendingHostRequests = new Map();

// Local Memory Cache (acts as resilient fallback for Host KV Store)
const localKvCache = new Map();

// Default Plugin Configuration
let currentConfig = {
  ipv4_enabled: true,
  ipv6_enabled: true,
  combined_enabled: true,
  last_sync: null,
  ipv4_count: 0,
  ipv6_count: 0,
  combined_count: 0,
  status: 'idle',
  message: 'Plugin initialized. Awaiting first synchronization.'
};

let cachedIPv4 = [];
let cachedIPv6 = [];

// ==========================================
// 1. JSON-RPC Communication Utilities
// ==========================================

function sendJsonRpc(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function sendResponse(id, result) {
  sendJsonRpc({
    jsonrpc: '2.0',
    id: id,
    result: result
  });
}

function sendError(id, code, message, data = null) {
  sendJsonRpc({
    jsonrpc: '2.0',
    id: id,
    error: {
      code: code,
      message: message,
      ...(data !== null ? { data } : {})
    }
  });
}

function callHost(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `host_req_${++reqIdCounter}`;
    const timer = setTimeout(() => {
      if (pendingHostRequests.has(id)) {
        pendingHostRequests.delete(id);
        reject(new Error(`Host call timed out for method: ${method} (id: ${id})`));
      }
    }, 6000);

    pendingHostRequests.set(id, { resolve, reject, timer });

    sendJsonRpc({
      jsonrpc: '2.0',
      id: id,
      method: method,
      params: params
    });
  });
}

async function hostLog(level, message, fields = {}) {
  try {
    await callHost('host.log', { level, message, fields });
  } catch (_) {
    // Non-critical, fallback to stderr
    process.stderr.write(`[${level.toUpperCase()}] ${message}\n`);
  }
}

async function hostNotify(level, message, details = '') {
  try {
    await callHost('host.notify', { level, message, details });
  } catch (_) {
    // Non-critical
  }
}

// ==========================================
// 2. Host KV Store Operations
// ==========================================

async function getKv(key) {
  try {
    const res = await callHost('host.kv.get', { key });
    if (res && res.value !== undefined) {
      localKvCache.set(key, res.value);
      return res.value;
    }
  } catch (err) {
    // If Host KV call fails (e.g. standalone test mode or permission pending)
  }
  return localKvCache.get(key) || null;
}

async function setKv(key, value) {
  localKvCache.set(key, value);
  try {
    await callHost('host.kv.set', { key, value });
  } catch (err) {
    // Fallback in memory
  }
}

// ==========================================
// 3. CIDR Validation & Cloudflare Fetcher
// ==========================================

function isValidIPv4CIDR(line) {
  if (typeof line !== 'string') return false;
  const trimmed = line.trim();
  const parts = trimmed.split('/');
  if (parts.length !== 2) return false;

  const [ip, prefixStr] = parts;
  if (!net.isIPv4(ip)) return false;

  const prefix = Number(prefixStr);
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= 32;
}

function isValidIPv6CIDR(line) {
  if (typeof line !== 'string') return false;
  const trimmed = line.trim();
  const parts = trimmed.split('/');
  if (parts.length !== 2) return false;

  const [ip, prefixStr] = parts;
  if (!net.isIPv6(ip)) return false;

  const prefix = Number(prefixStr);
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= 128;
}

function fetchUrl(targetUrl, timeoutMs = 10000) {
  if (typeof fetch === 'function') {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(targetUrl, { signal: controller.signal })
      .then(async (res) => {
        clearTimeout(timeout);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        return res.text();
      })
      .catch((err) => {
        clearTimeout(timeout);
        throw err;
      });
  }

  // Fallback to node:https
  return new Promise((resolve, reject) => {
    const req = https.get(targetUrl, { timeout: timeoutMs }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode} from ${targetUrl}`));
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${targetUrl}`));
    });

    req.on('error', reject);
  });
}

async function fetchAndValidateCIDRs() {
  const errors = [];
  let ipv4List = [];
  let ipv6List = [];

  // Fetch IPv4
  try {
    const rawIPv4 = await fetchUrl(CF_IPV4_URL);
    const lines = rawIPv4.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    if (lines.length === 0) {
      throw new Error('Received empty IPv4 CIDR list from Cloudflare');
    }

    for (const line of lines) {
      if (!isValidIPv4CIDR(line)) {
        throw new Error(`Invalid IPv4 CIDR detected: "${line}"`);
      }
    }
    ipv4List = lines;
  } catch (err) {
    errors.push(`IPv4 fetch/validation failed: ${err.message}`);
  }

  // Fetch IPv6
  try {
    const rawIPv6 = await fetchUrl(CF_IPV6_URL);
    const lines = rawIPv6.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

    if (lines.length === 0) {
      throw new Error('Received empty IPv6 CIDR list from Cloudflare');
    }

    for (const line of lines) {
      if (!isValidIPv6CIDR(line)) {
        throw new Error(`Invalid IPv6 CIDR detected: "${line}"`);
      }
    }
    ipv6List = lines;
  } catch (err) {
    errors.push(`IPv6 fetch/validation failed: ${err.message}`);
  }

  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }

  return { ipv4: ipv4List, ipv6: ipv6List };
}

// ==========================================
// 4. Nginx UI Access Lists REST API Client
// ==========================================

function makeNginxUiApiRequest(endpointPath, method = 'GET', body = null) {
  const fullUrl = new URL(endpointPath, NGINX_UI_API_URL).toString();
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };

  if (NGINX_UI_API_TOKEN) {
    headers['Authorization'] = `Bearer ${NGINX_UI_API_TOKEN}`;
  }

  if (typeof fetch === 'function') {
    const opts = {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined
    };
    return fetch(fullUrl, opts).then(async (res) => {
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) { json = text; }
      return { status: res.status, ok: res.ok, data: json };
    });
  }

  // Node http/https client fallback
  return new Promise((resolve, reject) => {
    const parsed = new URL(fullUrl);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(parsed, {
      method: method,
      headers: headers
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { json = data; }
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data: json });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function getExistingAccessLists() {
  const candidateEndpoints = [
    '/api/access_lists',
    '/api/access_list',
    '/api/access-lists',
    NGINX_UI_ACCESS_LISTS_ENDPOINT
  ];

  for (const endpoint of candidateEndpoints) {
    try {
      const res = await makeNginxUiApiRequest(endpoint, 'GET');
      if (res.ok && res.data) {
        // Nginx UI may wrap results in data or return array directly
        const list = Array.isArray(res.data) ? res.data : (res.data.data || res.data.items || []);
        if (Array.isArray(list)) {
          return { endpoint, list };
        }
      }
    } catch (_) {
      // Try next endpoint candidate
    }
  }

  return { endpoint: '/api/access_lists', list: [] };
}

function buildAccessListPayload(name, cidrs) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  return {
    name: name,
    slug: slug,
    fallback: 'deny',
    rules: cidrs.map(cidr => ({
      type: 'allow',
      value: cidr,
      note: 'Cloudflare IP'
    }))
  };
}

async function syncAccessList(name, isEnabled, cidrs, existingLists, baseEndpoint) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
  const existing = existingLists.find(item => item && (item.name === name || item.slug === slug));

  if (isEnabled) {
    const payload = buildAccessListPayload(name, cidrs);
    if (existing && existing.id !== undefined) {
      // Update existing list (Nginx UI v3 updateItem uses POST /access_lists/:id or PUT)
      const updateUrl = `${baseEndpoint}/${existing.id}`;
      let res = await makeNginxUiApiRequest(updateUrl, 'POST', payload);
      if (!res.ok) {
        res = await makeNginxUiApiRequest(updateUrl, 'PUT', payload);
      }
      if (!res.ok) {
        let errorDetail = '';
        if (res.data) {
          errorDetail = typeof res.data === 'object' ? (res.data.message || JSON.stringify(res.data)) : String(res.data);
        }
        throw new Error(`Failed to update Access List "${name}" (ID ${existing.id}): HTTP ${res.status}${errorDetail ? ' (' + errorDetail + ')' : ''}`);
      }
      return `Updated Access List "${name}" with ${cidrs.length} CIDRs.`;
    } else {
      // Create new list
      let res = await makeNginxUiApiRequest(baseEndpoint, 'POST', payload);
      // Fallback: if baseEndpoint gave 404, try alternate plural/singular
      if (!res.ok && res.status === 404) {
        const altEndpoint = baseEndpoint.endsWith('s') ? baseEndpoint.slice(0, -1) : `${baseEndpoint}s`;
        const altRes = await makeNginxUiApiRequest(altEndpoint, 'POST', payload);
        if (altRes.ok) {
          res = altRes;
        }
      }
      if (!res.ok) {
        let errorDetail = '';
        if (res.data) {
          errorDetail = typeof res.data === 'object' ? (res.data.message || JSON.stringify(res.data)) : String(res.data);
        }
        throw new Error(`Failed to create Access List "${name}": HTTP ${res.status}${errorDetail ? ' (' + errorDetail + ')' : ''}`);
      }
      return `Created Access List "${name}" with ${cidrs.length} CIDRs.`;
    }
  } else {
    // Disabled: remove if exists
    if (existing && existing.id !== undefined) {
      const deleteUrl = `${baseEndpoint}/${existing.id}`;
      const res = await makeNginxUiApiRequest(deleteUrl, 'DELETE');
      if (!res.ok && res.status !== 404) {
        let errorDetail = '';
        if (res.data) {
          errorDetail = typeof res.data === 'object' ? (res.data.message || JSON.stringify(res.data)) : String(res.data);
        }
        throw new Error(`Failed to delete Access List "${name}" (ID ${existing.id}): HTTP ${res.status}${errorDetail ? ' (' + errorDetail + ')' : ''}`);
      }
      return `Removed Access List "${name}" as it is disabled.`;
    }
    return `Access List "${name}" is disabled and not present.`;
  }
}

// ==========================================
// 5. Core Synchronization Orchestrator
// ==========================================

async function performSync(force = false) {
  currentConfig.status = 'syncing';
  currentConfig.message = 'Fetching official Cloudflare IP ranges...';
  await setKv('cloudflare_config', currentConfig);

  let newCidrs = null;
  try {
    newCidrs = await fetchAndValidateCIDRs();
  } catch (fetchErr) {
    // Abort and preserve existing rules if Cloudflare returns an empty or invalid response
    currentConfig.status = 'error';
    currentConfig.message = `Sync aborted: ${fetchErr.message}. Existing rules preserved.`;
    await setKv('cloudflare_config', currentConfig);
    await hostLog('error', `Cloudflare sync aborted: ${fetchErr.message}`);
    await hostNotify('error', 'Cloudflare IP Sync Failed', fetchErr.message);
    return { ok: false, message: currentConfig.message };
  }

  cachedIPv4 = newCidrs.ipv4;
  cachedIPv6 = newCidrs.ipv6;
  await setKv('cloudflare_ipv4_cidrs', cachedIPv4);
  await setKv('cloudflare_ipv6_cidrs', cachedIPv6);

  // Sync to Nginx UI Access Lists
  const actionsTaken = [];
  try {
    const { endpoint, list } = await getExistingAccessLists();

    // IPv4 sync
    const ipv4Msg = await syncAccessList(
      LIST_NAME_IPV4,
      currentConfig.ipv4_enabled,
      cachedIPv4,
      list,
      endpoint
    );
    actionsTaken.push(ipv4Msg);

    // IPv6 sync
    const ipv6Msg = await syncAccessList(
      LIST_NAME_IPV6,
      currentConfig.ipv6_enabled,
      cachedIPv6,
      list,
      endpoint
    );
    actionsTaken.push(ipv6Msg);

    // Combined (IPv4 + IPv6) sync
    const combinedCidrs = [...cachedIPv4, ...cachedIPv6];
    const combinedMsg = await syncAccessList(
      LIST_NAME_COMBINED,
      currentConfig.combined_enabled,
      combinedCidrs,
      list,
      endpoint
    );
    actionsTaken.push(combinedMsg);

    currentConfig.status = 'success';
    currentConfig.last_sync = new Date().toISOString();
    currentConfig.ipv4_count = currentConfig.ipv4_enabled ? cachedIPv4.length : 0;
    currentConfig.ipv6_count = currentConfig.ipv6_enabled ? cachedIPv6.length : 0;
    currentConfig.combined_count = currentConfig.combined_enabled ? combinedCidrs.length : 0;
    currentConfig.message = actionsTaken.join(' ');

    await setKv('cloudflare_config', currentConfig);
    await hostLog('info', `Cloudflare sync successful: ${currentConfig.message}`);
    await hostNotify('success', 'Cloudflare IP Synced', currentConfig.message);

    return { ok: true, message: currentConfig.message, config: currentConfig };
  } catch (apiErr) {
    // Note: If Nginx UI REST API is not reachable on localhost or uses custom credentials,
    // preserve the valid CIDRs in Host KV Store and notify user.
    currentConfig.status = 'warning';
    currentConfig.last_sync = new Date().toISOString();
    currentConfig.ipv4_count = cachedIPv4.length;
    currentConfig.ipv6_count = cachedIPv6.length;
    currentConfig.combined_count = cachedIPv4.length + cachedIPv6.length;
    currentConfig.message = `CIDRs validated (${cachedIPv4.length} IPv4, ${cachedIPv6.length} IPv6) & saved to KV Store. Nginx UI API note: ${apiErr.message}`;

    await setKv('cloudflare_config', currentConfig);
    await hostLog('warn', currentConfig.message);

    return { ok: true, warning: true, message: currentConfig.message, config: currentConfig };
  }
}

function updateAutoSyncSchedule() {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer);
    autoSyncTimer = null;
  }

  // Schedule auto-sync every 24 hours if any toggle is enabled
  if (currentConfig.ipv4_enabled || currentConfig.ipv6_enabled || currentConfig.combined_enabled) {
    autoSyncTimer = setInterval(() => {
      hostLog('info', 'Triggering 24-hour background Cloudflare auto-sync...');
      performSync(false).catch(err => {
        hostLog('error', `Background auto-sync error: ${err.message}`);
      });
    }, AUTO_SYNC_INTERVAL_MS);
  }
}

// ==========================================
// 6. HTTP API Dispatcher (http.handle)
// ==========================================

function makeHttpResponse(id, statusCode, data, extraHeaders = {}) {
  const jsonStr = typeof data === 'string' ? data : JSON.stringify(data);
  const bodyBase64 = Buffer.from(jsonStr, 'utf8').toString('base64');

  return {
    jsonrpc: '2.0',
    id: id,
    result: {
      status: statusCode,
      headers: {
        'Content-Type': ['application/json'],
        ...extraHeaders
      },
      body_base64: bodyBase64
    }
  };
}

async function handleHttpRequest(id, params) {
  const method = (params.method || 'GET').toUpperCase();
  let path = params.path || '/';

  // Normalize path by stripping plugin HTTP prefix if present
  const prefix = `/api/plugins/${PLUGIN_ID}/http`;
  if (path.startsWith(prefix)) {
    path = path.slice(prefix.length) || '/';
  }

  // Decode request body if provided
  let bodyJson = {};
  try {
    let rawBody = '';
    if (params.body_base64) {
      rawBody = Buffer.from(params.body_base64, 'base64').toString('utf8');
    } else if (params.body) {
      rawBody = typeof params.body === 'string' ? params.body : JSON.stringify(params.body);
    }
    if (rawBody.trim()) {
      bodyJson = JSON.parse(rawBody);
    }
  } catch (_) {
    bodyJson = {};
  }

  // Route: GET /status or GET /api/status
  if ((path === '/status' || path === '/api/status' || path === '/') && method === 'GET') {
    return sendJsonRpc(makeHttpResponse(id, 200, {
      ok: true,
      config: currentConfig,
      cached_ipv4_count: cachedIPv4.length,
      cached_ipv6_count: cachedIPv6.length
    }));
  }

  // Route: POST /save or POST /api/save
  if ((path === '/save' || path === '/api/save') && method === 'POST') {
    if (typeof bodyJson.ipv4_enabled === 'boolean') {
      currentConfig.ipv4_enabled = bodyJson.ipv4_enabled;
    }
    if (typeof bodyJson.ipv6_enabled === 'boolean') {
      currentConfig.ipv6_enabled = bodyJson.ipv6_enabled;
    }
    if (typeof bodyJson.combined_enabled === 'boolean') {
      currentConfig.combined_enabled = bodyJson.combined_enabled;
    }

    await setKv('cloudflare_config', currentConfig);
    updateAutoSyncSchedule();

    // Trigger sync/update according to newly saved toggle states
    const syncRes = await performSync(false);

    return sendJsonRpc(makeHttpResponse(id, 200, {
      ok: true,
      message: 'Configuration saved and synchronization performed.',
      sync: syncRes,
      config: currentConfig,
      ipv4: cachedIPv4,
      ipv6: cachedIPv6,
      combined: [...cachedIPv4, ...cachedIPv6]
    }));
  }

  // Route: POST /sync or POST /api/sync
  if ((path === '/sync' || path === '/api/sync') && method === 'POST') {
    const syncRes = await performSync(true);
    return sendJsonRpc(makeHttpResponse(id, 200, {
      ok: true,
      message: 'Forced synchronization completed.',
      sync: syncRes,
      config: currentConfig,
      ipv4: cachedIPv4,
      ipv6: cachedIPv6,
      combined: [...cachedIPv4, ...cachedIPv6]
    }));
  }

  // Route: GET /cidrs or GET /api/cidrs
  if ((path === '/cidrs' || path === '/api/cidrs') && method === 'GET') {
    return sendJsonRpc(makeHttpResponse(id, 200, {
      ok: true,
      ipv4: cachedIPv4,
      ipv6: cachedIPv6
    }));
  }

  // 404 Not Found
  return sendJsonRpc(makeHttpResponse(id, 404, {
    ok: false,
    error: `Endpoint not found: ${method} ${path}`
  }));
}

// ==========================================
// 7. JSON-RPC 2.0 Inbound Dispatcher
// ==========================================

async function handleIncomingMessage(msg) {
  // Check if this is a response to an outgoing Host call
  if (msg.id && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
    const pending = pendingHostRequests.get(msg.id);
    if (pending) {
      clearTimeout(pending.timer);
      pendingHostRequests.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message || `RPC Error ${msg.error.code}`));
      } else {
        pending.resolve(msg.result);
      }
    }
    return;
  }

  const { id, method, params } = msg;
  if (!method) return;

  switch (method) {
    // 1. Handshake Lifecycle: plugin.initialize
    case 'plugin.initialize': {
      isInitialized = true;
      if (params) {
        if (params.ctl_endpoint) NGINX_UI_API_URL = params.ctl_endpoint;
        if (params.ctl_token) NGINX_UI_API_TOKEN = params.ctl_token;
        if (params.host_endpoint) NGINX_UI_API_URL = params.host_endpoint;
        if (params.token) NGINX_UI_API_TOKEN = params.token;
        if (params.settings) {
          if (typeof params.settings.ipv4_enabled === 'boolean') {
            currentConfig.ipv4_enabled = params.settings.ipv4_enabled;
          }
          if (typeof params.settings.ipv6_enabled === 'boolean') {
            currentConfig.ipv6_enabled = params.settings.ipv6_enabled;
          }
          if (typeof params.settings.combined_enabled === 'boolean') {
            currentConfig.combined_enabled = params.settings.combined_enabled;
          }
        }
      }

      sendResponse(id, {
        api_version: API_VERSION,
        capabilities: ['http']
      });
      break;
    }

    // 2. Lifecycle Start: plugin.start or notification plugin.initialized
    case 'plugin.start':
    case 'plugin.initialized': {
      // Restore persisted configuration from Host KV Store
      try {
        const saved = await getKv('cloudflare_config');
        if (saved && typeof saved === 'object') {
          currentConfig = { ...currentConfig, ...saved };
        }
        const savedV4 = await getKv('cloudflare_ipv4_cidrs');
        if (Array.isArray(savedV4)) cachedIPv4 = savedV4;
        const savedV6 = await getKv('cloudflare_ipv6_cidrs');
        if (Array.isArray(savedV6)) cachedIPv6 = savedV6;
      } catch (_) {}

      updateAutoSyncSchedule();

      // Trigger initial sync if enabled and never synced before
      if ((currentConfig.ipv4_enabled || currentConfig.ipv6_enabled || currentConfig.combined_enabled) && !currentConfig.last_sync) {
        performSync(false).catch(() => {});
      }

      if (id !== undefined) {
        sendResponse(id, { started: true });
      }
      break;
    }

    // 3. Health Check: plugin.health / plugin.ping
    case 'plugin.health':
    case 'plugin.ping': {
      sendResponse(id, {
        status: 'ok',
        healthy: true,
        uptime: process.uptime(),
        last_sync: currentConfig.last_sync
      });
      break;
    }

    // 4. Lifecycle Shutdown: plugin.stop / plugin.shutdown / plugin.exit
    case 'plugin.stop':
    case 'plugin.shutdown':
    case 'plugin.exit': {
      if (autoSyncTimer) {
        clearInterval(autoSyncTimer);
        autoSyncTimer = null;
      }
      if (id !== undefined) {
        sendResponse(id, {});
      }
      if (method === 'plugin.exit') {
        process.exit(0);
      }
      break;
    }

    // 5. Capability HTTP Handling: http.handle
    case 'http.handle': {
      await handleHttpRequest(id, params || {});
      break;
    }

    default: {
      if (id !== undefined) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
      break;
    }
  }
}

// ==========================================
// 8. Stdio Stream Listener & Process Startup
// ==========================================

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (rawLine) => {
  const line = rawLine.trim();
  if (!line) return;

  try {
    const msg = JSON.parse(line);
    handleIncomingMessage(msg).catch((err) => {
      hostLog('error', `Error handling RPC message: ${err.message}`);
    });
  } catch (err) {
    sendError(null, -32700, 'Parse error: Invalid JSON');
  }
});

process.on('SIGTERM', () => {
  if (autoSyncTimer) clearInterval(autoSyncTimer);
  process.exit(0);
});

process.on('SIGINT', () => {
  if (autoSyncTimer) clearInterval(autoSyncTimer);
  process.exit(0);
});
