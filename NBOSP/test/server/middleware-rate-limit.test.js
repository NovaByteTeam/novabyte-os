import { describe, expect, it } from 'vitest';
import middleware from '../../server/middleware.js';

const { shouldSkipGlobalApiRateLimit } = middleware;

function request(originalUrl, path) {
  return {
    originalUrl,
    path,
    get: () => undefined,
  };
}

describe('global API rate-limit exclusions', () => {
  it('excludes app registration using the full route despite Express mount stripping', () => {
    expect(shouldSkipGlobalApiRateLimit(
      request('/api/apps/serve/register?retry=1', '/apps/serve/register')
    )).toBe(true);
  });

  it('keeps mounted-path exclusions and does not skip ordinary API requests', () => {
    expect(shouldSkipGlobalApiRateLimit(
      request('/api/apps/serve/unregister/sandbox_a', '/apps/serve/unregister/sandbox_a')
    )).toBe(true);
    expect(shouldSkipGlobalApiRateLimit(
      request('/api/apps/serve/asset', '/apps/serve/asset')
    )).toBe(false);
  });
});
