(() => {
  'use strict';

  const HELPER = '/usr/bin/nbosp-vpn';
  const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  const PROFILE_MAX_BYTES = 16 * 1024;
  const DNS_RESOLVER_HOST = 'cloudflare-dns.com';
  const DNS_RESOLVER_ADDRESS = '1.1.1.1';
  const listeners = new Set();
  let state = { active: false, providerId: null, address: null };
  let refreshPromise = null;

  function runHelper(args, input) {
    return new Promise((resolve, reject) => {
      const child = require('child_process').spawn(HELPER, args, {
        env: { PATH: '/usr/bin:/usr/sbin:/bin:/sbin' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.length > 64 * 1024) child.kill();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (stderr.length > 16 * 1024) child.kill();
      });
      child.once('error', (error) => {
        reject(new Error(error.code === 'ENOENT'
          ? 'The native VPN helper is not installed in this OS build.'
          : `Could not start the native VPN helper: ${error.message}`));
      });
      child.once('close', (code, signal) => {
        if (code !== 0) {
          reject(new Error((stderr.trim() || `VPN helper exited with status ${code ?? signal ?? 'unknown'}`).slice(0, 1000)));
          return;
        }
        resolve(stdout.trim());
      });
      // The helper can exit (or fail to spawn) before we finish writing, and Node
      // then emits EPIPE on stdin. Unhandled, client.js turns that into process.exit(1).
      // 'close' above already reports the real outcome, so only surface other errors.
      child.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') reject(error);
      });
      child.stdin.end(input ?? '');
    });
  }

  function requireAppId(appId) {
    if (typeof appId !== 'string' || !APP_ID_RE.test(appId)) {
      throw new TypeError('Invalid VPN provider app id.');
    }
  }

  function hasProviderPermission(appId) {
    return typeof AppPermissionManager !== 'undefined'
      && AppPermissionManager.isGranted('vpn:provider', appId);
  }

  function syncStatusForApp(appId) {
    try {
      const fs = require('fs');
      const content = fs.readFileSync('/run/novabyte-vpn/status', 'utf8');
      const [activeId, address] = content.trim().split(/\r?\n/);
      return activeId === appId && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address || '');
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      console.error('[VPNService] Could not read native VPN status:', error);
      return true;
    }
  }

  function isPublicIPv4(address) {
    if (require('net').isIPv4(address) !== 1) return false;
    const [a, b] = address.split('.').map(Number);
    return a !== 0 && a !== 10 && a !== 127
      && !(a === 100 && b >= 64 && b <= 127)
      && !(a === 169 && b === 254)
      && !(a === 172 && b >= 16 && b <= 31)
      && !(a === 192 && b === 168)
      && a < 224;
  }

  function pinnedAgent(localAddress, destinationAddress) {
    const { Agent } = require('undici');
    return new Agent({
      connect: {
        timeout: 8000,
        localAddress,
        lookup: (_hostname, _options, callback) => {
          callback(null, [{ address: destinationAddress, family: 4 }]);
        },
      },
    });
  }

  async function resolveHostThroughVpn(hostname, localAddress) {
    const net = require('net');
    const host = String(hostname || '').replace(/^\[|\]$/g, '');
    if (net.isIP(host) === 4) {
      if (!isPublicIPv4(host)) throw new Error('Private or non-public WebSocket destinations are blocked while VPN is active.');
      return host;
    }
    if (net.isIP(host) === 6) {
      throw new Error('The active VPN route currently supports IPv4 WebSocket destinations only.');
    }
    const query = new URL(`https://${DNS_RESOLVER_HOST}/dns-query`);
    query.searchParams.set('name', host);
    query.searchParams.set('type', 'A');
    const dispatcher = pinnedAgent(localAddress, DNS_RESOLVER_ADDRESS);
    try {
      const { fetch } = require('undici');
      const response = await fetch(query, {
        headers: { Accept: 'application/dns-json' },
        redirect: 'error',
        dispatcher,
      });
      if (!response.ok) throw new Error(`VPN DNS resolver returned HTTP ${response.status}`);
      const result = await response.json();
      if (result.Status !== 0 || !Array.isArray(result.Answer)) {
        throw new Error('VPN DNS lookup returned no successful A record response.');
      }
      const addresses = result.Answer
        .filter((answer) => answer?.type === 1 && typeof answer.data === 'string')
        .map((answer) => answer.data);
      if (!addresses.length || addresses.some((address) => !isPublicIPv4(address))) {
        throw new Error('VPN DNS returned no safe public IPv4 address.');
      }
      return addresses[0];
    } finally {
      await dispatcher.close();
    }
  }

  async function openWebSocket(appId, url, protocols) {
    requireAppId(appId);
    const status = await getStatus();
    if (!status.active || status.providerId !== appId) return null;
    const target = new URL(url);
    if (target.protocol !== 'ws:' && target.protocol !== 'wss:') {
      throw new TypeError('VPN WebSocket URLs must use ws: or wss:.');
    }
    const address = await resolveHostThroughVpn(target.hostname, status.address);
    const agent = pinnedAgent(status.address, address);
    try {
      const { WebSocket } = require('undici');
      const socket = new WebSocket(target.toString(), protocols, { dispatcher: agent });
      let disposed = false;
      return {
        socket,
        dispose: () => {
          if (disposed) return;
          disposed = true;
          void agent.close();
        },
      };
    } catch (error) {
      await agent.close();
      throw error;
    }
  }

  function publish(next) {
    state = next;
    for (const listener of [...listeners]) {
      try { listener({ ...state }); }
      catch (error) { console.error('[VPNService] Status listener failed:', error); }
    }
    if (typeof OS !== 'undefined') {
      OS.events?.emit?.('os:vpnChanged', { ...state });
    }
    document.getElementById('tray-vpn')?.classList.toggle('hidden', !state.active);
  }

  async function getStatus() {
    const raw = await runHelper(['status']);
    const status = JSON.parse(raw);
    if (status.active !== true ||
        typeof status.providerId !== 'string' ||
        !APP_ID_RE.test(status.providerId) ||
        typeof status.address !== 'string' ||
        !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(status.address)) {
      publish({ active: false, providerId: null, address: null });
      return { ...state };
    }
    publish({
      active: true,
      providerId: status.providerId,
      address: status.address,
    });
    return { ...state };
  }

  async function getProviders() {
    const ids = JSON.parse(await runHelper(['list']));
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !APP_ID_RE.test(id))) {
      throw new Error('The native VPN helper returned an invalid provider list.');
    }
    return ids.map((id) => {
      const app = AppRegistry.getApp(id);
      return app ? { id, name: app.name || id, granted: hasProviderPermission(id) } : null;
    }).filter(Boolean);
  }

  async function registerProvider(appId, config) {
    requireAppId(appId);
    const app = AppRegistry.getApp(appId);
    if (!app || app.system === true || app.type === 'webapp') {
      throw new Error('Only installed sandboxed NovaApps can provide a device VPN.');
    }
    if (!hasProviderPermission(appId)) {
      throw new Error('The app must be granted vpn:provider before registering a VPN.');
    }
    if (typeof config !== 'string' || config.length === 0 ||
        Buffer.byteLength(config, 'utf8') > PROFILE_MAX_BYTES) {
      throw new TypeError('Provide a WireGuard configuration under 16 KiB.');
    }
    const result = JSON.parse(await runHelper(['register', appId], config));
    if (result.registered !== true || result.providerId !== appId) {
      throw new Error('The native VPN helper did not confirm provider registration.');
    }
    return { registered: true, providerId: appId };
  }

  async function removeProvider(appId) {
    requireAppId(appId);
    const raw = await runHelper(['list']);
    const ids = JSON.parse(raw);
    if (!ids.includes(appId)) return { removed: false };
    const result = JSON.parse(await runHelper(['remove', appId]));
    if (result.removed !== true || result.providerId !== appId) {
      throw new Error('The native VPN helper did not confirm provider removal.');
    }
    if (state.providerId === appId) {
      publish({ active: false, providerId: null, address: null });
    }
    return { removed: true };
  }

  async function activate(appId) {
    requireAppId(appId);
    if (!hasProviderPermission(appId)) {
      throw new Error('The selected app no longer has vpn:provider permission.');
    }
    const providers = await getProviders();
    if (!providers.some((provider) => provider.id === appId && provider.granted)) {
      throw new Error('The selected app has not registered a VPN provider.');
    }
    await runHelper(['up', appId]);
    return getStatus();
  }

  async function deactivate() {
    await runHelper(['down']);
    publish({ active: false, providerId: null, address: null });
    return { ...state };
  }

  async function revokeProvider(appId) {
    return removeProvider(appId);
  }

  function onChange(listener) {
    if (typeof listener !== 'function') throw new TypeError('VPN status listener must be a function.');
    listeners.add(listener);
    listener({ ...state });
    return () => listeners.delete(listener);
  }

  function refresh() {
    if (!refreshPromise) {
      refreshPromise = getStatus().finally(() => { refreshPromise = null; });
    }
    return refreshPromise;
  }

  if (typeof AppRegistry !== 'undefined') {
    AppRegistry.onUninstall((app) => {
      void removeProvider(app.id).catch((error) => {
        console.error(`[VPNService] Could not remove ${app.id}'s VPN profile after uninstall:`, error);
      });
    });
  }

  const api = Object.freeze({
    getStatus,
    getProviders,
    registerProvider,
    removeProvider,
    revokeProvider,
    activate,
    deactivate,
    openWebSocket,
    onChange,
    isActiveFor: (appId) => state.active && state.providerId === appId,
    isActiveForSync: syncStatusForApp,
  });
  window.NovaVPNService = api;
  void refresh().catch((error) => console.error('[VPNService] Initial status check failed:', error));
})();