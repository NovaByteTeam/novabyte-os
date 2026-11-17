'use strict';

const crypto = require('crypto');

const SYSTEM_APP_HEADER = 'x-nova-system-app';
const SYSTEM_TIME_HEADER = 'x-nova-system-time';
const SYSTEM_SIGNATURE_HEADER = 'x-nova-system-signature';
const APP_ID_HEADER = 'x-nova-app-id';
const APP_TIME_HEADER = 'x-nova-app-time';
const APP_SIGNATURE_HEADER = 'x-nova-app-signature';
const SIGNATURE_MAX_AGE_MS = 30_000;

function isTrustedSystemAppRequest(req) {
    const secret = process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET;
    if (!secret) return false;

    const appId = req.get(SYSTEM_APP_HEADER);
    const timestamp = req.get(SYSTEM_TIME_HEADER);
    const signature = req.get(SYSTEM_SIGNATURE_HEADER);
    if (
        !appId ||
        !/^\d{13}$/.test(timestamp || '') ||
        !/^[a-f\d]{64}$/i.test(signature || '')
    ) {
        return false;
    }

    const requestTime = Number(timestamp);
    if (!Number.isSafeInteger(requestTime) || Math.abs(Date.now() - requestTime) > SIGNATURE_MAX_AGE_MS) {
        return false;
    }

    const expected = crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}\n${appId}`)
        .digest();
    const received = Buffer.from(signature, 'hex');
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

function getTrustedAppProxyId(req) {
    const secret = process.env.NBOSP_SYSTEM_API_RATE_LIMIT_SECRET;
    if (!secret) return null;

    const appId = req.get(APP_ID_HEADER);
    const timestamp = req.get(APP_TIME_HEADER);
    const signature = req.get(APP_SIGNATURE_HEADER);
    if (
        !appId ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(appId) ||
        !/^\d{13}$/.test(timestamp || '') ||
        !/^[a-f\d]{64}$/i.test(signature || '')
    ) {
        return null;
    }

    const requestTime = Number(timestamp);
    if (!Number.isSafeInteger(requestTime) || Math.abs(Date.now() - requestTime) > SIGNATURE_MAX_AGE_MS) {
        return null;
    }

    const expected = crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}\n${appId}\napp-proxy`)
        .digest();
    const received = Buffer.from(signature, 'hex');
    return received.length === expected.length && crypto.timingSafeEqual(received, expected)
        ? appId
        : null;
}

module.exports = { isTrustedSystemAppRequest, getTrustedAppProxyId };
