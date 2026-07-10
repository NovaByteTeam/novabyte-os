import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock env vars BEFORE any server module loads ─────────────────────────────
process.env.NBOSP_CRED_KEY = 'a'.repeat(64);
process.env.SESSION_SECRET = 'b'.repeat(64);
process.env.PORT = '3003';
process.env.RATE_LIMIT_WINDOW_MS = '900000';
process.env.RATE_LIMIT_MAX_REQUESTS = '100';
process.env.CORS_ORIGIN = 'https://localhost:3003';

// ── Mock server/core/index.js ──────────────────────────────────────────────
// The server module starts listening on import, so we mock the HTTP server
// and SSL setup to capture the app without binding a real port.

vi.mock('dotenv', () => ({
  config: vi.fn(),
}));

const mockApp = {
  get: vi.fn(),
  post: vi.fn(),
  use: vi.fn(),
  set: vi.fn(),
  listen: vi.fn(),
  on: vi.fn(),
  param: vi.fn(),
};

const mockServer = {
  listen: vi.fn((port, host, cb) => {
    if (cb) cb();
  }),
  close: vi.fn((cb) => { if (cb) cb(); }),
  on: vi.fn(),
  keepAliveTimeout: 65000,
  headersTimeout: 66000,
  maxRequestsPerSocket: 1000,
};

vi.mock('https', () => ({
  createServer: vi.fn(() => mockServer),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => Buffer.from('mock-cert')),
    watch: vi.fn(),
  };
});

vi.mock('../../server/core/ssl.js', () => ({
  configureSSL: vi.fn(() => ({ server: mockServer })),
}));

vi.mock('../../server/middleware.js', () => ({
  setupMiddleware: vi.fn(),
}));

vi.mock('../../server/routes.js', () => ({
  mountRoutes: vi.fn(),
}));

vi.mock('../../server/favicons.js', () => ({
  setupFaviconRoutes: vi.fn(),
}));

vi.mock('../../server/proxies.js', () => ({
  setupSuggestProxy: vi.fn(),
  setupEmailImageProxy: vi.fn(),
  setupFrameCheckProxy: vi.fn(),
  setupAppNetworkProxy: vi.fn(),
}));

describe('server/core/index.js — route registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('imports without starting a real server', async () => {
    const mod = await import('../../server/core/index.js');
    // The mocked module should export app and server
    expect(mod).toBeDefined();
  });
});
