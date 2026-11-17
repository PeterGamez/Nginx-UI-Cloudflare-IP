/**
 * Cloudflare Access Plugin for Nginx UI v3.0.0+
 * Frontend Native ES Module Webapp
 *
 * Injects "Cloudflare IP" button and configuration modal into Nginx UI Access Lists page.
 * Multi-node cluster aware: dynamically verifies plugin installation and hides button on nodes without the plugin.
 * Zero-build pure JavaScript (No Vue/React/Node build dependencies).
 */

(function () {
  'use strict';

  let PLUGIN_ID = 'com.github.petergamez.cloudflare-ip';
  try {
    const scriptSrc = document.currentScript && document.currentScript.src ? document.currentScript.src : '';
    const match = scriptSrc.match(/\/(?:api\/)?plugins\/([^/?#]+)/);
    if (match && match[1]) {
      PLUGIN_ID = match[1];
    }
  } catch (_) {}

  // State
  let pluginRegistry = null;
  let pluginHttp = null;
  let coreHttp = null;
  let modalInstance = null;
  let isSaving = false;
  let isSyncing = false;

  // Multi-Node State Tracking
  let lastKnownNodeId = null;
  const nodeAvailabilityMap = new Map(); // nodeId (string) -> { active: boolean, timestamp: number }
  let isCheckingNodeStatus = false;

  let pluginConfig = {
    ipv4_enabled: true,
    ipv6_enabled: true,
    combined_enabled: true,
    last_sync: null,
    ipv4_count: 0,
    ipv6_count: 0,
    combined_count: 0,
    status: 'idle',
    message: 'Loading configuration...'
  };

  // ==========================================
  // 1. CSS & Theme Styles Injection
  // ==========================================

  const STYLES = `
    /* Button next to Create Access List */
    .cf-access-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 32px;
      padding: 4px 14px;
      font-size: 14px;
      font-weight: 500;
      line-height: 1.5;
      border-radius: 6px;
      border: 1px solid #f38020;
      background: #f38020;
      color: #ffffff !important;
      cursor: pointer;
      user-select: none;
      transition: all 0.2s cubic-bezier(0.645, 0.045, 0.355, 1);
      box-shadow: 0 2px 0 rgba(243, 128, 32, 0.1);
      margin-left: 8px;
      text-decoration: none;
    }
    .cf-access-btn:hover {
      background: #fa8c16;
      border-color: #fa8c16;
      box-shadow: 0 2px 8px rgba(243, 128, 32, 0.35);
      color: #ffffff !important;
    }
    .cf-access-btn:active {
      background: #d46b08;
      border-color: #d46b08;
    }
    .cf-access-btn svg {
      width: 16px;
      height: 16px;
      fill: currentColor;
    }

    /* Modal Overlay */
    .cf-modal-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      opacity: 0;
      transition: opacity 0.25s ease;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    }
    .cf-modal-backdrop.cf-show {
      opacity: 1;
    }

    /* Modal Dialog Window */
    .cf-modal-dialog {
      width: 520px;
      max-width: 92vw;
      background: var(--cf-bg, #ffffff);
      color: var(--cf-text, #1f1f1f);
      border-radius: 10px;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.3), 0 10px 10px -5px rgba(0, 0, 0, 0.2);
      border: 1px solid var(--cf-border, #e8e8e8);
      overflow: hidden;
      transform: translateY(20px) scale(0.98);
      transition: transform 0.25s ease;
    }
    .cf-modal-backdrop.cf-show .cf-modal-dialog {
      transform: translateY(0) scale(1);
    }

    /* Theme Detection Variables */
    :root, [data-theme='light'] {
      --cf-bg: #ffffff;
      --cf-card-bg: #f9f9f9;
      --cf-text: #1f1f1f;
      --cf-text-secondary: #666666;
      --cf-border: #e8e8e8;
      --cf-toggle-off: #bfbfbf;
    }
    [data-theme='dark'], .dark, body.dark {
      --cf-bg: #1f1f1f;
      --cf-card-bg: #141414;
      --cf-text: #e6e6e6;
      --cf-text-secondary: #999999;
      --cf-border: #303030;
      --cf-toggle-off: #434343;
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme='light']) {
        --cf-bg: #1f1f1f;
        --cf-card-bg: #141414;
        --cf-text: #e6e6e6;
        --cf-text-secondary: #999999;
        --cf-border: #303030;
        --cf-toggle-off: #434343;
      }
    }

    /* Modal Header */
    .cf-modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid var(--cf-border);
    }
    .cf-modal-title {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 17px;
      font-weight: 600;
      margin: 0;
    }
    .cf-modal-title svg {
      width: 24px;
      height: 24px;
      fill: #f38020;
    }
    .cf-modal-close {
      background: transparent;
      border: none;
      font-size: 20px;
      line-height: 1;
      cursor: pointer;
      color: var(--cf-text-secondary);
      padding: 4px 8px;
      border-radius: 4px;
      transition: all 0.15s;
    }
    .cf-modal-close:hover {
      background: var(--cf-card-bg);
      color: var(--cf-text);
    }

    /* Modal Body */
    .cf-modal-body {
      padding: 20px;
      max-height: 70vh;
      overflow-y: auto;
    }
    .cf-desc-text {
      font-size: 13.5px;
      color: var(--cf-text-secondary);
      margin: 0 0 16px 0;
      line-height: 1.5;
    }

    /* Toggle Item Cards */
    .cf-toggle-group {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 20px;
    }
    .cf-toggle-card {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
      background: var(--cf-card-bg);
      border: 1px solid var(--cf-border);
      border-radius: 8px;
      transition: border-color 0.2s;
    }
    .cf-toggle-card:hover {
      border-color: #f38020;
    }
    .cf-toggle-info {
      flex: 1;
      padding-right: 16px;
    }
    .cf-toggle-title {
      font-size: 14.5px;
      font-weight: 600;
      margin: 0 0 4px 0;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .cf-toggle-desc {
      font-size: 12.5px;
      color: var(--cf-text-secondary);
      margin: 0;
      line-height: 1.4;
    }

    /* Switch Styling */
    .cf-switch {
      position: relative;
      display: inline-block;
      width: 44px;
      height: 22px;
      flex-shrink: 0;
    }
    .cf-switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .cf-slider {
      position: absolute;
      cursor: pointer;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background-color: var(--cf-toggle-off);
      transition: 0.25s;
      border-radius: 22px;
    }
    .cf-slider:before {
      position: absolute;
      content: "";
      height: 16px;
      width: 16px;
      left: 3px;
      bottom: 3px;
      background-color: white;
      transition: 0.25s;
      border-radius: 50%;
      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
    }
    .cf-switch input:checked + .cf-slider {
      background-color: #f38020;
    }
    .cf-switch input:checked + .cf-slider:before {
      transform: translateX(22px);
    }

    /* Status Section */
    .cf-status-box {
      background: var(--cf-card-bg);
      border: 1px solid var(--cf-border);
      border-radius: 8px;
      padding: 14px 16px;
      margin-bottom: 4px;
    }
    .cf-status-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }
    .cf-status-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--cf-text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .cf-status-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 10px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
    }
    .cf-status-pill.cf-idle { background: #d9d9d9; color: #595959; }
    .cf-status-pill.cf-success { background: #f6ffed; color: #52c41a; border: 1px solid #b7eb8f; }
    .cf-status-pill.cf-warning { background: #fffbe6; color: #faad14; border: 1px solid #ffe58f; }
    .cf-status-pill.cf-error { background: #fff1f0; color: #ff4d4f; border: 1px solid #ffa39e; }
    .cf-status-pill.cf-syncing { background: #e6f7ff; color: #1890ff; border: 1px solid #91d5ff; }

    .cf-status-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      font-size: 13px;
      margin-bottom: 8px;
    }
    .cf-status-item span:first-child {
      color: var(--cf-text-secondary);
      display: block;
      font-size: 12px;
      margin-bottom: 2px;
    }
    .cf-status-item span:last-child {
      font-weight: 600;
      color: var(--cf-text);
    }
    .cf-status-message {
      font-size: 12px;
      color: var(--cf-text-secondary);
      border-top: 1px dashed var(--cf-border);
      padding-top: 8px;
      margin-top: 4px;
      word-break: break-word;
    }

    /* Modal Footer */
    .cf-modal-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 20px;
      border-top: 1px solid var(--cf-border);
      background: var(--cf-card-bg);
    }
    .cf-btn-group-right {
      display: flex;
      gap: 8px;
    }
    .cf-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 32px;
      padding: 4px 14px;
      font-size: 13.5px;
      font-weight: 500;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s;
      border: 1px solid var(--cf-border);
      background: var(--cf-bg);
      color: var(--cf-text);
    }
    .cf-btn:hover {
      border-color: #f38020;
      color: #f38020;
    }
    .cf-btn-primary {
      background: #f38020;
      border-color: #f38020;
      color: #ffffff !important;
    }
    .cf-btn-primary:hover {
      background: #fa8c16;
      border-color: #fa8c16;
      color: #ffffff !important;
    }
    .cf-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      pointer-events: none;
    }

    /* Toast Notification */
    .cf-toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      padding: 10px 18px;
      background: #1f1f1f;
      color: #ffffff;
      border-radius: 6px;
      font-size: 13px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.25);
      z-index: 10001;
      opacity: 0;
      transform: translateY(10px);
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .cf-toast.cf-show {
      opacity: 1;
      transform: translateY(0);
    }
  `;

  function injectStyles() {
    if (document.getElementById('cf-access-styles')) return;
    const styleEl = document.createElement('style');
    styleEl.id = 'cf-access-styles';
    styleEl.textContent = STYLES;
    document.head.appendChild(styleEl);
  }

  // ==========================================
  // 2. Toast Notifications
  // ==========================================

  function showToast(text, isError = false) {
    const existing = document.getElementById('cf-toast-notification');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'cf-toast-notification';
    toast.className = 'cf-toast';
    toast.style.borderLeft = isError ? '4px solid #ff4d4f' : '4px solid #52c41a';
    toast.textContent = text;
    document.body.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('cf-show'));
    setTimeout(() => {
      toast.classList.remove('cf-show');
      setTimeout(() => toast.remove(), 250);
    }, 3500);
  }

  // ==========================================
  // 3. Multi-Node Tracking & API Communication
  // ==========================================

  function getCurrentNodeId() {
    try {
      // 1. Check registry.host.nodeId (provided by Nginx UI plugin subsystem as a computed/ref)
      if (pluginRegistry && pluginRegistry.host && pluginRegistry.host.nodeId !== undefined) {
        const raw = pluginRegistry.host.nodeId;
        const val = (raw && typeof raw === 'object' && 'value' in raw) ? raw.value : raw;
        if (val !== undefined && val !== null) return String(val);
      }

      // 2. Check LOCAL_main or LOCAL_<window.name> in localStorage
      if (typeof localStorage !== 'undefined') {
        const localKey = `LOCAL_${window.name || 'main'}`;
        const localVal = localStorage.getItem(localKey);
        if (localVal) {
          const parsed = JSON.parse(localVal);
          if (parsed && parsed.node && parsed.node.id !== undefined && parsed.node.id !== null) {
            return String(parsed.node.id);
          }
        }
      }

      // 3. Check direct 'node' key in localStorage
      if (typeof localStorage !== 'undefined') {
        const rawNode = localStorage.getItem('node');
        if (rawNode) {
          const parsed = JSON.parse(rawNode);
          if (parsed && parsed.id !== undefined && parsed.id !== null) {
            return String(parsed.id);
          }
          if (typeof parsed === 'number' || typeof parsed === 'string') {
            return String(parsed);
          }
        }
      }

      // 4. Check URL query parameters (?node=, ?node_id=, ?l=)
      if (typeof window !== 'undefined' && window.location) {
        const params = new URLSearchParams(window.location.search);
        if (params.has('node')) return params.get('node');
        if (params.has('node_id')) return params.get('node_id');
        if (params.has('l')) return params.get('l');
      }
    } catch (_) {}

    return '0';
  }

  function getAuthHeaders() {
    const headers = { 'Accept': 'application/json' };
    try {
      // 1. Check Pinia user storage in localStorage
      if (typeof localStorage !== 'undefined') {
        const rawUser = localStorage.getItem('user');
        if (rawUser) {
          try {
            const userObj = JSON.parse(rawUser);
            if (userObj && userObj.token) {
              headers['Authorization'] = userObj.token.startsWith('Bearer ') ? userObj.token : `Bearer ${userObj.token}`;
            }
          } catch (_) {}
        }
      }
      // 2. Direct token keys
      if (!headers['Authorization']) {
        const token = (typeof localStorage !== 'undefined' && localStorage.getItem('token')) || 
                      (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('token'));
        if (token) {
          headers['Authorization'] = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
        }
      }
      // 3. Node ID
      const currentNodeId = getCurrentNodeId();
      if (currentNodeId && currentNodeId !== '0') {
        headers['X-Node-ID'] = currentNodeId;
      }
    } catch (_) {}
    return headers;
  }

  async function fetchStatusForNode(nodeId) {
    const cleanSubpath = 'status';
    const cleanNodeId = String(nodeId ?? '0');
    const customHeaders = cleanNodeId !== '0' ? { 'X-Node-ID': cleanNodeId } : {};

    // 1. Try context.http (scoped to this plugin)
    if (pluginHttp) {
      try {
        const res = await pluginHttp.get(cleanSubpath, { headers: customHeaders });
        return res.data;
      } catch (err) {
        // If 404 or 403, plugin is not installed on that node
        if (err && err.response && (err.response.status === 404 || err.response.status === 403)) {
          throw err;
        }
      }
    }

    // 2. Try window.NginxUI.shared.http
    if (window.NginxUI && window.NginxUI.shared && window.NginxUI.shared.http) {
      const endpoint = `plugins/${encodeURIComponent(PLUGIN_ID)}/http/${cleanSubpath}`;
      const res = await window.NginxUI.shared.http.get(endpoint, { headers: customHeaders });
      return res.data;
    }

    // 3. Native fetch fallback
    const url = `/api/plugins/${encodeURIComponent(PLUGIN_ID)}/http/${cleanSubpath}`;
    const opts = {
      method: 'GET',
      headers: {
        ...getAuthHeaders(),
        ...customHeaders
      },
      credentials: 'same-origin'
    };
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  async function checkPluginActiveOnNode(nodeId) {
    const cleanNodeId = String(nodeId ?? '0');
    const now = Date.now();
    const cached = nodeAvailabilityMap.get(cleanNodeId);
    if (cached && (now - cached.timestamp < 30000)) {
      return cached.active;
    }

    try {
      const data = await fetchStatusForNode(cleanNodeId);
      if (data && (data.ok || data.config)) {
        nodeAvailabilityMap.set(cleanNodeId, { active: true, timestamp: now });
        if (cleanNodeId === getCurrentNodeId() && data.config) {
          pluginConfig = { ...pluginConfig, ...data.config };
          updateModalUI();
        }
        return true;
      }
      nodeAvailabilityMap.set(cleanNodeId, { active: false, timestamp: now });
      return false;
    } catch (_) {
      nodeAvailabilityMap.set(cleanNodeId, { active: false, timestamp: now });
      return false;
    }
  }

  async function callPluginApi(subpath, method = 'GET', body = null) {
    const cleanSubpath = subpath.replace(/^\/+/, '');
    const cleanNodeId = getCurrentNodeId();
    const customHeaders = cleanNodeId !== '0' ? { 'X-Node-ID': cleanNodeId } : {};

    // 1. Try context.http
    if (pluginHttp) {
      try {
        if (method === 'GET') {
          const res = await pluginHttp.get(cleanSubpath, { headers: customHeaders });
          return res.data;
        } else {
          const res = await pluginHttp.post(cleanSubpath, body, { headers: customHeaders });
          return res.data;
        }
      } catch (err) {
        // Fallback to shared http if context.http failed
      }
    }

    // 2. Try window.NginxUI.shared.http
    if (window.NginxUI && window.NginxUI.shared && window.NginxUI.shared.http) {
      const endpoint = `plugins/${encodeURIComponent(PLUGIN_ID)}/http/${cleanSubpath}`;
      if (method === 'GET') {
        const res = await window.NginxUI.shared.http.get(endpoint, { headers: customHeaders });
        return res.data;
      } else {
        const res = await window.NginxUI.shared.http.post(endpoint, body, { headers: customHeaders });
        return res.data;
      }
    }

    // 3. Fallback to native fetch
    const url = `/api/plugins/${encodeURIComponent(PLUGIN_ID)}/http/${cleanSubpath}`;
    const opts = {
      method: method,
      headers: {
        ...getAuthHeaders(),
        ...customHeaders,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      credentials: 'same-origin',
      body: body ? JSON.stringify(body) : undefined
    };
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  async function fetchStatus() {
    try {
      const data = await callPluginApi('status', 'GET');
      if (data && data.config) {
        pluginConfig = { ...pluginConfig, ...data.config };
        updateModalUI();
      }
    } catch (err) {
      console.warn('[Cloudflare IP] Failed to fetch status:', err);
    }
  }

  async function syncAccessListsDirectly(ipv4List, ipv6List) {
    const client = coreHttp || (window.NginxUI && window.NginxUI.shared && window.NginxUI.shared.http);
    if (!client) return false;

    const cleanNodeId = getCurrentNodeId();
    const reqConfig = cleanNodeId !== '0' ? { headers: { 'X-Node-ID': cleanNodeId } } : {};

    try {
      let existingLists = [];
      try {
        const res = await client.get('/access_lists', reqConfig);
        const data = res && res.data !== undefined ? res.data : res;
        existingLists = Array.isArray(data) ? data : (data.data || data.items || []);
      } catch (_) {}

      async function syncOne(name, enabled, cidrs) {
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
        const existing = existingLists.find(item => item && (item.name === name || item.slug === slug));

        if (enabled && cidrs && cidrs.length > 0) {
          const payload = {
            name: name,
            slug: slug,
            fallback: 'deny',
            rules: cidrs.map(c => ({ type: 'allow', value: c, note: 'Cloudflare IP' }))
          };
          if (existing && existing.id !== undefined) {
            try {
              await client.post(`/access_lists/${existing.id}`, payload, reqConfig);
            } catch (_) {
              await client.put(`/access_lists/${existing.id}`, payload, reqConfig);
            }
          } else {
            await client.post('/access_lists', payload, reqConfig);
          }
        } else if (!enabled && existing && existing.id !== undefined) {
          try {
            await client.delete(`/access_lists/${existing.id}`, reqConfig);
          } catch (_) {}
        }
      }

      const combinedList = [...(ipv4List || []), ...(ipv6List || [])];

      if (pluginConfig.ipv4_enabled && ipv4List && ipv4List.length > 0) {
        await syncOne('Cloudflare IPv4', true, ipv4List);
      } else if (!pluginConfig.ipv4_enabled) {
        await syncOne('Cloudflare IPv4', false, []);
      }

      if (pluginConfig.ipv6_enabled && ipv6List && ipv6List.length > 0) {
        await syncOne('Cloudflare IPv6', true, ipv6List);
      } else if (!pluginConfig.ipv6_enabled) {
        await syncOne('Cloudflare IPv6', false, []);
      }

      if (pluginConfig.combined_enabled && combinedList.length > 0) {
        await syncOne('Cloudflare Combined (IPv4 & IPv6)', true, combinedList);
      } else if (!pluginConfig.combined_enabled) {
        await syncOne('Cloudflare Combined (IPv4 & IPv6)', false, []);
      }

      // Automatically refresh the Access Lists table in Nginx UI view if on the page
      try {
        const refreshBtn = document.querySelector('button.ant-btn-icon-only') || 
                           document.querySelector('button[data-testid="refresh"]');
        if (refreshBtn) refreshBtn.click();
      } catch (_) {}

      return true;
    } catch (err) {
      console.warn('[Cloudflare IP] Direct browser sync note:', err);
      return false;
    }
  }

  async function saveConfig(ipv4Enabled, ipv6Enabled, combinedEnabled) {
    isSaving = true;
    updateModalUI();

    try {
      const data = await callPluginApi('save', 'POST', {
        ipv4_enabled: ipv4Enabled,
        ipv6_enabled: ipv6Enabled,
        combined_enabled: combinedEnabled
      });

      if (data && data.config) {
        pluginConfig = { ...pluginConfig, ...data.config };
      }

      if (data && data.sync && data.sync.warning && (data.ipv4 || data.ipv6)) {
        const directOk = await syncAccessListsDirectly(data.ipv4, data.ipv6);
        if (directOk) {
          pluginConfig.status = 'success';
          pluginConfig.message = 'Successfully synchronized Cloudflare IP Access Lists into Nginx UI.';
        }
      }

      showToast('Cloudflare IP Access settings saved and synchronized!');
    } catch (err) {
      showToast(`Save failed: ${err.message}`, true);
    } finally {
      isSaving = false;
      updateModalUI();
    }
  }

  async function forceSync() {
    isSyncing = true;
    updateModalUI();

    try {
      const data = await callPluginApi('sync', 'POST');

      if (data && data.config) {
        pluginConfig = { ...pluginConfig, ...data.config };
      }

      if (data && data.sync && data.sync.warning && (data.ipv4 || data.ipv6)) {
        const directOk = await syncAccessListsDirectly(data.ipv4, data.ipv6);
        if (directOk) {
          pluginConfig.status = 'success';
          pluginConfig.message = 'Successfully synchronized Cloudflare IP Access Lists into Nginx UI.';
        }
      }

      showToast('Forced synchronization completed!');
    } catch (err) {
      showToast(`Force sync failed: ${err.message}`, true);
    } finally {
      isSyncing = false;
      updateModalUI();
    }
  }

  // ==========================================
  // 4. Modal Component
  // ==========================================

  function formatTimestamp(isoStr) {
    if (!isoStr) return 'Never';
    try {
      const d = new Date(isoStr);
      return isNaN(d.getTime()) ? isoStr : d.toLocaleString();
    } catch (_) {
      return isoStr;
    }
  }

  function getStatusBadge(status) {
    const s = (status || 'idle').toLowerCase();
    switch (s) {
      case 'success':
        return '<span class="cf-status-pill cf-success">● Active / Synced</span>';
      case 'syncing':
        return '<span class="cf-status-pill cf-syncing">↻ Syncing...</span>';
      case 'warning':
        return '<span class="cf-status-pill cf-warning">▲ Warning</span>';
      case 'error':
        return '<span class="cf-status-pill cf-error">✕ Error</span>';
      default:
        return '<span class="cf-status-pill cf-idle">○ Idle</span>';
    }
  }

  function openModal() {
    if (modalInstance) return;

    injectStyles();

    const backdrop = document.createElement('div');
    backdrop.className = 'cf-modal-backdrop';
    backdrop.id = 'cf-access-modal';

    backdrop.innerHTML = `
      <div class="cf-modal-dialog">
        <div class="cf-modal-header">
          <h3 class="cf-modal-title">
            <svg viewBox="0 0 24 24">
              <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM19 18H6c-2.21 0-4-1.79-4-4 0-2.05 1.53-3.76 3.56-3.97l1.07-.11.5-.95C8.08 7.14 9.94 6 12 6c2.62 0 4.88 1.86 5.39 4.43l.3 1.5 1.53.11c1.56.1 2.78 1.41 2.78 2.96 0 1.65-1.35 3-3 3z"/>
            </svg>
            Cloudflare IP Sync
          </h3>
          <button class="cf-modal-close" id="cf-close-x" title="Close">&times;</button>
        </div>

        <div class="cf-modal-body">
          <p class="cf-desc-text">
            Automatically synchronize Cloudflare's official edge IP ranges into Nginx UI <strong>Access Lists</strong>. Creates allow rules for Cloudflare CIDRs and restricts everything else to deny.
          </p>

          <div class="cf-toggle-group">
            <!-- IPv4 Toggle Card -->
            <div class="cf-toggle-card">
              <div class="cf-toggle-info">
                <div class="cf-toggle-title">Cloudflare IPv4 Range</div>
                <p class="cf-toggle-desc">Syncs IPv4 CIDRs into Access List named <code>Cloudflare IPv4</code>.</p>
              </div>
              <label class="cf-switch">
                <input type="checkbox" id="cf-toggle-ipv4" ${pluginConfig.ipv4_enabled ? 'checked' : ''}>
                <span class="cf-slider"></span>
              </label>
            </div>

            <!-- IPv6 Toggle Card -->
            <div class="cf-toggle-card">
              <div class="cf-toggle-info">
                <div class="cf-toggle-title">Cloudflare IPv6 Range</div>
                <p class="cf-toggle-desc">Syncs IPv6 CIDRs into Access List named <code>Cloudflare IPv6</code>.</p>
              </div>
              <label class="cf-switch">
                <input type="checkbox" id="cf-toggle-ipv6" ${pluginConfig.ipv6_enabled ? 'checked' : ''}>
                <span class="cf-slider"></span>
              </label>
            </div>

            <!-- Combined (IPv4 & IPv6) Toggle Card -->
            <div class="cf-toggle-card">
              <div class="cf-toggle-info">
                <div class="cf-toggle-title">Cloudflare Combined (IPv4 & IPv6)</div>
                <p class="cf-toggle-desc">Syncs all IPv4 and IPv6 CIDRs into a single Access List named <code>Cloudflare Combined (IPv4 & IPv6)</code>.</p>
              </div>
              <label class="cf-switch">
                <input type="checkbox" id="cf-toggle-combined" ${pluginConfig.combined_enabled ? 'checked' : ''}>
                <span class="cf-slider"></span>
              </label>
            </div>
          </div>

          <!-- Status Section -->
          <div class="cf-status-box">
            <div class="cf-status-header">
              <span class="cf-status-title">Sync Status</span>
              <div id="cf-status-badge">${getStatusBadge(pluginConfig.status)}</div>
            </div>
            <div class="cf-status-grid">
              <div class="cf-status-item">
                <span>Last Synchronized</span>
                <span id="cf-last-sync">${formatTimestamp(pluginConfig.last_sync)}</span>
              </div>
              <div class="cf-status-item">
                <span>Auto-Sync Interval</span>
                <span>Every 24 Hours</span>
              </div>
              <div class="cf-status-item">
                <span>IPv4 Ranges Loaded</span>
                <span id="cf-count-ipv4">${pluginConfig.ipv4_count} CIDRs</span>
              </div>
              <div class="cf-status-item">
                <span>IPv6 Ranges Loaded</span>
                <span id="cf-count-ipv6">${pluginConfig.ipv6_count} CIDRs</span>
              </div>
              <div class="cf-status-item" style="grid-column: span 2;">
                <span>Combined Ranges (Total)</span>
                <span id="cf-count-combined">${(pluginConfig.ipv4_count || 15) + (pluginConfig.ipv6_count || 7)} CIDRs</span>
              </div>
            </div>
            <div class="cf-status-message" id="cf-status-message">
              ${pluginConfig.message || 'Status healthy'}
            </div>
          </div>
        </div>

        <div class="cf-modal-footer">
          <button class="cf-btn" id="cf-btn-force-sync" title="Fetch Cloudflare ranges immediately">
            <span>Force Sync Now</span>
          </button>
          <div class="cf-btn-group-right">
            <button class="cf-btn" id="cf-btn-cancel">Cancel</button>
            <button class="cf-btn cf-btn-primary" id="cf-btn-save">Save & Sync</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);
    modalInstance = backdrop;

    requestAnimationFrame(() => backdrop.classList.add('cf-show'));

    // Event Listeners
    backdrop.querySelector('#cf-close-x').addEventListener('click', closeModal);
    backdrop.querySelector('#cf-btn-cancel').addEventListener('click', closeModal);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeModal();
    });

    backdrop.querySelector('#cf-btn-save').addEventListener('click', () => {
      const v4 = backdrop.querySelector('#cf-toggle-ipv4').checked;
      const v6 = backdrop.querySelector('#cf-toggle-ipv6').checked;
      const combined = backdrop.querySelector('#cf-toggle-combined').checked;
      saveConfig(v4, v6, combined);
    });

    backdrop.querySelector('#cf-btn-force-sync').addEventListener('click', () => {
      forceSync();
    });

    // ESC key closes modal
    document.addEventListener('keydown', handleEscKey);

    // Refresh live status from active node
    fetchStatus();
  }

  function handleEscKey(e) {
    if (e.key === 'Escape' && modalInstance) {
      closeModal();
    }
  }

  function closeModal() {
    if (!modalInstance) return;
    document.removeEventListener('keydown', handleEscKey);
    modalInstance.classList.remove('cf-show');
    setTimeout(() => {
      if (modalInstance) {
        modalInstance.remove();
        modalInstance = null;
      }
    }, 250);
  }

  function updateModalUI() {
    if (!modalInstance) return;

    const v4Input = modalInstance.querySelector('#cf-toggle-ipv4');
    const v6Input = modalInstance.querySelector('#cf-toggle-ipv6');
    const combinedInput = modalInstance.querySelector('#cf-toggle-combined');
    const badgeEl = modalInstance.querySelector('#cf-status-badge');
    const syncEl = modalInstance.querySelector('#cf-last-sync');
    const countV4El = modalInstance.querySelector('#cf-count-ipv4');
    const countV6El = modalInstance.querySelector('#cf-count-ipv6');
    const countCombinedEl = modalInstance.querySelector('#cf-count-combined');
    const msgEl = modalInstance.querySelector('#cf-status-message');
    const saveBtn = modalInstance.querySelector('#cf-btn-save');
    const forceBtn = modalInstance.querySelector('#cf-btn-force-sync');

    if (v4Input && !v4Input.matches(':focus')) v4Input.checked = !!pluginConfig.ipv4_enabled;
    if (v6Input && !v6Input.matches(':focus')) v6Input.checked = !!pluginConfig.ipv6_enabled;
    if (combinedInput && !combinedInput.matches(':focus')) combinedInput.checked = !!pluginConfig.combined_enabled;

    if (badgeEl) badgeEl.innerHTML = getStatusBadge(isSyncing ? 'syncing' : pluginConfig.status);
    if (syncEl) syncEl.textContent = formatTimestamp(pluginConfig.last_sync);
    if (countV4El) countV4El.textContent = `${pluginConfig.ipv4_count} CIDRs`;
    if (countV6El) countV6El.textContent = `${pluginConfig.ipv6_count} CIDRs`;
    if (countCombinedEl) countCombinedEl.textContent = `${(pluginConfig.ipv4_count || 15) + (pluginConfig.ipv6_count || 7)} CIDRs`;
    if (msgEl) msgEl.textContent = pluginConfig.message || '';

    if (saveBtn) {
      saveBtn.disabled = isSaving || isSyncing;
      saveBtn.textContent = isSaving ? 'Saving...' : 'Save & Sync';
    }
    if (forceBtn) {
      forceBtn.disabled = isSaving || isSyncing;
      forceBtn.textContent = isSyncing ? 'Syncing...' : 'Force Sync Now';
    }
  }

  // ==========================================
  // 5. DOM Injection Engine (Access Lists Page)
  // ==========================================

  function isAccessListPage() {
    const path = window.location.pathname.toLowerCase() + window.location.hash.toLowerCase();
    if (path.includes('access-list') || path.includes('access_list') || path.includes('accesslist')) {
      return true;
    }

    // Inspect visible DOM for Access List page indicators
    const headings = document.querySelectorAll('h1, h2, h3, .ant-page-header-heading-title, .n-page-header');
    for (const h of headings) {
      if (h.textContent && h.textContent.toLowerCase().includes('access list')) {
        return true;
      }
    }
    return false;
  }

  function findCreateAccessListButton() {
    const candidates = document.querySelectorAll('button, a, .ant-btn');
    for (const btn of candidates) {
      const text = (btn.textContent || '').trim().toLowerCase();
      if (
        text.includes('create access list') ||
        text.includes('add access list') ||
        (text.includes('access list') && text.includes('create')) ||
        (text.includes('access list') && text.includes('add'))
      ) {
        return btn;
      }
    }

    // Fallback search: any button with "+ Create" or "+ Add" within an access list view
    if (isAccessListPage()) {
      for (const btn of candidates) {
        const text = (btn.textContent || '').trim().toLowerCase();
        if (text === '+ create' || text === 'create' || text === '+ add' || text === 'add') {
          return btn;
        }
      }
    }

    return null;
  }

  function removeCloudflareButton() {
    const existing = document.getElementById('cf-access-list-btn');
    if (existing) existing.remove();
  }

  function renderButton() {
    if (document.getElementById('cf-access-list-btn')) return;

    const targetBtn = findCreateAccessListButton();
    if (!targetBtn) return;

    injectStyles();

    const cfBtn = document.createElement('button');
    cfBtn.id = 'cf-access-list-btn';
    cfBtn.type = 'button';
    cfBtn.className = 'cf-access-btn';
    cfBtn.title = 'Configure and synchronize Cloudflare IP ranges';
    cfBtn.innerHTML = `
      <svg viewBox="0 0 24 24">
        <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM19 18H6c-2.21 0-4-1.79-4-4 0-2.05 1.53-3.76 3.56-3.97l1.07-.11.5-.95C8.08 7.14 9.94 6 12 6c2.62 0 4.88 1.86 5.39 4.43l.3 1.5 1.53.11c1.56.1 2.78 1.41 2.78 2.96 0 1.65-1.35 3-3 3z"/>
      </svg>
      Cloudflare IP
    `;

    cfBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openModal();
    });

    // Insert directly adjacent to "+ Create Access List" button
    if (targetBtn.nextSibling) {
      targetBtn.parentNode.insertBefore(cfBtn, targetBtn.nextSibling);
    } else {
      targetBtn.parentNode.appendChild(cfBtn);
    }
  }

  async function injectCloudflareButton() {
    const currentNodeId = getCurrentNodeId();

    // Node change detection: immediately remove button if active node switched
    if (lastKnownNodeId !== null && lastKnownNodeId !== currentNodeId) {
      lastKnownNodeId = currentNodeId;
      removeCloudflareButton();
      if (modalInstance) closeModal();
    } else {
      lastKnownNodeId = currentNodeId;
    }

    // Only inject on Access Lists page
    if (!isAccessListPage()) {
      removeCloudflareButton();
      return;
    }

    // Check availability for current node
    const cached = nodeAvailabilityMap.get(currentNodeId);
    if (!cached) {
      // Not yet verified for this node: do NOT render button until verified!
      removeCloudflareButton();
      if (!isCheckingNodeStatus) {
        isCheckingNodeStatus = true;
        checkPluginActiveOnNode(currentNodeId).then(isActive => {
          isCheckingNodeStatus = false;
          if (isActive && isAccessListPage() && getCurrentNodeId() === currentNodeId) {
            renderButton();
          } else {
            removeCloudflareButton();
          }
        }).catch(() => {
          isCheckingNodeStatus = false;
          removeCloudflareButton();
        });
      }
      return;
    }

    if (!cached.active) {
      // Plugin is not available on this node
      removeCloudflareButton();
      return;
    }

    renderButton();
  }

  // ==========================================
  // 6. Lifecycle & Navigation Watcher
  // ==========================================

  let isWatcherInitialized = false;
  let domObserver = null;
  let hasLoggedInit = false;

  function removeFloatingTrigger() {
    const existingFloat = document.getElementById('cf-float-trigger-btn');
    if (existingFloat) existingFloat.remove();
  }

  function onNavigation() {
    removeFloatingTrigger();
    injectCloudflareButton();
  }

  function initWatcher() {
    removeFloatingTrigger();
    injectCloudflareButton();

    if (!hasLoggedInit) {
      hasLoggedInit = true;
      console.log('[Cloudflare IP] Frontend loaded! Access Lists button active & window.openCloudflareSync() available.');
    }

    if (isWatcherInitialized) return;
    isWatcherInitialized = true;

    // Observe SPA DOM transitions
    if (!domObserver) {
      domObserver = new MutationObserver(() => {
        removeFloatingTrigger();
        injectCloudflareButton();
      });
      domObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
    }

    // Intercept SPA router navigation events
    window.addEventListener('popstate', onNavigation);
    window.addEventListener('hashchange', onNavigation);

    // Watch for node changes using Vue store reactivity if available
    try {
      const vue = window.NginxUI && window.NginxUI.shared && window.NginxUI.shared.vue;
      if (vue && typeof vue.watch === 'function') {
        vue.watch(
          () => getCurrentNodeId(),
          (newId, oldId) => {
            if (newId !== oldId) {
              lastKnownNodeId = newId;
              removeCloudflareButton();
              if (modalInstance) closeModal();
              injectCloudflareButton();
            }
          }
        );
      }
    } catch (_) {}

    // Polling heartbeat to catch node switches immediately even without DOM mutation
    setInterval(() => {
      const currentId = getCurrentNodeId();
      if (currentId !== lastKnownNodeId) {
        injectCloudflareButton();
      }
    }, 1000);

    // Expose global shortcut
    window.openCloudflareSync = openModal;
    window.openCloudflareModal = openModal;

    // Initial background status fetch for current node
    fetchStatus();
  }

  function handleSetup(registry) {
    pluginRegistry = registry || null;
    if (registry) {
      if (registry.http) pluginHttp = registry.http;
      if (registry.coreHttp) coreHttp = registry.coreHttp;
    }
    initWatcher();
  }

  function handleTeardown() {
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
    window.removeEventListener('popstate', onNavigation);
    window.removeEventListener('hashchange', onNavigation);
    removeCloudflareButton();
    removeFloatingTrigger();
    const modal = document.getElementById('cf-access-modal');
    if (modal) modal.remove();
    isWatcherInitialized = false;
  }

  // Register with Nginx UI plugin subsystem according to official Webapp specification
  const registerFn = (window.NginxUI && window.NginxUI.registerPlugin) || window.registerPlugin;
  if (typeof registerFn === 'function') {
    const pluginDef = {
      setup: handleSetup,
      teardown: handleTeardown
    };
    try {
      registerFn(PLUGIN_ID, pluginDef);
      if (PLUGIN_ID !== 'com.github.petergamez.cloudflare-ip') {
        registerFn('com.github.petergamez.cloudflare-ip', pluginDef);
      }
    } catch (_) {}
  } else {
    // Standalone fallback
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => handleSetup(null));
    } else {
      handleSetup(null);
    }
  }
})();
