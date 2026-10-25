'use strict';

const http = require('node:http');

const brokerUrl = process.env.NBOSP_BROKER_URL;
const brokerToken = process.env.NBOSP_BROKER_TOKEN;
const appId = process.env.NBOSP_APP_ID;
const url = new URL(brokerUrl);

if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
    url.pathname !== '/v1/rpc' || url.port !== '49173' ||
    !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(appId) || appId.includes('..') ||
    !/^[a-f0-9]{64}$/.test(brokerToken)) {
  throw new Error('Invalid isolated app broker configuration');
}

function respond(page, requestId, response) {
  page.dispatchEvent(new page.CustomEvent('nbosp-api-response', {
    detail: { requestId, ...response },
  }));
}

function notifyBroker(path) {
  const request = http.request({
    hostname: '127.0.0.1',
    port: url.port,
    path,
    method: 'POST',
    headers: { authorization: `Bearer ${brokerToken}` },
    timeout: 2000,
  }, response => response.resume());
  request.on('error', error => {
    console.error('[NBOSP isolated app] Broker lifecycle notification failed:', error.message);
  });
  request.end();
}

function dispatch(page, detail) {
  let call;
  try {
    call = JSON.parse(JSON.stringify(detail));
  } catch {
    return;
  }
  if (!call || typeof call.type !== 'string' || !call.type.startsWith('nova:') ||
      typeof call.requestId !== 'string' || call.requestId.length > 128 ||
      !call.payload || typeof call.payload !== 'object' || Array.isArray(call.payload)) {
    return;
  }

  const body = Buffer.from(JSON.stringify({
    type: call.type,
    payload: call.payload,
    requestId: `${appId}-${call.requestId}`,
  }));
  if (body.length > 10 * 1024 * 1024) {
    respond(page, call.requestId, {
      error: { code: 'REQUEST_TOO_LARGE', message: 'Request exceeds the broker limit' },
    });
    return;
  }

  const request = http.request({
    hostname: '127.0.0.1',
    port: url.port,
    path: url.pathname,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': body.length,
      authorization: `Bearer ${brokerToken}`,
    },
    timeout: 30_000,
  }, response => {
    const chunks = [];
    let size = 0;
    response.on('data', chunk => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) {
        request.destroy(new Error('Broker response exceeded the size limit'));
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => {
      let result;
      try {
        result = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
      } catch {
        respond(page, call.requestId, {
          error: { code: 'INVALID_RESPONSE', message: 'NovaByte API returned invalid JSON' },
        });
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300 || result.error) {
        respond(page, call.requestId, {
          error: result.error || {
            code: 'API_ERROR',
            message: 'NovaByte API request failed',
          },
        });
        return;
      }
      respond(page, call.requestId, { result: result.result });
    });
  });
  request.on('timeout', () => request.destroy(new Error('Broker request timed out')));
  request.on('error', error => {
    console.error('[NBOSP isolated app] Broker request failed:', error.message);
    respond(page, call.requestId, {
      error: { code: 'BROKER_UNAVAILABLE', message: 'NovaByte API broker is unavailable' },
    });
  });
  request.end(body);
}

const appWindow = nw.Window.get();
appWindow.on('loaded', () => {
  const page = appWindow.window;
  page.addEventListener('nbosp-api-call', event => dispatch(page, event.detail));
  page.addEventListener('nbosp-bridge-initialized', () => notifyBroker('/v1/ready'), { once: true });
  page.dispatchEvent(new page.Event('nbosp-broker-ready'));
  appWindow.on('closed', () => notifyBroker('/v1/exit'));
});
