import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const rateLimitAuth = require('../../server/rate-limit-auth.js');

const { isTrustedSystemAppRequest, getTrustedAppProxyId } = rateLimitAuth;

const SECRET = 'test-rate-limit-secret';
const APP_ID = 'com.nbosp.email';

function makeRequest({ appId = APP_ID, timestamp = String(Date.now()), secret = SECRET } = {}) {
    const signature = crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}\n${appId}`)
        .digest('hex');
    const headers = {
        'x-nova-system-app': appId,
        'x-nova-system-time': timestamp,
        'x-nova-system-signature': signature,
    };
    return { _headers: headers, get: (name) => headers[name.toLowerCase()] };
}

function makeProxyRequest({ appId = APP_ID, timestamp = String(Date.now()), secret = SECRET } = {}) {
    const signature = crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}\n${appId}\napp-proxy`)
        .digest('hex');
    const headers = {
        'x-nova-app-id': appId,
        'x-nova-app-time': timestamp,
        'x-nova-app-signature': signature,
    };
    return { _headers: headers, get: (name) => headers[name.toLowerCase()] };
}

describe('system-app rate-limit authentication', () => {
    afterEach(() => {
        delete process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET;
    });

    describe('app network proxy identity authentication', () => {
        afterEach(() => {
            delete process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET;
        });

        it('returns the host-authenticated app id for a fresh app-proxy signature', () => {
            process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET = SECRET;
            expect(getTrustedAppProxyId(makeProxyRequest())).toBe(APP_ID);
        });

        it('rejects forged, stale, and malformed app identity signatures', () => {
            process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET = SECRET;
            expect(getTrustedAppProxyId(makeProxyRequest({ secret: 'attacker-controlled' }))).toBeNull();
            expect(getTrustedAppProxyId(makeProxyRequest({ timestamp: String(Date.now() - 60_000) }))).toBeNull();
            expect(getTrustedAppProxyId(makeProxyRequest({ appId: 'bad app id' }))).toBeNull();
        });
    });

    it('accepts a fresh signature from the current server launch', () => {
        process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET = SECRET;
        expect(isTrustedSystemAppRequest(makeRequest())).toBe(true);
    });

    it('rejects unsigned or forged app-id headers', () => {
        process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET = SECRET;
        const forged = makeRequest({ secret: 'attacker-controlled' });
        expect(isTrustedSystemAppRequest(forged)).toBe(false);
    });

    it('rejects expired signatures', () => {
        process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET = SECRET;
        const expired = makeRequest({ timestamp: String(Date.now() - 60_000) });
        expect(isTrustedSystemAppRequest(expired)).toBe(false);
    });

    it('does not trust a marker when the launch secret is unavailable', () => {
        expect(isTrustedSystemAppRequest(makeRequest())).toBe(false);
    });

    it('rejects requests without an app-id header before touching crypto', () => {
        process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET = SECRET;
        const noApp = makeRequest();
        delete noApp._headers['x-nova-system-app'];
        expect(isTrustedSystemAppRequest(noApp)).toBe(false);
    });

    it('rejects requests with a malformed timestamp', () => {
        process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET = SECRET;
        const badTime = makeRequest({ timestamp: 'not-a-epoch' });
        expect(isTrustedSystemAppRequest(badTime)).toBe(false);
        // 12 digits and 14 digits are both outside the exact-13-digit contract
        expect(isTrustedSystemAppRequest(makeRequest({ timestamp: '123456789012' }))).toBe(false);
        expect(isTrustedSystemAppRequest(makeRequest({ timestamp: '12345678901234' }))).toBe(false);
    });

    it('rejects requests with a missing or malformed signature header', () => {
        process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET = SECRET;
        const noSig = makeRequest();
        delete noSig._headers['x-nova-system-signature'];
        expect(isTrustedSystemAppRequest(noSig)).toBe(false);

        const badSig = makeRequest();
        badSig._headers['x-nova-system-signature'] = 'zz'; // not 64 hex chars
        expect(isTrustedSystemAppRequest(badSig)).toBe(false);
    });

    it('rejects requests whose timestamp header is missing entirely', () => {
        process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET = SECRET;
        const noTime = makeRequest();
        delete noTime._headers['x-nova-system-time'];
        expect(isTrustedSystemAppRequest(noTime)).toBe(false);

        // empty string is equally unusable
        const emptyTime = makeRequest();
        emptyTime._headers['x-nova-system-time'] = '';
        expect(isTrustedSystemAppRequest(emptyTime)).toBe(false);
    });
});
