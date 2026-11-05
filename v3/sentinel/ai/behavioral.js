/**
 * NovaSentinel Behavioral Anomaly Detection Module
 * 
 * This module uses TensorFlow.js autoencoder to detect anomalous user behaviour
 * based on a feature vector extracted from user activity patterns.
 * 
 * SECURITY REQUIREMENTS:
 * - Call auditService.logEvent() for high-confidence anomalies (>0.8 confidence)
 * - Use Map for storing per-user request history (rolling window of 1000)
 * - Model re-trains every 24 hours on normal behaviour baseline
 * - Track feature vector: [hour, dayOfWeek, requestRate, uniqueEndpoints, failedAuths, dataVolume, ipChanges]
 * 
 * @module sentinel/ai/behavioral
 */

'use strict';

// =============================================================================
// TRY TO LOAD DEPENDENCIES
// =============================================================================

let tf = null;
let tfjsLoaded = false;

try {
    tf = require('@tensorflow/tfjs-node');
    tfjsLoaded = true;
    console.log('[Behavioral] TensorFlow.js loaded successfully');
} catch (err) {
    console.warn('[Behavioral] TensorFlow.js not available, using statistical fallback');
    tf = null;
}

let auditService;
try {
    auditService = require('../../audit-service');
} catch (err) {
    console.error('[Behavioral] audit-service not available, using console logging');
    auditService = {
        logEvent: (event) => console.log('[Behavioral Audit]', JSON.stringify(event)),
        log: (event) => console.log('[Behavioral Audit]', JSON.stringify(event))
    };
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Feature vector indices */
const FEATURES = {
    HOUR: 0,
    DAY_OF_WEEK: 1,
    REQUEST_RATE: 2,
    UNIQUE_ENDPOINTS: 3,
    FAILED_AUTHS: 4,
    DATA_VOLUME: 5,
    IP_CHANGES: 6
};

/** Feature vector size */
const FEATURE_SIZE = 7;

/** Rolling window size per user */
const WINDOW_SIZE = 1000;

/** Anomaly threshold (reconstruction error above this = anomaly) */
const ANOMALY_THRESHOLD = 0.5;

/** High confidence threshold for logging */
const HIGH_CONFIDENCE_THRESHOLD = 0.8;

/** Retraining interval in milliseconds (24 hours) */
const RETRAIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

// =============================================================================
// STATE
// =============================================================================

/** Autoencoder model (null if using statistical fallback) */
let model = null;

/** Model training timestamp */
let lastTrainedAt = null;

/** Whether model is trained and ready */
let isModelReady = false;

/** Per-user request history (rolling window) */
const userRequestHistory = new Map();

/** Statistical baseline for fallback mode (mean and std per feature) */
let statisticalBaseline = null;

/** Timer for periodic retraining */
let retrainTimer = null;

/** Model healthy status */
let modelHealthy = true;

/** Training sample buffer */
let trainingBuffer = [];

/** Maximum training samples to keep */
const MAX_TRAINING_SAMPLES = 10000;

// =============================================================================
// AUTOENCODER ARCHITECTURE (TensorFlow.js)
// =============================================================================

/**
 * Create an autoencoder model for anomaly detection
 * Input: 7 features -> Compressed: 3 -> Reconstructed: 7
 */
function createAutoencoder() {
    if (!tf) return null;

    const input = tf.input({ shape: [FEATURE_SIZE] });
    
    // Encoder: compress to 3 dimensions
    const encoded = tf.layers.dense({ units: 3, activation: 'relu', name: 'encoder' }).apply(input);
    
    // Decoder: reconstruct 7 dimensions
    const decoded = tf.layers.dense({ units: FEATURE_SIZE, activation: 'linear', name: 'decoder' }).apply(encoded);
    
    const autoencoder = tf.model({ inputs: input, outputs: decoded });
    
    autoencoder.compile({
        optimizer: tf.train.adam(0.001),
        loss: 'meanSquaredError'
    });
    
    return autoencoder;
}

// =============================================================================
// FEATURE EXTRACTION
// =============================================================================

/**
 * Extract feature vector from a request/behavior
 * @param {Object} behavior - Behavior data with request info
 * @returns {number[]} - Feature vector [hour, dayOfWeek, requestRate, uniqueEndpoints, failedAuths, dataVolume, ipChanges]
 */
function extractFeatures(behavior = {}) {
    const now = behavior.timestamp ? new Date(behavior.timestamp) : new Date();
    
    // Extract basic features
    const hour = now.getHours() / 23.0; // Normalize to [0, 1]
    const dayOfWeek = now.getDay() / 6.0; // Normalize to [0, 1]
    const requestRate = Math.min(behavior.requestRate || 0, 100) / 100.0;
    const uniqueEndpoints = Math.min(behavior.uniqueEndpoints || 0, 50) / 50.0;
    const failedAuths = Math.min(behavior.failedAuths || 0, 20) / 20.0;
    const dataVolume = Math.min(behavior.dataVolume || 0, 10485760) / 10485760.0; // Normalize to 10MB
    const ipChanges = Math.min(behavior.ipChanges || 0, 10) / 10.0;
    
    return [hour, dayOfWeek, requestRate, uniqueEndpoints, failedAuths, dataVolume, ipChanges];
}

/**
 * Validate feature vector
 * @param {number[]} features - Feature vector to validate
 * @returns {boolean} - Whether features are valid
 */
function validateFeatures(features) {
    if (!Array.isArray(features) || features.length !== FEATURE_SIZE) {
        return false;
    }
    return features.every(f => typeof f === 'number' && !isNaN(f) && isFinite(f));
}

// =============================================================================
// STATISTICAL FALLBACK (when TensorFlow not available)
// =============================================================================

/**
 * Calculate statistical baseline from training data
 * @param {number[][]} data - Array of feature vectors
 */
function calculateStatisticalBaseline(data) {
    if (data.length < 2) {
        return null;
    }
    
    const means = new Array(FEATURE_SIZE).fill(0);
    const stds = new Array(FEATURE_SIZE).fill(0);
    
    // Calculate means
    for (const sample of data) {
        for (let i = 0; i < FEATURE_SIZE; i++) {
            means[i] += sample[i];
        }
    }
    for (let i = 0; i < FEATURE_SIZE; i++) {
        means[i] /= data.length;
    }
    
    // Calculate standard deviations
    for (const sample of data) {
        for (let i = 0; i < FEATURE_SIZE; i++) {
            const diff = sample[i] - means[i];
            stds[i] += diff * diff;
        }
    }
    for (let i = 0; i < FEATURE_SIZE; i++) {
        stds[i] = Math.sqrt(stds[i] / data.length) || 0.01; // Avoid division by zero
    }
    
    return { means, stds, sampleCount: data.length };
}

/**
 * Calculate reconstruction error using statistical method
 * @param {number[]} features - Feature vector
 * @param {Object} baseline - Statistical baseline
 * @returns {number} - Reconstruction error (0-1)
 */
function calculateStatisticalError(features, baseline) {
    if (!baseline) {
        return 0.5; // Default middle-ground error
    }
    
    let totalError = 0;
    for (let i = 0; i < FEATURE_SIZE; i++) {
        const zScore = Math.abs(features[i] - baseline.means[i]) / baseline.stds[i];
        totalError += Math.min(zScore / 3, 1); // Cap at 1 for z-scores > 3
    }
    
    return totalError / FEATURE_SIZE;
}

// =============================================================================
// MODEL TRAINING
// =============================================================================

/**
 * Train the autoencoder on historical normal behaviour data
 * @param {Array} historicalData - Array of behaviour objects or feature vectors
 * @returns {Promise<Object>} - Training result
 */
async function train(historicalData = []) {
    if (!historicalData || historicalData.length === 0) {
        return { success: false, error: 'No training data provided', samples: 0 };
    }
    
    try {
        // Extract features from data
        const features = historicalData.map(item => {
            if (Array.isArray(item)) return item;
            return extractFeatures(item);
        }).filter(validateFeatures);
        
        if (features.length < 10) {
            return { success: false, error: 'Insufficient valid training samples (minimum 10)', samples: features.length };
        }
        
        // Store in training buffer
        trainingBuffer = [...trainingBuffer, ...features].slice(-MAX_TRAINING_SAMPLES);
        
        if (tfjsLoaded && tf) {
            // Use TensorFlow.js autoencoder
            model = createAutoencoder();
            
            const xs = tf.tensor2d(trainingBuffer);
            
            await model.fit(xs, xs, {
                epochs: 50,
                batchSize: Math.min(32, Math.floor(features.length / 2)),
                shuffle: true,
                verbose: 0,
                validationSplit: 0.1
            });
            
            xs.dispose();
            
            isModelReady = true;
            modelHealthy = true;
            lastTrainedAt = new Date().toISOString();
            
            console.log(`[Behavioral] Model trained on ${trainingBuffer.length} samples`);
            
            return {
                success: true,
                samples: trainingBuffer.length,
                timestamp: lastTrainedAt,
                method: 'autoencoder'
            };
        } else {
            // Use statistical fallback
            statisticalBaseline = calculateStatisticalBaseline(trainingBuffer);
            isModelReady = true;
            modelHealthy = true;
            lastTrainedAt = new Date().toISOString();
            
            console.log(`[Behavioral] Statistical baseline trained on ${trainingBuffer.length} samples`);
            
            return {
                success: true,
                samples: trainingBuffer.length,
                timestamp: lastTrainedAt,
                method: 'statistical'
            };
        }
    } catch (error) {
        console.error('[Behavioral] Training error:', error.message);
        modelHealthy = false;
        
        return {
            success: false,
            error: error.message,
            samples: trainingBuffer.length
        };
    }
}

/**
 * Schedule periodic retraining (every 24 hours)
 */
function scheduleRetraining() {
    if (retrainTimer) {
        clearInterval(retrainTimer);
    }
    
    retrainTimer = setInterval(async () => {
        if (trainingBuffer.length >= 100) {
            console.log('[Behavioral] Starting scheduled retraining...');
            await train(trainingBuffer);
        }
    }, RETRAIN_INTERVAL_MS);
    
    console.log('[Behavioral] Scheduled retraining every 24 hours');
}

// =============================================================================
// ANOMALY SCORING
// =============================================================================

/**
 * Calculate reconstruction error (anomaly score) for a behaviour vector
 * @param {number[]|Object} behaviorVector - Feature vector or behaviour object
 * @returns {Promise<number>} - Reconstruction error (0-1, higher = more anomalous)
 */
async function score(behaviorVector) {
    let features;
    
    if (Array.isArray(behaviorVector)) {
        features = behaviorVector;
    } else {
        features = extractFeatures(behaviorVector);
    }
    
    if (!validateFeatures(features)) {
        console.warn('[Behavioral] Invalid features provided to score()');
        return 0.5;
    }
    
    if (!isModelReady) {
        console.warn('[Behavioral] Model not ready, returning default score');
        return 0.5;
    }
    
    try {
        if (tfjsLoaded && tf && model) {
            // Use TensorFlow.js model
            const input = tf.tensor2d([features]);
            const prediction = model.predict(input);
            const predArray = await prediction.data();
            
            // Calculate MSE between input and reconstruction
            let mse = 0;
            for (let i = 0; i < FEATURE_SIZE; i++) {
                const diff = features[i] - predArray[i];
                mse += diff * diff;
            }
            mse /= FEATURE_SIZE;
            
            // Normalize to 0-1 range (assuming max MSE around 0.5 for very different inputs)
            const error = Math.min(mse * 2, 1);
            
            input.dispose();
            prediction.dispose();
            
            return error;
        } else {
            // Use statistical fallback
            return calculateStatisticalError(features, statisticalBaseline);
        }
    } catch (error) {
        console.error('[Behavioral] Scoring error:', error.message);
        return 0.5;
    }
}

/**
 * Determine if behaviour is anomalous
 * @param {string} userId - User ID
 * @param {Object} currentBehavior - Current behaviour data
 * @returns {Promise<Object>} - { isAnomaly: boolean, confidence: number, score: number }
 */
async function isAnomaly(userId, currentBehavior = {}) {
    try {
        // Add to user's request history
        addToUserHistory(userId, currentBehavior);
        
        // Get feature vector
        const features = extractFeatures(currentBehavior);
        
        // Calculate anomaly score
        const anomalyScore = await score(features);
        
        // Determine if anomalous
        const isAnomaly = anomalyScore >= ANOMALY_THRESHOLD;
        
        // Calculate confidence (how far from threshold)
        const confidence = isAnomaly 
            ? Math.min((anomalyScore - ANOMALY_THRESHOLD) / (1 - ANOMALY_THRESHOLD) + 0.5, 1)
            : Math.max(1 - (ANOMALY_THRESHOLD - anomalyScore) / ANOMALY_THRESHOLD, 0);
        
        // Log high-confidence anomalies
        if (isAnomaly && confidence >= HIGH_CONFIDENCE_THRESHOLD) {
            const logFn = (auditService && typeof auditService.logEvent === 'function')
                ? auditService.logEvent.bind(auditService)
                : (auditService && typeof auditService.log === 'function')
                    ? auditService.log.bind(auditService)
                    : console.log;
            
            logFn({
                level: 'warning',
                action: 'BEHAVIORAL_ANOMALY_DETECTED',
                userId: userId,
                details: {
                    score: anomalyScore,
                    confidence: confidence,
                    features: {
                        hour: currentBehavior.timestamp ? new Date(currentBehavior.timestamp).getHours() : new Date().getHours(),
                        requestRate: currentBehavior.requestRate,
                        uniqueEndpoints: currentBehavior.uniqueEndpoints,
                        failedAuths: currentBehavior.failedAuths,
                        dataVolume: currentBehavior.dataVolume,
                        ipChanges: currentBehavior.ipChanges
                    },
                    timestamp: new Date().toISOString()
                },
                source: 'behavioral'
            });
        }
        
        return {
            isAnomaly,
            confidence,
            score: anomalyScore
        };
    } catch (error) {
        console.error('[Behavioral] isAnomaly error:', error.message);
        
        return {
            isAnomaly: false,
            confidence: 0,
            score: 0,
            error: error.message
        };
    }
}

// =============================================================================
// USER HISTORY MANAGEMENT
// =============================================================================

/**
 * Add behaviour to user's rolling history
 * @param {string} userId - User ID
 * @param {Object} behavior - Behaviour data
 */
function addToUserHistory(userId, behavior = {}) {
    if (!userId) return;
    
    let history = userRequestHistory.get(userId);
    
    if (!history) {
        history = [];
        userRequestHistory.set(userId, history);
    }
    
    // Add timestamp and behaviour data
    history.push({
        timestamp: behavior.timestamp || new Date().toISOString(),
        ...behavior
    });
    
    // Maintain rolling window of WINDOW_SIZE
    if (history.length > WINDOW_SIZE) {
        history.shift();
    }
}

/**
 * Get current behaviour profile for a user
 * @param {string} userId - User ID
 * @returns {Object} - User's current behaviour stats
 */
function getBehaviorProfile(userId) {
    const history = userRequestHistory.get(userId);
    
    if (!history || history.length === 0) {
        return {
            userId: userId,
            requestCount: 0,
            requestRate: 0,
            uniqueEndpoints: 0,
            failedAuths: 0,
            dataVolume: 0,
            ipChanges: 0,
            lastActivity: null,
            profileEstablished: false
        };
    }
    
    // Calculate aggregated stats
    const uniqueEndpointsSet = new Set();
    const uniqueIpsSet = new Set();
    let failedAuths = 0;
    let totalDataVolume = 0;
    
    // Use last 100 requests for rate calculation
    const recentHistory = history.slice(-100);
    const firstTimestamp = new Date(recentHistory[0].timestamp).getTime();
    const lastTimestamp = new Date(recentHistory[recentHistory.length - 1].timestamp).getTime();
    const timeWindowMs = lastTimestamp - firstTimestamp || 1;
    
    for (const entry of history) {
        if (entry.endpoint) uniqueEndpointsSet.add(entry.endpoint);
        if (entry.ip) uniqueIpsSet.add(entry.ip);
        if (entry.failedAuth) failedAuths += entry.failedAuth;
        if (entry.dataVolume) totalDataVolume += entry.dataVolume;
    }
    
    // Calculate request rate (requests per minute)
    const requestRate = (recentHistory.length / (timeWindowMs / 60000)) || 0;
    
    // Count IP changes
    let ipChanges = 0;
    let lastIp = null;
    for (const entry of history) {
        if (entry.ip && lastIp && entry.ip !== lastIp) {
            ipChanges++;
        }
        lastIp = entry.ip;
    }
    
    return {
        userId: userId,
        requestCount: history.length,
        requestRate: Math.round(requestRate * 100) / 100,
        uniqueEndpoints: uniqueEndpointsSet.size,
        failedAuths: failedAuths,
        dataVolume: totalDataVolume,
        ipChanges: ipChanges,
        lastActivity: history[history.length - 1].timestamp,
        profileEstablished: history.length >= 50
    };
}

/**
 * Get status of the behavioural detection system
 * @returns {Object} - Status object
 */
function getStatus() {
    return {
        active: true,
        healthy: modelHealthy,
        details: {
            tfjsLoaded: tfjsLoaded,
            modelReady: isModelReady,
            lastTrained: lastTrainedAt,
            trainingSamples: trainingBuffer.length,
            trackedUsers: userRequestHistory.size,
            method: tfjsLoaded && model ? 'autoencoder' : 'statistical',
            retrainingScheduled: retrainTimer !== null
        }
    };
}

// =============================================================================
// INITIALISATION
// =============================================================================

// Start scheduled retraining
scheduleRetraining();

// Log initial status
console.log('[Behavioral] Module initialized, method:', tfjsLoaded ? 'autoencoder' : 'statistical');

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    train,
    score,
    isAnomaly,
    getBehaviorProfile,
    getStatus,
    // Expose for testing
    extractFeatures,
    addToUserHistory,
    FEATURE_SIZE,
    ANOMALY_THRESHOLD,
    WINDOW_SIZE
};
