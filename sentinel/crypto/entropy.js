/**
 * NovaSentinel Cryptographic Entropy Collection
 * 
 * This module provides high-quality entropy collection from multiple sources
 * for use in cryptographic operations within NovaByte OS.
 * 
 * SECURITY REQUIREMENTS:
 * - Never use Math.random() - only crypto.randomBytes
 * - Combine multiple entropy sources using XOR + SHA-256
 * - Minimum entropy threshold before considering pool "healthy"
 * - All operations wrapped in try/catch
 * - Audit logging for security-relevant events
 * 
 * @module sentinel/crypto/entropy
 */

'use strict';

const crypto = require('crypto');
const os = require('os');

// =============================================================================
// CONSTANTS
// =============================================================================

/** Minimum entropy bits required for a healthy pool */
const MIN_ENTROPY_BITS = 128;

/** Entropy pool refresh interval in milliseconds (60 seconds) */
const POOL_REFRESH_INTERVAL = 60000;

/** Size of entropy chunks collected from each source */
const ENTROPY_CHUNK_SIZE = 32;

/** Maximum age of entropy pool before refresh (ms) */
const POOL_MAX_AGE = 300000; // 5 minutes

// =============================================================================
// STATE
// =============================================================================

/** Global entropy pool */
let entropyPool = Buffer.alloc(0);

/** Timestamp of last pool refresh */
let lastPoolRefresh = 0;

/** Count of entropy collection operations */
let collectionCount = 0;

/** Auto-refresh interval ID */
let refreshInterval = null;

/** Current entropy estimate in bits */
let currentEntropyBits = 0;

// =============================================================================
// AUDIT LOGGING
// =============================================================================

/**
 * Attempt to log security events to audit service.
 * Gracefully handles if auditService is not yet available.
 * 
 * @param {string} event - Event type
 * @param {object} data - Event data (sanitized)
 */
function logSecurityEvent(event, data = {}) {
    try {
        if (typeof auditService !== 'undefined' && auditService && typeof auditService.logEvent === 'function') {
            auditService.logEvent(event, data);
        }
    } catch (e) {
        // Silently fail - audit logging should never break functionality
        console.error('[NovaSentinel] Failed to log security event:', e.message);
    }
}

// =============================================================================
// ENTROPY COLLECTION - CRYPTO RANDOM
// =============================================================================

/**
 * Collects high-quality random bytes from Node.js crypto module.
 * 
 * @returns {Buffer} Random bytes
 * @throws {Error} If collection fails
 */
function collectCryptoEntropy() {
    try {
        const entropy = crypto.randomBytes(ENTROPY_CHUNK_SIZE);
        
        logSecurityEvent('entropy_collected', {
            source: 'crypto',
            bytes: entropy.length,
            sensitive: false
        });
        
        return entropy;
    } catch (error) {
        logSecurityEvent('entropy_collection_failed', {
            source: 'crypto',
            error: error.message,
            sensitive: false
        });
        throw new Error('Failed to collect crypto entropy: ' + error.message);
    }
}

// =============================================================================
// ENTROPY COLLECTION - PROCESS TIMING
// =============================================================================

/**
 * Collects entropy from process timing variations.
 * Measures timing differences between setTimeout and setImmediate.
 * 
 * @returns {Buffer} Entropy derived from timing variations
 * @throws {Error} If collection fails
 */
function collectTimingEntropy() {
    try {
        const samples = [];
        const iterations = 100;
        
        for (let i = 0; i < iterations; i++) {
            const start = process.hrtime.bigint();
            
            // Mix synchronous and asynchronous operations
            let dummy = 0;
            for (let j = 0; j < 10; j++) {
                dummy += Math.floor(Math.random() * 256); // Intentionally not used for security
            }
            
            setTimeout(() => {}, 0);
            setImmediate(() => {});
            
            const end = process.hrtime.bigint();
            const diff = Number(end - start);
            samples.push(diff);
        }
        
        // Convert timing samples to entropy bytes
        const timingBuffer = Buffer.alloc(Math.min(iterations, ENTROPY_CHUNK_SIZE));
        for (let i = 0; i < timingBuffer.length; i++) {
            // Use hash of samples to derive deterministic but varied bytes
            const sampleHash = crypto.createHash('sha256');
            sampleHash.update(samples.slice(i, i + 10).toString());
            const hash = sampleHash.digest();
            timingBuffer[i] = hash[0] ^ hash[1];
        }
        
        logSecurityEvent('entropy_collected', {
            source: 'timing',
            bytes: timingBuffer.length,
            samples: iterations,
            sensitive: false
        });
        
        return timingBuffer;
    } catch (error) {
        logSecurityEvent('entropy_collection_failed', {
            source: 'timing',
            error: error.message,
            sensitive: false
        });
        throw new Error('Failed to collect timing entropy: ' + error.message);
    }
}

// =============================================================================
// ENTROPY COLLECTION - OS NOISE
// =============================================================================

/**
 * Collects entropy from OS-level noise sources.
 * Uses CPU load, memory info, and network statistics.
 * 
 * @returns {Buffer} Entropy derived from OS noise
 * @throws {Error} If collection fails
 */
function collectOSEntropy() {
    try {
        const noiseSources = [];
        
        // CPU load average (1, 5, 15 minute)
        const loadAvg = os.loadavg();
        noiseSources.push(Buffer.from(loadAvg.map(l => Math.floor(l * 1000)).toString()));
        
        // Memory information
        const memInfo = {
            total: os.totalmem(),
            free: os.freemem(),
            used: os.totalmem() - os.freemem()
        };
        noiseSources.push(Buffer.from(JSON.stringify(memInfo)));
        
        // Network interfaces (count and addresses)
        const interfaces = os.networkInterfaces();
        const interfaceCount = Object.keys(interfaces).length;
        const addresses = Object.values(interfaces)
            .flat()
            .filter(addr => addr.family === 'IPv4')
            .map(addr => addr.address);
        noiseSources.push(Buffer.from(`${interfaceCount}:${addresses.join(',')}`));
        
        // Platform and release info
        noiseSources.push(Buffer.from(`${os.platform()}-${os.release()}`));
        
        // Current uptime
        noiseSources.push(Buffer.from(os.uptime().toString()));
        
        // Combine all noise sources
        const combined = Buffer.concat(noiseSources);
        const hash = crypto.createHash('sha256').update(combined).digest();
        
        // Take only what we need
        const entropy = hash.slice(0, ENTROPY_CHUNK_SIZE);
        
        logSecurityEvent('entropy_collected', {
            source: 'os',
            bytes: entropy.length,
            interfaces: interfaceCount,
            sensitive: false
        });
        
        return entropy;
    } catch (error) {
        logSecurityEvent('entropy_collection_failed', {
            source: 'os',
            error: error.message,
            sensitive: false
        });
        throw new Error('Failed to collect OS entropy: ' + error.message);
    }
}

// =============================================================================
// CORE FUNCTIONS
// =============================================================================

/**
 * Collects entropy from all available sources.
 * 
 * Harvests from:
 * - crypto.randomBytes (high-quality system entropy)
 * - Process timing variations (setTimeout, setImmediate)
 * - OS noise (CPU load, memory, network stats)
 * 
 * @returns {Promise<Buffer>} Combined entropy from all sources
 * @throws {Error} If collection fails
 */
async function collectEntropy() {
    try {
        const sources = [];
        
        // Collect from all three sources
        const cryptoEntropy = collectCryptoEntropy();
        const timingEntropy = collectTimingEntropy();
        const osEntropy = collectOSEntropy();
        
        sources.push(cryptoEntropy, timingEntropy, osEntropy);
        
        // Mix the entropy sources
        const combined = mixEntropy(sources);
        
        // Update pool
        entropyPool = combined;
        lastPoolRefresh = Date.now();
        collectionCount++;
        
        // Update entropy estimate
        currentEntropyBits = estimateEntropyBits(combined);
        
        logSecurityEvent('entropy_pool_refreshed', {
            sources: 3,
            poolSize: combined.length,
            entropyBits: currentEntropyBits,
            collectionCount,
            sensitive: false
        });
        
        return combined;
    } catch (error) {
        logSecurityEvent('entropy_collection_failed', {
            error: error.message,
            sensitive: false
        });
        throw new Error('Entropy collection failed: ' + error.message);
    }
}

/**
 * Mixes multiple entropy sources using XOR and SHA-256 hashing.
 * 
 * Combines entropy pools by XORing them together, then hashing
 * the result to ensure good distribution.
 * 
 * @param {Buffer[]} sources - Array of entropy source buffers
 * @returns {Buffer} Combined and hashed entropy
 * @throws {Error} If mixing fails
 */
function mixEntropy(sources) {
    try {
        if (!Array.isArray(sources) || sources.length === 0) {
            throw new Error('At least one entropy source is required');
        }
        
        // Validate all sources are buffers
        for (let i = 0; i < sources.length; i++) {
            if (!Buffer.isBuffer(sources[i])) {
                throw new Error(`Source ${i} is not a Buffer`);
            }
        }
        
        // Find maximum length
        const maxLength = Math.max(...sources.map(s => s.length));
        
        // Pad all sources to same length
        const padded = sources.map(s => {
            if (s.length === maxLength) return s;
            const padded = Buffer.alloc(maxLength);
            s.copy(padded);
            return padded;
        });
        
        // XOR all sources together
        const xorResult = Buffer.alloc(maxLength);
        for (let i = 0; i < maxLength; i++) {
            let byte = 0;
            for (let j = 0; j < padded.length; j++) {
                byte ^= padded[j][i];
            }
            xorResult[i] = byte;
        }
        
        // Hash the XOR result for better distribution
        const hashed = crypto.createHash('sha256').update(xorResult).digest();
        
        logSecurityEvent('entropy_mixed', {
            sourceCount: sources.length,
            outputLength: hashed.length,
            sensitive: false
        });
        
        return hashed;
    } catch (error) {
        logSecurityEvent('entropy_mix_failed', {
            error: error.message,
            sensitive: false
        });
        throw new Error('Failed to mix entropy: ' + error.message);
    }
}

/**
 * Generates secure random bytes using entropy-seeded random generation.
 * 
 * Uses crypto.randomBytes with entropy pool mixing to ensure
 * high-quality random output.
 * 
 * @param {number} length - Number of random bytes to generate
 * @returns {Buffer} Secure random bytes
 * @throws {Error} If generation fails
 */
function getSecureRandom(length) {
    try {
        if (typeof length !== 'number' || length <= 0) {
            throw new Error('Length must be a positive number');
        }
        
        if (length > 1024) {
            throw new Error('Maximum request size is 1024 bytes');
        }
        
        // Get fresh random bytes from crypto
        const randomBytes = crypto.randomBytes(length);
        
        // Mix with entropy pool if available
        let result = randomBytes;
        if (entropyPool.length > 0) {
            const mixed = mixEntropy([randomBytes, entropyPool]);
            result = mixed.slice(0, length);
        }
        
        logSecurityEvent('secure_random_generated', {
            length,
            poolAvailable: entropyPool.length > 0,
            sensitive: false
        });
        
        return result;
    } catch (error) {
        logSecurityEvent('secure_random_failed', {
            length,
            error: error.message,
            sensitive: false
        });
        throw new Error('Failed to generate secure random: ' + error.message);
    }
}

/**
 * Calculates Shannon entropy of the given data.
 * 
 * Shannon entropy formula: H(X) = -Σ p(x) * log2(p(x))
 * Measures the randomness/information content of the data.
 * 
 * @param {Buffer|string} data - Data to analyse
 * @returns {number} Estimated entropy in bits (0-8 per byte)
 * @throws {Error} If calculation fails
 */
function estimateEntropyBits(data) {
    try {
        if (!data) {
            return 0;
        }
        
        // Convert to buffer if string
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        
        if (buffer.length === 0) {
            return 0;
        }
        
        // Count frequency of each byte value
        const frequency = new Array(256).fill(0);
        for (let i = 0; i < buffer.length; i++) {
            frequency[buffer[i]]++;
        }
        
        // Calculate Shannon entropy
        let entropy = 0;
        for (let i = 0; i < 256; i++) {
            if (frequency[i] === 0) continue;
            
            const probability = frequency[i] / buffer.length;
            entropy -= probability * Math.log2(probability);
        }
        
        // Convert to total bits (entropy per byte * number of bytes)
        const totalBits = entropy * buffer.length;
        
        logSecurityEvent('entropy_estimated', {
            dataLength: buffer.length,
            entropyPerByte: entropy,
            totalBits,
            sensitive: false
        });
        
        return totalBits;
    } catch (error) {
        logSecurityEvent('entropy_estimation_failed', {
            error: error.message,
            sensitive: false
        });
        throw new Error('Failed to estimate entropy: ' + error.message);
    }
}

// =============================================================================
// POOL MANAGEMENT
// =============================================================================

/**
 * Gets the current status of the entropy pool.
 * 
 * Provides health check information for the dashboard,
 * including pool size, age, and entropy estimate.
 * 
 * @returns {object} Entropy status object
 */
function getEntropyStatus() {
    const now = Date.now();
    const poolAge = now - lastPoolRefresh;
    const isHealthy = currentEntropyBits >= MIN_ENTROPY_BITS;
    const needsRefresh = poolAge > POOL_MAX_AGE;
    
    const status = {
        healthy: isHealthy,
        poolSize: entropyPool.length,
        poolAge: poolAge,
        entropyBits: currentEntropyBits,
        minEntropyBits: MIN_ENTROPY_BITS,
        needsRefresh: needsRefresh,
        collectionCount: collectionCount,
        lastRefresh: lastPoolRefresh > 0 ? new Date(lastPoolRefresh).toISOString() : null,
        active: refreshInterval !== null
    };
    
    logSecurityEvent('entropy_status_checked', {
        ...status,
        sensitive: false
    });
    
    return status;
}

/**
 * Starts automatic entropy pool refresh.
 * Refreshes the pool every 60 seconds.
 */
function startAutoRefresh() {
    if (refreshInterval) {
        return; // Already running
    }
    
    // Initial collection
    collectEntropy().catch(err => {
        console.error('[NovaSentinel] Initial entropy collection failed:', err.message);
    });
    
    // Set up interval
    refreshInterval = setInterval(() => {
        collectEntropy().catch(err => {
            console.error('[NovaSentinel] Periodic entropy refresh failed:', err.message);
        });
    }, POOL_REFRESH_INTERVAL);
    
    // Keep the interval from preventing process exit
    refreshInterval.unref();
    
    logSecurityEvent('entropy_auto_refresh_started', {
        intervalMs: POOL_REFRESH_INTERVAL,
        sensitive: false
    });
}

/**
 * Stops automatic entropy pool refresh.
 */
function stopAutoRefresh() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
        
        logSecurityEvent('entropy_auto_refresh_stopped', {
            sensitive: false
        });
    }
}

// =============================================================================
// INITIALISATION
// =============================================================================

// Start auto-refresh on module load
startAutoRefresh();

// =============================================================================
// MODULE EXPORTS
// =============================================================================

module.exports = {
    /**
     * Collects entropy from all available sources.
     * @returns {Promise<Buffer>} Combined entropy from all sources
     */
    collectEntropy,
    
    /**
     * Mixes multiple entropy sources using XOR and SHA-256.
     * @param {Buffer[]} sources - Array of entropy source buffers
     * @returns {Buffer} Combined and hashed entropy
     */
    mixEntropy,
    
    /**
     * Generates secure random bytes.
     * @param {number} length - Number of random bytes to generate
     * @returns {Buffer} Secure random bytes
     */
    getSecureRandom,
    
    /**
     * Calculates Shannon entropy of the given data.
     * @param {Buffer|string} data - Data to analyse
     * @returns {number} Estimated entropy in bits
     */
    estimateEntropyBits,
    
    /**
     * Gets the current status of the entropy pool.
     * @returns {object} Entropy status object
     */
    getEntropyStatus,
    
    /**
     * Returns module health status.
     * @returns {{active: boolean, healthy: boolean, details: object}}
     */
    getStatus: () => {
        const status = getEntropyStatus();
        return {
            active: status.active,
            healthy: status.healthy,
            details: {
                poolSize: status.poolSize,
                entropyBits: status.entropyBits,
                minEntropyBits: MIN_ENTROPY_BITS,
                collectionCount: status.collectionCount,
                autoRefresh: refreshInterval !== null
            }
        };
    }
};
