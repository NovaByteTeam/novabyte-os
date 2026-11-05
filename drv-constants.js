'use strict';

const DRV_FORMAT_VERSION = '1.0';

const ALLOWED_PERMISSIONS = [
    'display',       // read/write display info
    'browser',       // browser UA optimisations
    'network',       // network status queries
    'storage',       // OPFS access (sandboxed)
    'usb',           // USB device enumeration (Node)
    'serial',        // Serial port access (Node)
    'audio',         // Audio device info
    'input',         // Input device info
    'system',        // System info (CPU/RAM)
    'notifications'  // Push notifications
];

const DANGEROUS_PERMISSIONS = ['serial', 'usb', 'system'];

module.exports = { DRV_FORMAT_VERSION, ALLOWED_PERMISSIONS, DANGEROUS_PERMISSIONS };
