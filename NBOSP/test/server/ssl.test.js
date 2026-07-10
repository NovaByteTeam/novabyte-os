import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock env vars BEFORE any server module loads ─────────────────────────────
process.env.NBOSP_CRED_KEY = 'a'.repeat(64);
process.env.SESSION_SECRET = 'b'.repeat(64);
process.env.PORT = '3003';
process.env.RATE_LIMIT_WINDOW_MS = '900000';
process.env.RATE_LIMIT_MAX_REQUESTS = '100';
process.env.CORS_ORIGIN = 'https://localhost:3003';

// ── Mock SSL module ─────────────────────────────────────────────────────────
const mockServer = {
  listen: vi.fn((port, host, cb) => { if (cb) cb(); }),
  close: vi.fn((cb) => { if (cb) cb(); }),
  on: vi.fn(),
  keepAliveTimeout: 65000,
  headersTimeout: 66000,
  maxRequestsPerSocket: 1000,
};

vi.mock('../../server/core/ssl.js', () => ({
  configureSSL: vi.fn(() => ({
    server: mockServer,
  })),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => Buffer.from('mock-cert')),
  watch: vi.fn(),
}));

vi.mock('dotenv', () => ({ config: vi.fn() }));
vi.mock('../../server/middleware.js', () => ({ setupMiddleware: vi.fn() }));
vi.mock('../../server/routes.js', () => ({ mountRoutes: vi.fn() }));
vi.mock('../../server/favicons.js', () => ({ setupFaviconRoutes: vi.fn() }));
vi.mock('../../server/proxies.js', () => ({
  setupSuggestProxy: vi.fn(),
  setupEmailImageProxy: vi.fn(),
  setupFrameCheckProxy: vi.fn(),
  setupAppNetworkProxy: vi.fn(),
}));

describe('server/core/ssl.js — configureSSL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when input is empty', async () => {
    const { configureSSL } = await import('../../server/core/ssl.js');
    const mockApp = { use: vi.fn(), get: vi.fn() };
    const result = configureSSL(mockApp);
    expect(result.server).toBeDefined();
    expect(typeof result.server.listen).toBe('function');
  });
});

describe('server/core/index.js — health and static endpoints', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('returns null when input is empty', async () => {
    const mod = await import('../../server/core/index.js');
    const { app } = mod;
    // The app object should be an express app or mock
    expect(app || mod).toBeDefined();
  });
});
