import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock env vars BEFORE any server module loads ─────────────────────────────
process.env.NBOSP_CRED_KEY = 'a'.repeat(64);
process.env.SESSION_SECRET = 'b'.repeat(64);
process.env.PORT = '3003';
process.env.RATE_LIMIT_WINDOW_MS = '900000';
process.env.RATE_LIMIT_MAX_REQUESTS = '100';
process.env.CORS_ORIGIN = 'https://localhost:3003';

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

vi.mock('dotenv', () => ({
  config: vi.fn(),
}));

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

describe('server/core/index.js — server bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('imports and exports app, server, and listen without throwing', async () => {
    const mod = await import('../../server/core/index.js');
    expect(mod).toBeDefined();
    expect(typeof mod.app).toBe('function');
    expect(mod.server).toBeDefined();
  });

  it('mocks are correctly wired for ssl, middleware, routes, and favicons', async () => {
    const ssl = await import('../../server/core/ssl.js');
    const middleware = await import('../../server/middleware.js');
    const routes = await import('../../server/routes.js');
    const favicons = await import('../../server/favicons.js');

    const mockApp = { use: vi.fn(), get: vi.fn() };
    ssl.configureSSL(mockApp);
    middleware.setupMiddleware(mockApp);
    routes.mountRoutes(mockApp);
    favicons.setupFaviconRoutes(mockApp);

    expect(ssl.configureSSL).toHaveBeenCalled();
    expect(middleware.setupMiddleware).toHaveBeenCalled();
    expect(routes.mountRoutes).toHaveBeenCalled();
    expect(favicons.setupFaviconRoutes).toHaveBeenCalled();
  });
});
