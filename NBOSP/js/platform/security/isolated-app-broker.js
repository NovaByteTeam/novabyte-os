(function () {
  'use strict';

  const MAX_BODY_BYTES = 10 * 1024 * 1024;
  const BROKER_PORT = 49173;
  const MAX_PENDING_PER_APP = 32;
  const REQUEST_WINDOW_MS = 60_000;
  const MAX_REQUESTS_PER_WINDOW = 120;
  const sessions = new Map();
  let server = null;
  let endpoint = null;

  function nodeModules() {
    if (typeof require !== 'function') {
      throw new Error('Node.js integration is required for isolated Linux apps');
    }
    return {
      crypto: require('node:crypto'),
      fs: require('node:fs'),
      http: require('node:http'),
      net: require('node:net'),
      os: require('node:os'),
      path: require('node:path'),
    };
  }

  function validateAppId(id) {
    return typeof id === 'string' &&
      /^[a-z0-9][a-z0-9._-]{0,62}$/.test(id) &&
      !id.includes('..');
  }

  function validateEntry(entry) {
    return typeof entry === 'string' && entry.length <= 512 &&
      !entry.startsWith('/') &&
      entry.split('/').every(part =>
        part && part !== '.' && part !== '..' && /^[A-Za-z0-9._-]+$/.test(part));
  }

  function callSupervisor(request) {
    const { net } = nodeModules();
    return new Promise((resolve, reject) => {
      const socket = net.createConnection('/run/nbosp-app-supervisor.sock');
      let response = '';
      let finished = false;
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('App supervisor request timed out'));
      }, 120_000);
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(value);
      };
      socket.once('connect', () => socket.write(`${request}\n`));
      socket.on('data', chunk => {
        response += chunk.toString('utf8');
        if (response.length > 256 || (response.includes('\n') && !response.endsWith('\n'))) {
          socket.destroy();
          finish(new Error('Invalid response from app supervisor'));
        }
        if (response.endsWith('\n')) {
          socket.end();
          const line = response.slice(0, -1);
          if (!line.startsWith('OK ')) {
            finish(new Error(`App supervisor rejected request: ${line}`));
          } else {
            finish(null, line.slice(3));
          }
        }
      });
      socket.once('error', error => finish(error));
      socket.once('close', () => {
        if (!finished) finish(new Error('App supervisor closed the connection without a response'));
      });
    });
  }

  const bridgeSource = `(() => {
    'use strict';
    const pending = new Map();
    const queued = [];
    const maxPending = 32;
    let ready = false;
    let sequence = 0;
    const packageRoot = new URL('__NBOSP_PACKAGE_ROOT__', window.location.href);
    const nativeFetch = window.fetch.bind(window);
    function send(call) {
      window.dispatchEvent(new CustomEvent('nbosp-api-call', { detail: call }));
    }
    window.addEventListener('nbosp-broker-ready', () => {
      ready = true;
      for (const call of queued.splice(0)) send(call);
      window.dispatchEvent(new Event('nbosp-bridge-initialized'));
    });
    window.addEventListener('nbosp-api-response', event => {
      const response = event.detail;
      if (!response || typeof response.requestId !== 'string') return;
      const request = pending.get(response.requestId);
      if (!request) return;
      pending.delete(response.requestId);
      clearTimeout(request.timeout);
      if (response.error) {
        const error = new Error(response.error.message || 'NovaByte API request failed');
        error.code = response.error.code || 'API_ERROR';
        request.reject(error);
      } else {
        request.resolve(response.result);
      }
    });
    function ipc(type, payload) {
      if (typeof type !== 'string' || !type.startsWith('nova:')) {
        return Promise.reject(new TypeError('Invalid NovaByte API name'));
      }
      if (pending.size >= maxPending) {
        return Promise.reject(new Error('Too many pending NovaByte API requests'));
      }
      const requestId = Date.now().toString(36) + '-' + (++sequence).toString(36);
      const call = { type, payload: payload || {}, requestId };
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(requestId);
          const queuedIndex = queued.findIndex(item => item.requestId === requestId);
          if (queuedIndex !== -1) queued.splice(queuedIndex, 1);
          reject(new Error('NovaByte API request timed out'));
        }, 30_000);
        pending.set(requestId, { resolve, reject, timeout });
        if (ready) send(call);
        else queued.push(call);
      });
    }
    function encodeBase64(bytes) {
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      return btoa(binary);
    }
    async function fetchThroughBroker(input, init = {}) {
      const request = input instanceof Request ? input : null;
      const url = new URL(request ? request.url : String(input), window.location.href);
      if (url.protocol === 'file:') {
        let packagePath, requestPath;
        try {
          packagePath = decodeURIComponent(packageRoot.pathname);
          requestPath = decodeURIComponent(url.pathname);
        } catch {
          throw new TypeError('Invalid packaged file URL');
        }
        if (url.host !== packageRoot.host ||
            !requestPath.startsWith(packagePath) ||
            requestPath.split('/').includes('..')) {
          throw new TypeError('Isolated apps may only fetch files from their installed package');
        }
        return nativeFetch(request || url.href, init);
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new TypeError('Isolated app fetch supports only packaged files and HTTP(S)');
      }
      const method = String(init.method || request?.method || 'GET').toUpperCase();
      const headers = new Headers(init.headers || request?.headers || {});
      let body = init.body ?? null;
      if (body === null && request && method !== 'GET' && method !== 'HEAD') {
        body = await request.clone().arrayBuffer();
      }
      let bodyEncoding = 'utf8';
      if (body instanceof Blob) {
        if (body.type && !headers.has('content-type')) headers.set('content-type', body.type);
        body = await body.arrayBuffer();
      }
      if (body instanceof URLSearchParams) {
        if (!headers.has('content-type')) {
          headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
        }
        body = body.toString();
      }
      if (body instanceof ArrayBuffer) body = new Uint8Array(body);
      if (ArrayBuffer.isView(body)) {
        if (body.byteLength > 6 * 1024 * 1024) {
          throw new TypeError('Isolated app request body exceeds 6 MiB');
        }
        const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
        body = encodeBase64(bytes);
        bodyEncoding = 'base64';
      } else if (body !== null && typeof body !== 'string') {
        throw new TypeError('Unsupported isolated app request body type');
      }
      const result = await ipc('nova:net:fetch', {
        url: url.href,
        method,
        headers: Object.fromEntries(headers.entries()),
        body,
        bodyEncoding,
      });
      let responseBody = result.body || '';
      if (result.bodyEncoding === 'base64') {
        const binary = atob(responseBody);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) {
          bytes[index] = binary.charCodeAt(index);
        }
        responseBody = bytes;
      }
      return new Response(
        [204, 205, 304].includes(result.status) ? null : responseBody,
        { status: result.status, statusText: result.statusText, headers: result.headers },
      );
    }
    Object.defineProperty(window, 'fetch', {
      configurable: false,
      enumerable: true,
      writable: false,
      value: fetchThroughBroker,
    });
    Object.defineProperty(window, 'nova', {
      configurable: false,
      enumerable: true,
      writable: false,
      value: Object.freeze({
        ipc,
        requestPermission: (permission, reason) =>
          ipc('nova:request-permission', { permission, reason }),
        app: Object.freeze({
          getInfo: () => ipc('nova:app:info', {}),
        }),
        net: Object.freeze({
          fetch: (url, options) => fetchThroughBroker(url, options),
        }),
      }),
    });
    window.novaOS = Object.freeze({
      apiVersion: 2,
      capabilities: Object.freeze({
        has: name => typeof name === 'string' && name === 'storage.v2',
      }),
      storage: Object.freeze({
        get: key => ipc('nova:storage:get', { key }).then(result => (result && result.value) ?? null),
        set: (key, value) => ipc('nova:storage:set', { key, value }).then(() => {}),
        remove: key => ipc('nova:storage:delete', { key }).then(() => {}),
        clear: () => ipc('nova:storage:clear', {}).then(() => {}),
        keys: () => ipc('nova:storage:keys', {}).then(result => result && result.keys || []),
      }),
    });
    window.__novaPrivateStore = Object.freeze({});
  })();`;

  function writeStagedPackage(app) {
    const { fs, path, os } = nodeModules();
    if (!validateAppId(app.id) || !validateEntry(app.entry)) {
      throw new Error('Isolated app registration has an invalid ID or entry path');
    }
    if (!app.files || typeof app.files !== 'object' || !app.files[app.entry]) {
      throw new Error('Verified package entry file is missing');
    }
    const stageRoot = path.join(os.homedir(), '.local', 'share', 'novabyte', 'isolation-staging');
    fs.mkdirSync(stageRoot, { recursive: true, mode: 0o700 });
    const stagingPath = path.join(stageRoot, app.id);
    fs.rmSync(stagingPath, { recursive: true, force: true });
    fs.mkdirSync(stagingPath, { mode: 0o700 });

    try {
      for (const [rawPath, encoded] of Object.entries(app.files)) {
        const relativePath = rawPath.replace(/\\/g, '/');
        if (!validateEntry(relativePath) || typeof encoded !== 'string') {
          throw new Error(`Invalid isolated package path: ${rawPath}`);
        }
        if (relativePath === 'package.json' ||
            relativePath === 'novabyte-isolated-bridge.js' ||
            relativePath === '.nbosp-entry') {
          continue;
        }
        const outputPath = path.join(stagingPath, ...relativePath.split('/'));
        if (!outputPath.startsWith(stagingPath + path.sep)) {
          throw new Error(`Package path escapes its staging directory: ${rawPath}`);
        }
        fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(outputPath, Buffer.from(encoded, 'base64'), { mode: 0o600, flag: 'wx' });
      }
      const runtimeManifest = {
        name: app.name || app.id,
        main: app.entry,
        nodejs: false,
        "node-main": "/usr/lib/nbosp/isolated-app-node-main.js",
        "chromium-args": [
          '--enable-features=UseOzonePlatform',
          '--ozone-platform=wayland',
          '--disable-features=Vulkan',
          '--disable-devtools',
          '--no-first-run',
        ].join(' '),
        window: {
          title: app.name || app.id,
          width: app.defaultSize?.[0] || 800,
          height: app.defaultSize?.[1] || 600,
          frame: app.frame !== false,
        },
      };
      fs.writeFileSync(path.join(stagingPath, 'package.json'),
        JSON.stringify(runtimeManifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });

      const entryPath = path.join(stagingPath, ...app.entry.split('/'));
      const html = fs.readFileSync(entryPath, 'utf8');
      if (!/<html[\s>]/i.test(html)) {
        throw new Error('Isolated app entry must be an HTML document');
      }
      const bridgePath = path.posix.relative(
        path.posix.dirname(app.entry),
        'novabyte-isolated-bridge.js',
      );
      const packageRoot = path.posix.relative(path.posix.dirname(app.entry), '.');
      const packageRootUrl = packageRoot === '.' ? './' : `${packageRoot}/`;
      const source = bridgeSource.replace(
        '__NBOSP_PACKAGE_ROOT__',
        packageRootUrl,
      );
      const bridgeTag = `<script src="${bridgePath}"></script>`;
      const injected = /<head(?:\s[^>]*)?>/i.test(html)
        ? html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}\n${bridgeTag}`)
        : html.replace(/<html(?:\s[^>]*)?>/i, match => `${match}\n<head>${bridgeTag}</head>`);
      fs.writeFileSync(entryPath, injected, { mode: 0o600 });
      fs.writeFileSync(path.join(stagingPath, 'novabyte-isolated-bridge.js'), source,
        { mode: 0o600 });
      return stagingPath;
    } catch (error) {
      fs.rmSync(stagingPath, { recursive: true, force: true });
      throw error;
    }
  }

  function constantTimeEqual(left, right, crypto) {
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return leftBytes.length === rightBytes.length &&
      crypto.timingSafeEqual(leftBytes, rightBytes);
  }

  function writeJson(response, statusCode, payload) {
    const body = JSON.stringify(payload);
    response.writeHead(statusCode, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(body);
  }

  function findSession(request, crypto) {
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return null;
    const supplied = authorization.slice(7);
    if (!/^[a-f0-9]{64}$/.test(supplied)) return null;
    for (const [token, session] of sessions) {
      if (constantTimeEqual(supplied, token, crypto)) return session;
    }
    return null;
  }

  function handleRequest(request, response) {
    if (!server || request.method !== 'POST' ||
        !['/v1/rpc', '/v1/ready', '/v1/exit'].includes(request.url)) {
      writeJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Unknown broker endpoint' } });
      return;
    }
    if (request.url === '/v1/ready' || request.url === '/v1/exit') {
      const { crypto } = nodeModules();
      const session = findSession(request, crypto);
      if (!session) {
        writeJson(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Invalid process capability' } });
        return;
      }
      if (request.url === '/v1/ready') {
        session.markReady();
        response.writeHead(204, { 'cache-control': 'no-store' });
        response.end();
        return;
      }
      session.failBeforeReady(new Error('Isolated app exited before its broker became ready'));
      for (const [token, current] of sessions) {
        if (current === session) sessions.delete(token);
      }
      response.writeHead(204, { 'cache-control': 'no-store' });
      response.end();
      return;
    }
    if (request.headers['content-type'] !== 'application/json') {
      writeJson(response, 415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Expected application/json' } });
      return;
    }

    let crypto;
    let session;
    try {
      ({ crypto } = nodeModules());
      session = findSession(request, crypto);
    } catch (error) {
      console.error('[IsolatedAppBroker] Authentication setup failed:', error);
      writeJson(response, 503, { error: { code: 'UNAVAILABLE', message: 'Broker is unavailable' } });
      return;
    }
    if (!session) {
      writeJson(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Invalid process capability' } });
      return;
    }

    const now = Date.now();
    session.requestTimes = session.requestTimes.filter(time => time > now - REQUEST_WINDOW_MS);
    if (session.pending >= MAX_PENDING_PER_APP ||
        session.requestTimes.length >= MAX_REQUESTS_PER_WINDOW) {
      writeJson(response, 429, { error: { code: 'RATE_LIMITED', message: 'Broker request limit exceeded' } });
      return;
    }

    session.pending++;
    session.requestTimes.push(now);
    let requestReleased = false;
    const releaseRequest = () => {
      if (requestReleased) return;
      requestReleased = true;
      session.pending--;
    };
    response.once('finish', releaseRequest);
    response.once('close', releaseRequest);

    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', error => {
      if (!response.headersSent && !response.destroyed) {
        console.error('[IsolatedAppBroker] Request stream failed:', error);
        writeJson(response, 400, { error: { code: 'INVALID_REQUEST', message: 'Request body was interrupted' } });
      }
    });
    request.on('end', async () => {
      if (size > MAX_BODY_BYTES) {
        writeJson(response, 413, { error: { code: 'REQUEST_TOO_LARGE', message: 'Request exceeds the broker limit' } });
        return;
      }
      let call;
      try {
        call = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
      } catch {
        writeJson(response, 400, { error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
        return;
      }
      if (!call || typeof call.type !== 'string' || typeof call.requestId !== 'string' ||
          call.requestId.length > 128 ||
          (call.payload !== undefined && (call.payload === null || typeof call.payload !== 'object'))) {
        writeJson(response, 400, { error: { code: 'INVALID_REQUEST', message: 'Request has an invalid shape' } });
        return;
      }

      try {
        const result = await window.AppSandbox.dispatchIsolatedProcessRequest({
          appId: session.appId,
          type: call.type,
          payload: call.payload || {},
          requestId: call.requestId,
        });
        if (!response.destroyed) writeJson(response, 200, result);
      } catch (error) {
        console.error('[IsolatedAppBroker] API dispatch failed:', error);
        if (!response.destroyed) {
          writeJson(response, 500, {
            type: `${call.type}:response`,
            requestId: call.requestId,
            result: null,
            error: { code: 'BROKER_ERROR', message: 'The OS could not complete this request' },
          });
        }
      } finally {
        releaseRequest();
      }
    });
  }

  async function ensureStarted() {
    if (server) return endpoint;
    const { http } = nodeModules();
    const nextServer = http.createServer(handleRequest);
    nextServer.maxHeadersCount = 16;
    nextServer.headersTimeout = 5000;
    nextServer.requestTimeout = 10_000;
    await new Promise((resolve, reject) => {
      nextServer.once('error', reject);
      nextServer.listen(BROKER_PORT, '127.0.0.1', () => {
        nextServer.removeListener('error', reject);
        resolve();
      });
    });
    const address = nextServer.address();
    if (!address || typeof address === 'string') {
      nextServer.close();
      throw new Error('Isolated app broker did not bind a TCP port');
    }

    server = nextServer;
    endpoint = `http://127.0.0.1:${address.port}/v1/rpc`;
    return endpoint;
  }

  async function installPackage(app) {
    if (process.platform !== 'linux' || app.verified !== true || !app.signer) return false;
    const { fs, path } = nodeModules();
    const stagingPath = writeStagedPackage(app);
    try {
      const result = await callSupervisor(`INSTALL ${app.id} ${app.entry}`);
      if (result !== 'installed') {
        throw new Error('Supervisor returned an unexpected installation result');
      }
      return true;
    } finally {
      fs.rmSync(stagingPath, { recursive: true, force: true });
      try { fs.rmdirSync(path.dirname(stagingPath)); }
      catch (error) { if (error.code !== 'ENOTEMPTY') throw error; }
    }
  }

  async function launchApp(app) {
    if (process.platform !== 'linux') throw new Error('Per-app UID launch is supported only on Linux');
    if (process.env.NBOSP_COMPOSITOR_MODE !== 'weston-poc') {
      throw new Error('Per-app launch requires the Weston Wayland desktop session; X11/Cage fallback is disabled');
    }
    if (app.linuxIsolated !== true || !validateAppId(app.id)) {
      throw new Error('App has no root-owned isolated Linux package registration');
    }
    const { crypto } = nodeModules();
    const brokerUrl = await ensureStarted();
    const port = new URL(brokerUrl).port;
    const token = crypto.randomBytes(32).toString('hex');
    let resolveReady, rejectReady;
    let readySettled = false;
    const readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void readyPromise.catch(() => {});
    const session = {
      appId: app.id,
      pid: null,
      pending: 0,
      requestTimes: [],
      readyPromise,
      markReady() {
        if (readySettled) return;
        readySettled = true;
        resolveReady();
      },
      failBeforeReady(error) {
        if (readySettled) return;
        readySettled = true;
        rejectReady(error);
      },
    };
    sessions.set(token, session);
    let pid = null;
    try {
      const pidText = await callSupervisor(`LAUNCH ${app.id} ${port} ${token}`);
      pid = Number(pidText);
      if (!Number.isSafeInteger(pid) || pid < 2) {
        throw new Error('App supervisor returned an invalid process ID');
      }
      session.pid = pid;
      let readyTimeout;
      try {
        await Promise.race([
          session.readyPromise,
          new Promise((_, reject) => {
            readyTimeout = setTimeout(
              () => reject(new Error('Isolated app did not become ready in time')),
              15_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(readyTimeout);
      }
      return { pid };
    } catch (error) {
      if (pid !== null) {
        try {
          await terminateApp(app.id, pid);
        } catch (terminationError) {
          throw new AggregateError(
            [error, terminationError],
            `Isolated app ${app.id} failed to launch and could not be stopped`,
          );
        }
      }
      sessions.delete(token);
      throw error;
    }
  }

  async function terminateApp(appId, pid) {
    if (!validateAppId(appId) || !Number.isSafeInteger(pid) || pid < 2) {
      throw new TypeError('A valid app ID and process ID are required');
    }
    const result = await callSupervisor(`TERMINATE ${appId} ${pid}`);
    if (result !== 'terminated') {
      throw new Error('App supervisor returned an unexpected termination result');
    }
    for (const [token, session] of sessions) {
      if (session.appId === appId && session.pid === pid) sessions.delete(token);
    }
    return true;
  }

  async function terminateAppSessions(appId) {
    if (!validateAppId(appId)) throw new TypeError('A valid app ID is required');
    const active = [...sessions.entries()]
      .filter(([, session]) => session.appId === appId && session.pid !== null);
    for (const [token, session] of active) {
      await terminateApp(appId, session.pid);
      sessions.delete(token);
    }
    return active.length;
  }

  async function uninstallPackage(appId) {
    if (!validateAppId(appId)) throw new TypeError('A valid app ID is required');
    await terminateAppSessions(appId);
    const result = await callSupervisor(`UNINSTALL ${appId}`);
    if (result !== 'uninstalled') {
      throw new Error('App supervisor returned an unexpected uninstall result');
    }
    return true;
  }

  function unregisterProcess(token) {
    if (typeof token !== 'string') return false;
    return sessions.delete(token);
  }

  async function close() {
    sessions.clear();
    if (!server) return;
    const closingServer = server;
    server = null;
    endpoint = null;
    await new Promise((resolve, reject) => {
      closingServer.close(error => error ? reject(error) : resolve());
    });
  }

  window.IsolatedAppBroker = Object.freeze({
    installPackage,
    launchApp,
    terminateApp,
    terminateAppSessions,
    uninstallPackage,
    unregisterProcess,
    close,
    getEndpoint: () => endpoint,
  });
})();
