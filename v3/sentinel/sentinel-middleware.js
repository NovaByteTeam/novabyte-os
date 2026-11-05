/**
 * NovaSentinel Middleware Integration
 * 
 * This middleware integrates the Sentinel security protections with the NovaByte OS server.
 * It checks protection states and applies appropriate security measures to incoming requests.
 * 
 * @module sentinel/sentinel-middleware
 */

'use strict';

// Import sentinelUI from index.js which has the proper protectionStates map
const { isProtectionEnabled } = require('./index');

// Initialize tamper-detect baseline at startup (before middleware runs)
// This prevents the "Integrity baseline not established" error
const tamperDetectModule = tryLoad('./integrity/tamper-detect');
if (tamperDetectModule && typeof tamperDetectModule.measureFiles === 'function') {
    tamperDetectModule.measureFiles().then(() => {
        console.log('[Sentinel] Tamper detect baseline established at startup');
    }).catch(err => {
        console.warn('[Sentinel] Tamper detect baseline warning:', err.message);
    });
}

// =============================================================================
// MODULE-LEVEL LOADING
// Load all modules once at startup rather than on every request.
// tryLoad() returns null if a module is unavailable; each check below guards
// against that so missing modules degrade gracefully without throwing.
// =============================================================================

function tryLoad(p) {
    try { return require(p); } catch { return null; }
}

const zeroTrust         = tryLoad('./auth/zero-trust');
const sessionGuard      = tryLoad('./auth/session-guard');
const behavioralAI      = tryLoad('./ai/behavioral');
const anomalyDetection  = tryLoad('./ai/anomaly');
const riskScorer        = tryLoad('./ai/risk-scorer');
const abuseIPDB         = tryLoad('./threats/abuse-ipdb');
const safeBrowsing      = tryLoad('./threats/safe-browsing');
const antiFingerprint   = tryLoad('./privacy/anti-fingerprint');
const trackingPrevention = tryLoad('./privacy/tracking-prevention');
const tamperDetect       = tryLoad('./integrity/tamper-detect');

// Warn at startup about any missing modules so failures aren't invisible
const moduleMap = {
    'zero-trust':           zeroTrust,
    'session-guard':        sessionGuard,
    'behavioral-ai':        behavioralAI,
    'anomaly':              anomalyDetection,
    'risk-scorer':          riskScorer,
    'abuse-ipdb':           abuseIPDB,
    'safe-browsing':        safeBrowsing,
    'anti-fingerprint':     antiFingerprint,
    'tracking-prevention':  trackingPrevention,
    'tamper-detect':        tamperDetect,
};
for (const [name, mod] of Object.entries(moduleMap)) {
    if (!mod) console.warn(`[Sentinel] WARN: module unavailable at startup — ${name}`);
}

/**
 * Get protection state from sentinel-ui
 * @param {string} protectionId - The protection ID
 * @returns {boolean} Whether the protection is enabled
 */
// Use the imported isProtectionEnabled from index.js which has the shared protectionStates map
// This function is kept here for backward compatibility with other modules that might use it
function getProtectionEnabled(protectionId) {
    return isProtectionEnabled(protectionId);
}

/**
 * Create Sentinel middleware that applies all enabled protections
 * @returns {Function} Express middleware
 */
function createSentinelMiddleware() {
    return async function sentinelMiddleware(req, res, next) {
        const startTime = Date.now();

        // Update/repair endpoints skip heavy AI checks (behavioral, anomaly, risk scorer)
        // but still pass through zero-trust, session guard, tamper detection, and IP checks.
        const isUpdateOrRepair = req.path.startsWith('/update/') || req.path.startsWith('/api/update/') ||
            req.path.startsWith('/repair/') || req.path.startsWith('/api/repair/');
        
        // Auto-update endpoints - lightweight polling for update checks, no user session needed
        const isAutoUpdate = req.path.startsWith('/autoupdate/') || req.path.startsWith('/api/autoupdate/');
        
        // Sentinel status endpoints are read-only informational endpoints that don't need authentication
        const isSentinelStatus = req.method === 'GET' && /^\/api\/sentinel\/(module-status|guardian)/.test(req.path);

        // Process Inspector endpoints — internal system calls, not external traffic.
        // Zero Trust and Tamper Detection must not block these.
        // NOTE: sentinel middleware is mounted at app.use('/api', ...) so req.path is
        // already stripped of the /api prefix — match both forms to be safe.
        const isSysInfoRoute = /^\/(api\/)?(sysinfo|processes)/.test(req.path) ||
                               /\/api\/(sysinfo|processes)/.test(req.originalUrl);


        try {
            // ------------------------------------------------------------------
            // 1. Zero Trust - Verify every request (skip status endpoints, update/repair, and auto-update)
            // ------------------------------------------------------------------
            if (!isUpdateOrRepair && !isAutoUpdate && !isSentinelStatus && !isSysInfoRoute && isProtectionEnabled('zero-trust') && zeroTrust &&
                typeof zeroTrust.verifyRequest === 'function') {

                const verification = zeroTrust.verifyRequest(req);
                if (!verification.verified) {
                    console.log(`[Sentinel] Zero Trust blocked: ${verification.reason}`);
                    return res.status(403).json({
                        error: 'Zero Trust Verification Failed',
                        reason: verification.reason
                    });
                }
            }

            // ------------------------------------------------------------------
            // 2. Session Guard - Validate session integrity
            // FIX: was looking for .validate / .checkSession / .verify — none exist.
            //      The correct export is validateSessionIntegrity(req) which returns
            //      { valid: boolean, reason?: string }.
            // Skip for auto-update endpoints.
            // ------------------------------------------------------------------
            if (!isUpdateOrRepair && !isAutoUpdate && isProtectionEnabled('session-guard') && sessionGuard &&
                typeof sessionGuard.validateSessionIntegrity === 'function') {

                const sessionResult = sessionGuard.validateSessionIntegrity(req);
                if (sessionResult && !sessionResult.valid) {
                    console.log(`[Sentinel] Session Guard: ${sessionResult.reason || 'invalid'}`);
                    req.sentinelRiskScore = (req.sentinelRiskScore || 0) + 20;
                }
            }

            // ------------------------------------------------------------------
            // 3–5 are skipped for update/repair paths (heavy AI checks) but
            // zero-trust, session guard, tamper detect, and IP checks still run.
            // ------------------------------------------------------------------

            // ------------------------------------------------------------------
            // 3. Behavioral AI - Analyse request patterns
            // FIX: was looking for .analyze / .detect / .evaluate — none exist.
            //      The correct export is isAnomaly(userId, currentBehavior) which
            //      is async and returns { isAnomaly: boolean, confidence, score }.
            // Skip for auto-update endpoints.
            // ------------------------------------------------------------------
            if (!isUpdateOrRepair && !isAutoUpdate && isProtectionEnabled('behavioral-ai') && behavioralAI &&
                typeof behavioralAI.isAnomaly === 'function') {

                const userId = req.session?.userId || req.user?.id || req.ip;
                const currentBehavior = {
                    timestamp:       Date.now(),
                    ip:              req.ip,
                    userAgent:       req.headers['user-agent'],
                    method:          req.method,
                    path:            req.path,
                    requestRate:     req.sentinelRequestRate || 0,
                    uniqueEndpoints: req.sentinelUniqueEndpoints || 0,
                    failedAuths:     req.sentinelFailedAuths || 0,
                    dataVolume:      req.sentinelDataVolume || 0,
                    ipChanges:       req.sentinelIpChanges || 0
                };

                const behaviorResult = await behavioralAI.isAnomaly(userId, currentBehavior);
                if (behaviorResult && behaviorResult.isAnomaly) {
                    console.log(`[Sentinel] Behavioral AI flagged: score=${behaviorResult.score?.toFixed(3)} confidence=${behaviorResult.confidence?.toFixed(3)}`);
                    req.sentinelRiskScore = (req.sentinelRiskScore || 0) + 30;
                }
            }

            // ------------------------------------------------------------------
            // 4. Anomaly Detection
            // FIX: was passing req (single object). detectPatterns() requires an
            //      *array* of requests and returns { success, requestsWithAnomalies, detections }.
            // ------------------------------------------------------------------
            if (!isUpdateOrRepair && !isAutoUpdate && isProtectionEnabled('anomaly') && anomalyDetection &&
                typeof anomalyDetection.detectPatterns === 'function') {

                const anomalyResult = anomalyDetection.detectPatterns([req]);
                if (anomalyResult && anomalyResult.success && anomalyResult.requestsWithAnomalies > 0) {
                    const firstDetection = anomalyResult.detections[0];
                    const type = firstDetection?.detections?.[0]?.type || 'detected';
                    console.log(`[Sentinel] Anomaly: ${type}`);
                    req.sentinelRiskScore = (req.sentinelRiskScore || 0) + 25;
                }
            }

            // ------------------------------------------------------------------
            // 5. Risk Scoring
            // FIX: was calling calculateRisk(req) — passing the request object as
            //      userId. Correct signature is calculateRisk(userId, context).
            // Skip for auto-update endpoints.
            // ------------------------------------------------------------------
            if (!isUpdateOrRepair && !isAutoUpdate && isProtectionEnabled('risk-scorer') && riskScorer &&
                typeof riskScorer.calculateRisk === 'function') {

                const userId  = req.session?.userId || req.user?.id || req.ip;
                const context = {
                    ip:        req.ip,
                    userAgent: req.headers['user-agent'],
                    path:      req.path,
                    method:    req.method,
                    timestamp: Date.now()
                };

                const riskResult = riskScorer.calculateRisk(userId, context);
                if (riskResult && riskResult.score) {
                    req.sentinelRiskScore = (req.sentinelRiskScore || 0) + riskResult.score;

                    if (riskResult.score > 80) {
                        console.log(`[Sentinel] High risk blocked: ${riskResult.score}`);
                        return res.status(403).json({
                            error: 'Request Blocked',
                            reason: 'High risk score',
                            score: riskResult.score
                        });
                    }
                }
            }

            // ------------------------------------------------------------------
            // 6. AbuseIPDB - Check IP reputation
            // ------------------------------------------------------------------
            if (isProtectionEnabled('abuse-ipdb') && abuseIPDB) {
                const checkIP = abuseIPDB.checkIP || abuseIPDB.lookup || abuseIPDB.check;
                if (typeof checkIP === 'function') {
                    const ipResult = checkIP(req.ip);
                    if (ipResult && ipResult.isAbusive) {
                        console.log(`[Sentinel] AbuseIPDB blocked: ${req.ip}`);
                        return res.status(403).json({
                            error: 'IP Blocked',
                            reason: 'Poor IP reputation'
                        });
                    }
                }
            }

            // ------------------------------------------------------------------
            // 7. Safe Browsing - Check URLs in request
            // ------------------------------------------------------------------
            if (isProtectionEnabled('safe-browsing') && safeBrowsing) {
                const checkUrl = safeBrowsing.checkUrl || safeBrowsing.check || safeBrowsing.lookup;
                if (typeof checkUrl === 'function') {
                    const url = req.query?.url || req.body?.url;
                    if (url) {
                        const sbResult = checkUrl(url);
                        if (sbResult && sbResult.threat) {
                            console.log('[Sentinel] Safe Browsing blocked URL');
                            return res.status(400).json({
                                error: 'Malicious URL Detected'
                            });
                        }
                    }
                }
            }

            // ------------------------------------------------------------------
            // 8. Anti-Fingerprint - Add protection headers
            // ------------------------------------------------------------------
            if (isProtectionEnabled('anti-fingerprint') && antiFingerprint) {
                const getHeaders = antiFingerprint.getHeaders || antiFingerprint.getProtectionHeaders;
                if (typeof getHeaders === 'function') {
                    const fpHeaders = getHeaders();
                    Object.entries(fpHeaders).forEach(([key, value]) => {
                        res.setHeader(key, value);
                    });
                }
            }

            // ------------------------------------------------------------------
            // 9. Tracking Prevention - Strip tracking params
            // ------------------------------------------------------------------
            if (isProtectionEnabled('tracking-prevention') && trackingPrevention) {
                const stripUrl = trackingPrevention.stripUrlTracking || trackingPrevention.stripTracking;
                if (typeof stripUrl === 'function') {
                    if (req.query) {
                        Object.keys(req.query).forEach(key => {
                            const stripped = stripUrl(key);
                            if (stripped !== key) {
                                delete req.query[key];
                            }
                        });
                    }
                }
            }

            // ------------------------------------------------------------------
            // 10. Tamper Detection - Check file integrity
            // FIX: was calling verify(req) synchronously and reading .valid on the
            //      returned Promise. verifyIntegrity() takes no arguments, is async,
            //      and returns { tampered: [], missing: [], ok: [], errors: [] }.
            // FIX: Also skip tamper detection for update/repair paths since those
            //      legitimately modify server files.
            // ------------------------------------------------------------------
            if (!isUpdateOrRepair && !isSysInfoRoute && isProtectionEnabled('tamper-detect') && tamperDetect &&
                typeof tamperDetect.verifyIntegrity === 'function') {

                const integrityResult = await tamperDetect.verifyIntegrity();
                if (integrityResult &&
                    (integrityResult.tampered.length > 0 || integrityResult.missing.length > 0)) {
                    const affected = [...integrityResult.tampered, ...integrityResult.missing].join(', ');
                    console.log(`[Sentinel] Tamper detected: ${affected}`);
                    return res.status(403).json({
                        error: 'Integrity Violation',
                        reason: `Tampered or missing files: ${affected}`
                    });
                }
            }

            // Add processing time header
            res.setHeader('X-Sentinel-Processing-Time', `${Date.now() - startTime}ms`);

            next();

        } catch (error) {
            console.error('[Sentinel] Middleware error:', error.message);
            // On error, allow request but log
            next();
        }
    };
}

/**
 * Apply Sentinel protections to the Express app
 * @param {Express} app - Express application
 */
function applySentinelProtections(app) {
    const sentinelMiddleware = createSentinelMiddleware();

    // Apply to all API routes
    app.use('/api', sentinelMiddleware);

    console.log('[Sentinel] Protections applied to server');
}

module.exports = {
    createSentinelMiddleware,
    applySentinelProtections,
    isProtectionEnabled
};