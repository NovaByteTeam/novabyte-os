import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const { createServerEnv, getMainWindowOptions, closeRequestIgnored } = createRequire(import.meta.url)('../../scripts/startup.js');

describe('startup server environment', () => {
  const originalSecret = process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET;
    else process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET = originalSecret;
  });

  it('passes the generated system API secret to the server child', () => {
    const serverEnv = createServerEnv();
    expect(serverEnv.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET).toMatch(/^[a-f0-9]{64}$/);
    expect(serverEnv.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET)
      .toBe(process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET);
  });

  it('opens the kiosk NovaByte window fullscreen, frameless, and non-resizable', () => {
    expect(getMainWindowOptions(true)).toMatchObject({
      title: 'NovaByte',
      fullscreen: true,
      kiosk: true,
      frame: false,
      resizable: false,
    });
  });

  it('keeps regular development windows windowed and framed', () => {
    expect(getMainWindowOptions(false)).toMatchObject({
      title: 'NovaByte',
      fullscreen: false,
      kiosk: false,
      frame: true,
      resizable: true,
    });
  });
});

describe('Alt+F4 guard for the main NovaByte window', () => {
  const cleanEnv = () => ({ NBOSP_KIOSK: undefined, NBOSP_ALLOW_WINDOW_CLOSE: undefined });

  it('ignores WM close requests in every mode — kiosk AND regular', () => {
    // Alt+F4 must never take the whole OS down; the tray power menu owns
    // shutdown. (Previously the guard only applied to NBOSP_KIOSK=1.)
    expect(closeRequestIgnored({}, cleanEnv())).toBe(true);
    expect(closeRequestIgnored({}, { NBOSP_KIOSK: '1' })).toBe(true);
    expect(closeRequestIgnored({}, { NBOSP_KIOSK: '0' })).toBe(true);
  });

  it('lets the OS shutdown flow force the close programmatically', () => {
    expect(closeRequestIgnored({ __nbospForceClose: true }, cleanEnv())).toBe(false);
  });

  it('lets developers opt out with NBOSP_ALLOW_WINDOW_CLOSE=1', () => {
    expect(closeRequestIgnored({}, { NBOSP_ALLOW_WINDOW_CLOSE: '1' })).toBe(false);
    // the force flag still wins when both are set
    expect(closeRequestIgnored({ __nbospForceClose: true }, { NBOSP_ALLOW_WINDOW_CLOSE: '1' })).toBe(false);
  });
});
