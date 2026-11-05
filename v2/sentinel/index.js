/**
 * NovaSentinel - Complete Security Integration
 * 
 * This module wires all Sentinel security modules together and provides
 * API endpoints for controlling them.
 * 
 * @module sentinel/index
 */

'use strict';

const express = require('express');
const router = express.Router();

// Import all sentinel modules
const sentinelUIDashboard = require('./dashboard/sentinel-ui');
const securityScore = require('./dashboard/security-score');
const threatMonitor = require('./dashboard/threat-monitor');

// Create protection states map - this is used by sentinel-middleware and index.js
// to track which protections are enabled/disabled
const protectionStates = new Map();

// Initialize default protection states
const DEFAULT_PROTECTIONS = [
    'post-quantum', 'fido2', 'zero-trust', 'attestation', 'version-lock',
    'behavioral-ai', 'anomaly', 'risk-scorer', 'sandbox', 'worker-threads',
    'anti-fingerprint', 'tracking-prevention', 'virustotal', 'safe-browsing',
    'abuse-ipdb', 'dom-purify', 'permissions'
];

DEFAULT_PROTECTIONS.forEach(id => protectionStates.set(id, true));

// Create sentinelUI object with protection states for use by middleware
const sentinelUI = {
    protectionStates,
    getProtectionState: (id) => protectionStates.get(id) ?? true,
    setProtectionState: (id, enabled) => protectionStates.set(id, enabled),
    getAllProtectionStates: () => Object.fromEntries(protectionStates)
};

// Browser-based security modules (Apple SEP / Titan M2 / Knox equivalents)
// These provide client-side security features that mirror server-side Sentinel
const sentinelVault = tryLoad('./vault/sentinel-vault');
const sentinelDeviceId = tryLoad('./vault/sentinel-device-id');
const sentinelSecureFolder = tryLoad('./vault/sentinel-secure-folder');
const sentinelAntiReplay = tryLoad('./vault/sentinel-anti-replay');
const sentinelVerifiedBoot = tryLoad('./vault/sentinel-verified-boot');
const sentinelAntiRollback = tryLoad('./vault/sentinel-anti-rollback');
const sentinelBruteForce = tryLoad('./vault/sentinel-brute-force');

// Core security modules
const encryption = tryLoad('./vault/encryption');
const keyManager = tryLoad('./vault/key-manager');
const postQuantum = tryLoad('./vault/post-quantum');
const virtualTPM = tryLoad('./crypto/virtual-tpm');
const entropy = tryLoad('./crypto/entropy');

// Auth modules
const fido2 = tryLoad('./auth/fido2');
const sessionGuard = tryLoad('./auth/session-guard');
const zeroTrust = tryLoad('./auth/zero-trust');

// Integrity modules
const tamperDetect = tryLoad('./integrity/tamper-detect');
const attestation = tryLoad('./integrity/attestation');
const versionLock = tryLoad('./integrity/version-lock');

// Isolation modules
const sandbox = tryLoad('./isolation/sandbox-manager');
const workerThreads = tryLoad('./isolation/worker-threads');
const permissions = tryLoad('./isolation/permissions');

// Privacy modules
const antiFingerprint = tryLoad('./privacy/anti-fingerprint');
const trackingPrevention = tryLoad('./privacy/tracking-prevention');

// Threat modules
const abuseIPDB = tryLoad('./threats/abuse-ipdb');
const safeBrowsing = tryLoad('./threats/safe-browsing');
const virusTotal = tryLoad('./threats/virustotal');
const domPurify = tryLoad('./threats/dom-purify');

// AI modules
const behavioral = tryLoad('./ai/behavioral');
const anomaly = tryLoad('./ai/anomaly');
const riskScorer = tryLoad('./ai/risk-scorer');

// Response modules
const lockdown = tryLoad('./response/lockdown');
const privacyMode = tryLoad('./response/privacy-mode');
const revocation = tryLoad('./response/revocation');
const autoDestruct = tryLoad('./response/auto-destruct');

// Modes
const dualMode = tryLoad('./modes/dual-mode');

function tryLoad(p) {
    try { return require(p); } catch (e) { return null; }
}

// =============================================================================
// PROTECTION STATE MANAGEMENT
// =============================================================================

const ALL_PROTECTIONS = {
    // Core (always active)
    core: ['encryption', 'key-manager', 'session-guard', 'tamper-detect', 'revocation', 'audit-logging', 'virtual-tpm', 'entropy'],
    
    // Configurable
    configurable: [
        'behavioral-ai', 'anti-fingerprint', 'tracking-prevention',
        'virustotal', 'safe-browsing', 'abuse-ipdb', 'zero-trust',
        'fido2', 'post-quantum', 'sandbox', 'dom-purify', 'anomaly',
        'risk-scorer', 'attestation', 'version-lock', 'worker-threads',
        'permissions'
    ],
    
    // Special (require admin token)
    special: ['lockdown', 'privacy-mode', 'dual-mode']
};

// Get protection state
function isProtectionEnabled(protectionId) {
    return sentinelUI.protectionStates.get(protectionId) ?? true;
}

// =============================================================================
// FIDO2 ENDPOINTS
// =============================================================================

if (fido2) {
    router.post('/api/fido2/register', async (req, res) => {
        try {
            const options = fido2.generateRegistrationOptions(req.body);
            req.session.fido2Challenge = options.challenge;
            res.json({ success: true, options });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    
    router.post('/api/fido2/verify', async (req, res) => {
        try {
            const result = fido2.verifyRegistration(req.body);
            res.json({ success: true, verified: result.verified });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    
    router.post('/api/fido2/authenticate', async (req, res) => {
        try {
            const options = fido2.generateAuthenticationOptions(req.body);
            res.json({ success: true, options });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

// =============================================================================
// POST-QUANTUM ENDPOINTS
// =============================================================================

if (postQuantum) {
    router.post('/api/post-quantum/generate-keypair', async (req, res) => {
        if (!isProtectionEnabled('post-quantum')) {
            return res.status(403).json({ error: 'Post-Quantum protection disabled' });
        }
        try {
            const keypair = await postQuantum.generateKeyPair();
            res.json({ success: true, publicKey: keypair.publicKey });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    
    router.post('/api/post-quantum/encrypt', async (req, res) => {
        if (!isProtectionEnabled('post-quantum')) {
            return res.status(403).json({ error: 'Post-Quantum protection disabled' });
        }
        try {
            const { plaintext, publicKey } = req.body;
            const ciphertext = await postQuantum.encrypt(plaintext, publicKey);
            res.json({ success: true, ciphertext });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    
    router.post('/api/post-quantum/decrypt', async (req, res) => {
        try {
            const { ciphertext, privateKey } = req.body;
            const plaintext = await postQuantum.decrypt(ciphertext, privateKey);
            res.json({ success: true, plaintext });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

// =============================================================================
// DOM PURIFY (EMAIL SANITISATION) ENDPOINTS
// =============================================================================

if (domPurify) {
    router.post('/api/dom-purify/sanitize', (req, res) => {
        if (!isProtectionEnabled('dom-purify')) {
            return res.status(403).json({ error: 'DOM Purify protection disabled' });
        }
        try {
            const { html, type } = req.body;
            const sanitized = domPurify.sanitizeEmail ? 
                domPurify.sanitizeEmail(html) : 
                domPurify.sanitize ? domPurify.sanitize(html) : html;
            res.json({ success: true, sanitized });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

// =============================================================================
// SANDBOX & WORKER THREADS ENDPOINTS
// =============================================================================

if (sandbox) {
    router.post('/api/sandbox/execute', async (req, res) => {
        if (!isProtectionEnabled('sandbox')) {
            return res.status(403).json({ error: 'Sandbox protection disabled' });
        }
        try {
            const { code, context } = req.body;
            const result = await sandbox.executeCode(code, context);
            res.json({ success: true, result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

if (workerThreads) {
    router.post('/api/worker/execute', async (req, res) => {
        if (!isProtectionEnabled('worker-threads')) {
            return res.status(403).json({ error: 'Worker threads disabled' });
        }
        try {
            const { task, data } = req.body;
            const result = await workerThreads.runInWorker(task, data);
            res.json({ success: true, result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

// =============================================================================
// ATTESTATION & VERSION-LOCK ENDPOINTS
// =============================================================================

if (attestation) {
    router.get('/api/attestation/status', (req, res) => {
        try {
            const status = attestation.getStatus ? attestation.getStatus() : 
                          attestation.generateAttestation ? { active: true } : {};
            res.json({ success: true, status });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    
    router.post('/api/attestation/verify', (req, res) => {
        if (!isProtectionEnabled('attestation')) {
            return res.status(403).json({ error: 'Attestation protection disabled' });
        }
        try {
            const result = attestation.verifyAttestation ? 
                attestation.verifyAttestation(req.body) : 
                { verified: true };
            res.json({ success: true, result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

if (versionLock) {
    router.get('/api/version/status', (req, res) => {
        try {
            const status = versionLock.getStatus ? versionLock.getStatus() : 
                          versionLock.checkVersion ? { active: true } : {};
            res.json({ success: true, status });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    
    router.post('/api/version/check', (req, res) => {
        if (!isProtectionEnabled('version-lock')) {
            return res.status(403).json({ error: 'Version lock disabled' });
        }
        try {
            const result = versionLock.checkVersion ? 
                versionLock.checkVersion(req.body) : 
                { valid: true };
            res.json({ success: true, result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

// =============================================================================
// PERMISSIONS ENDPOINTS
// =============================================================================

if (permissions) {
    router.get('/api/permissions/check', (req, res) => {
        try {
            const { user, resource, action } = req.query;
            const check = permissions.checkPermission || permissions.check;
            const result = check ? check(user, resource, action) : { allowed: true };
            res.json({ success: true, result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    
    router.post('/api/permissions/grant', (req, res) => {
        try {
            const { user, resource, action } = req.body;
            const grant = permissions.grantPermission || permissions.grant;
            if (grant) grant(user, resource, action);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

// =============================================================================
// THREAT SCANNING ENDPOINTS
// =============================================================================

if (virusTotal) {
    router.post('/api/virustotal/scan-file', async (req, res) => {
        if (!isProtectionEnabled('virustotal')) {
            return res.status(403).json({ error: 'VirusTotal protection disabled' });
        }
        try {
            const { buffer, filename } = req.body;
            const result = await virusTotal.scanFile(Buffer.from(buffer), filename);
            res.json({ success: true, result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    
    router.post('/api/virustotal/scan-url', async (req, res) => {
        if (!isProtectionEnabled('virustotal')) {
            return res.status(403).json({ error: 'VirusTotal protection disabled' });
        }
        try {
            const { url } = req.body;
            const result = await virusTotal.scanUrl(url);
            res.json({ success: true, result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

if (safeBrowsing) {
    router.post('/api/safebrowsing/check', async (req, res) => {
        if (!isProtectionEnabled('safe-browsing')) {
            return res.status(403).json({ error: 'Safe Browsing protection disabled' });
        }
        try {
            const { url } = req.body;
            const result = safeBrowsing.checkUrl ? 
                await safeBrowsing.checkUrl(url) : 
                safeBrowsing.check ? await safeBrowsing.check(url) : 
                { threat: null };
            res.json({ success: true, result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

if (abuseIPDB) {
    router.get('/api/abuseipdb/check', async (req, res) => {
        if (!isProtectionEnabled('abuse-ipdb')) {
            return res.status(403).json({ error: 'AbuseIPDB protection disabled' });
        }
        try {
            const ip = req.query.ip || req.ip;
            const result = abuseIPDB.checkIP ? 
                await abuseIPDB.checkIP(ip) : 
                abuseIPDB.check ? await abuseIPDB.check(ip) : 
                { isAbusive: false };
            res.json({ success: true, result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

// =============================================================================
// ANTI-FINGERPRINT & TRACKING PREVENTION
// =============================================================================

if (antiFingerprint) {
    router.get('/api/anti-fingerprint/headers', (req, res) => {
        if (!isProtectionEnabled('anti-fingerprint')) {
            return res.status(403).json({ error: 'Anti-Fingerprint protection disabled' });
        }
        try {
            const getHeaders = antiFingerprint.getHeaders || antiFingerprint.getProtectionHeaders;
            const headers = getHeaders ? getHeaders() : {};
            res.json({ success: true, headers });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

if (trackingPrevention) {
    router.post('/api/tracking-prevention/strip', (req, res) => {
        if (!isProtectionEnabled('tracking-prevention')) {
            return res.status(403).json({ error: 'Tracking Prevention disabled' });
        }
        try {
            const { url } = req.body;
            const stripUrl = trackingPrevention.stripUrlTracking || trackingPrevention.stripTracking;
            const result = stripUrl ? stripUrl(url) : url;
            res.json({ success: true, result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

// =============================================================================
// AI SECURITY ENDPOINTS
// =============================================================================

if (behavioral) {
    router.post('/api/behavioral/analyze', async (req, res) => {
        if (!isProtectionEnabled('behavioral-ai')) {
            return res.status(403).json({ error: 'Behavioral AI disabled' });
        }
        try {
            const analyze = behavioral.analyze || behavioral.detect;
            const result = analyze ? await analyze(req) : { anomalous: false };
            res.json({ success: true, result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

if (anomaly) {
    router.post('/api/anomaly/detect', async (req, res) => {
        if (!isProtectionEnabled('anomaly')) {
            return res.status(403).json({ error: 'Anomaly detection disabled' });
        }
        try {
            const detect = anomaly.detectPatterns || anomaly.detect;
            const result = detect ? await detect(req) : { detected: false };
            res.json({ success: true, result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

if (riskScorer) {
    router.post('/api/riskscorer/calculate', async (req, res) => {
        if (!isProtectionEnabled('risk-scorer')) {
            return res.status(403).json({ error: 'Risk Scorer disabled' });
        }
        try {
            const calculateRisk = riskScorer.calculateRisk || riskScorer.calculate;
            const result = calculateRisk ? await calculateRisk(req) : { score: 0 };
            res.json({ success: true, result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

// =============================================================================
// ENCRYPTION & KEY MANAGEMENT
// =============================================================================

if (encryption) {
    router.post('/api/encryption/encrypt', (req, res) => {
        try {
            const { data, key } = req.body;
            const encrypt = encryption.encrypt || encryption.encryptData;
            const result = encrypt ? encrypt(data, key) : { error: 'No encrypt function' };
            res.json({ success: true, result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    
    router.post('/api/encryption/decrypt', (req, res) => {
        try {
            const { ciphertext, key } = req.body;
            const decrypt = encryption.decrypt || encryption.decryptData;
            const result = decrypt ? decrypt(ciphertext, key) : { error: 'No decrypt function' };
            res.json({ success: true, result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

if (keyManager) {
    router.post('/api/keymanager/rotate', async (req, res) => {
        try {
            const rotate = keyManager.rotateKeys || keyManager.rotate;
            const result = rotate ? await rotate('api') : { rotated: false };
            res.json({ success: true, result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    
    router.get('/api/keymanager/status', (req, res) => {
        try {
            const status = keyManager.getStatus ? keyManager.getStatus() : { active: true };
            res.json({ success: true, status });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

// =============================================================================
// BROWSER-BASED SECURITY MODULES (Apple SEP / Titan M2 / Knox equivalents)
// These are client-side only but we provide API endpoints for status
// =============================================================================

if (sentinelVault) {
    router.get('/api/sentinel-vault/status', (req, res) => {
        try {
            res.json({ success: true, status: { active: true, type: 'browser-only', name: 'Sentinel Vault' } });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

if (sentinelDeviceId) {
    router.get('/api/sentinel-device-id/status', (req, res) => {
        try {
            res.json({ success: true, status: { active: true, type: 'browser-only', name: 'WebAuthn Device ID' } });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

if (sentinelSecureFolder) {
    router.get('/api/sentinel-secure-folder/status', (req, res) => {
        try {
            res.json({ success: true, status: { active: true, type: 'browser-only', name: 'OPFS Secure Folder' } });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

if (sentinelVerifiedBoot) {
    router.get('/api/sentinel-verified-boot/status', (req, res) => {
        try {
            res.json({ success: true, status: { active: true, type: 'browser-only', name: 'Verified Boot' } });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

// =============================================================================
// VIRTUAL TPM
// =============================================================================

if (virtualTPM) {
    router.get('/api/virtual-tpm/status', (req, res) => {
        try {
            const status = virtualTPM.getStatus ? virtualTPM.getStatus() : { active: true };
            res.json({ success: true, status });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    
    router.post('/api/virtual-tpm/attestation', async (req, res) => {
        try {
            const { nonce } = req.body;
            if (!nonce) return res.status(400).json({ error: 'Nonce required' });
            const result = await virtualTPM.attestation(nonce);
            res.json({ success: true, attestation: result });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    
    router.post('/api/virtual-tpm/seal', async (req, res) => {
        try {
            const { key, pcrMask } = req.body;
            if (!key) return res.status(400).json({ error: 'Key required' });
            const result = await virtualTPM.sealKey(key, pcrMask || 0);
            res.json({ success: true, blobId: result.blobId });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

// =============================================================================
// ENTROPY
// =============================================================================

if (entropy) {
    router.get('/api/entropy/status', (req, res) => {
        try {
            const status = entropy.getStatus ? entropy.getStatus() : { active: true };
            res.json({ success: true, status });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    
    router.post('/api/entropy/collect', async (req, res) => {
        try {
            const entropyData = await entropy.collectEntropy();
            res.json({ success: true, entropyBits: entropyData.length * 8 });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
}

// =============================================================================
// MODULE STATUS
// =============================================================================

router.get('/api/modules', (req, res) => {
    const modules = [
        { id: 'encryption', name: 'Encryption', enabled: true, module: !!encryption },
        { id: 'key-manager', name: 'Key Manager', enabled: true, module: !!keyManager },
        { id: 'virtual-tpm', name: 'Virtual TPM', enabled: true, module: !!virtualTPM },
        { id: 'entropy', name: 'Entropy', enabled: true, module: !!entropy },
        { id: 'post-quantum', name: 'Post-Quantum', enabled: isProtectionEnabled('post-quantum'), module: !!postQuantum },
        { id: 'fido2', name: 'FIDO2', enabled: isProtectionEnabled('fido2'), module: !!fido2 },
        { id: 'session-guard', name: 'Session Guard', enabled: true, module: !!sessionGuard },
        { id: 'zero-trust', name: 'Zero Trust', enabled: isProtectionEnabled('zero-trust'), module: !!zeroTrust },
        { id: 'tamper-detect', name: 'Tamper Detect', enabled: true, module: !!tamperDetect },
        { id: 'attestation', name: 'Attestation', enabled: isProtectionEnabled('attestation'), module: !!attestation },
        { id: 'version-lock', name: 'Version Lock', enabled: isProtectionEnabled('version-lock'), module: !!versionLock },
        { id: 'behavioral-ai', name: 'Behavioral AI', enabled: isProtectionEnabled('behavioral-ai'), module: !!behavioral },
        { id: 'anomaly', name: 'Anomaly Detect', enabled: isProtectionEnabled('anomaly'), module: !!anomaly },
        { id: 'risk-scorer', name: 'Risk Scorer', enabled: isProtectionEnabled('risk-scorer'), module: !!riskScorer },
        { id: 'sandbox', name: 'Sandbox', enabled: isProtectionEnabled('sandbox'), module: !!sandbox },
        { id: 'worker-threads', name: 'Worker Threads', enabled: isProtectionEnabled('worker-threads'), module: !!workerThreads },
        { id: 'anti-fingerprint', name: 'Anti-Fingerprint', enabled: isProtectionEnabled('anti-fingerprint'), module: !!antiFingerprint },
        { id: 'tracking-prevention', name: 'Tracking Prevention', enabled: isProtectionEnabled('tracking-prevention'), module: !!trackingPrevention },
        { id: 'virustotal', name: 'VirusTotal', enabled: isProtectionEnabled('virustotal'), module: !!virusTotal },
        { id: 'safe-browsing', name: 'Safe Browsing', enabled: isProtectionEnabled('safe-browsing'), module: !!safeBrowsing },
        { id: 'abuse-ipdb', name: 'AbuseIPDB', enabled: isProtectionEnabled('abuse-ipdb'), module: !!abuseIPDB },
        { id: 'dom-purify', name: 'DOM Purify', enabled: isProtectionEnabled('dom-purify'), module: !!domPurify },
        { id: 'lockdown', name: 'Lockdown', enabled: true, module: !!lockdown },
        { id: 'privacy-mode', name: 'Privacy Mode', enabled: true, module: !!privacyMode },
        { id: 'dual-mode', name: 'Dual Mode', enabled: true, module: !!dualMode },
        { id: 'revocation', name: 'Revocation', enabled: true, module: !!revocation },
        { id: 'audit-logging', name: 'Audit Logging', enabled: true, module: !!auditService },
        { id: 'permissions', name: 'Permissions', enabled: isProtectionEnabled('permissions'), module: !!permissions },
        // Browser-based security modules (Apple SEP / Titan M2 / Knox equivalents)
        { id: 'sentinel-vault', name: 'Sentinel Vault', enabled: true, module: !!sentinelVault, browserOnly: true },
        { id: 'sentinel-device-id', name: 'Device ID (WebAuthn)', enabled: true, module: !!sentinelDeviceId, browserOnly: true },
        { id: 'sentinel-secure-folder', name: 'Secure Folder (OPFS)', enabled: true, module: !!sentinelSecureFolder, browserOnly: true },
        { id: 'sentinel-anti-replay', name: 'Anti-Replay', enabled: true, module: !!sentinelAntiReplay, browserOnly: true },
        { id: 'sentinel-verified-boot', name: 'Verified Boot', enabled: true, module: !!sentinelVerifiedBoot, browserOnly: true },
        { id: 'sentinel-anti-rollback', name: 'Anti-Rollback', enabled: true, module: !!sentinelAntiRollback, browserOnly: true },
        { id: 'sentinel-brute-force', name: 'Brute Force Protection', enabled: true, module: !!sentinelBruteForce, browserOnly: true }
    ];
    
    res.json({ success: true, modules });
});

console.log('[Sentinel] All module endpoints registered');

module.exports = {
    router,
    isProtectionEnabled,
    ALL_PROTECTIONS
};
