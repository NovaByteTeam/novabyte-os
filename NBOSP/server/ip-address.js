'use strict';

const net = require('net');

function ipv6Words(ip) {
    let address = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (net.isIP(address) !== 6) return null;

    if (address.includes('.')) {
        const lastColon = address.lastIndexOf(':');
        const octets = address.slice(lastColon + 1).split('.').map(Number);
        const high = ((octets[0] << 8) | octets[1]).toString(16);
        const low = ((octets[2] << 8) | octets[3]).toString(16);
        address = `${address.slice(0, lastColon + 1)}${high}:${low}`;
    }

    const compressedAt = address.indexOf('::');
    let parts;
    if (compressedAt === -1) {
        parts = address.split(':');
        if (parts.length !== 8) return null;
    } else {
        if (address.indexOf('::', compressedAt + 2) !== -1) return null;
        const left = address.slice(0, compressedAt).split(':').filter(Boolean);
        const right = address.slice(compressedAt + 2).split(':').filter(Boolean);
        const zeroCount = 8 - left.length - right.length;
        if (zeroCount < 1) return null;
        parts = [...left, ...Array(zeroCount).fill('0'), ...right];
    }

    if (parts.length !== 8 || parts.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
    return parts.map(part => parseInt(part, 16));
}

function extractMappedV4(ip) {
    const words = ipv6Words(ip);
    if (!words || words.slice(0, 5).some(word => word !== 0) || words[5] !== 0xffff) return null;
    return [
        words[6] >> 8,
        words[6] & 0xff,
        words[7] >> 8,
        words[7] & 0xff,
    ].join('.');
}

module.exports = { extractMappedV4 };
