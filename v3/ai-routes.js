/**
 * AI Routes - API endpoints for AI Copilot features
 */

const express = require('express');
const router = express.Router();
const aiService = require('./ai-service');
const authService = require('./auth-service');

// Middleware to require authentication
async function requireAuth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.sessionToken;
    
    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    
    const session = await authService.Session.validate(token);
    if (!session || !session.valid) {
        return res.status(401).json({ error: 'Invalid or expired session' });
    }
    
    req.userId = session.userId;
    next();
}

/**
 * POST /api/ai/suggest-reply
 * Generate reply suggestions for an email
 */
router.post('/suggest-reply', requireAuth, async (req, res) => {
    try {
        const { subject, from, body, thread } = req.body;

        if (!body && !subject) {
            return res.status(400).json({ error: 'Email content is required' });
        }

        const result = await aiService.suggestReply(req.userId, {
            subject: subject || '',
            from: from || '',
            body: body || '',
            thread: thread || []
        });

        res.json(result);
    } catch (error) {
        console.error('[AI Routes] Suggest reply error:', error);
        
        if (error.message.includes('Rate limit')) {
            return res.status(429).json({ error: error.message });
        }
        
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/ai/summarize
 * Summarize an email thread
 */
router.post('/summarize', requireAuth, async (req, res) => {
    try {
        const { subject, thread } = req.body;

        if (!thread || !Array.isArray(thread) || thread.length === 0) {
            return res.status(400).json({ error: 'Email thread is required' });
        }

        const result = await aiService.summarizeThread(req.userId, {
            subject: subject || 'No Subject',
            thread
        });

        res.json(result);
    } catch (error) {
        console.error('[AI Routes] Summarize error:', error);
        
        if (error.message.includes('Rate limit')) {
            return res.status(429).json({ error: error.message });
        }
        
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/ai/analyze
 * Analyze email for sentiment and urgency
 */
router.post('/analyze', requireAuth, async (req, res) => {
    try {
        const { subject, from, body } = req.body;

        if (!body && !subject) {
            return res.status(400).json({ error: 'Email content is required' });
        }

        const result = await aiService.analyzeEmail(req.userId, {
            subject: subject || '',
            from: from || '',
            body: body || ''
        });

        res.json(result);
    } catch (error) {
        console.error('[AI Routes] Analyze error:', error);
        
        if (error.message.includes('Rate limit')) {
            return res.status(429).json({ error: error.message });
        }
        
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/ai/settings
 * Get AI settings for current user
 */
router.get('/settings', requireAuth, (req, res) => {
    try {
        const settings = aiService.getSettings(req.userId);
        res.json(settings);
    } catch (error) {
        console.error('[AI Routes] Get settings error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/ai/settings
 * Update AI settings for current user
 */
router.put('/settings', requireAuth, async (req, res) => {
    try {
        const { provider, model, temperature, maxTokens, enabled, apiKey } = req.body;

        // Validate settings
        if (provider && !['anthropic', 'openai', 'google'].includes(provider)) {
            return res.status(400).json({ error: 'Invalid provider. Must be: anthropic, openai, or google' });
        }

        if (temperature !== undefined && (temperature < 0 || temperature > 1)) {
            return res.status(400).json({ error: 'Temperature must be between 0 and 1' });
        }

        if (maxTokens !== undefined && (maxTokens < 1 || maxTokens > 10000)) {
            return res.status(400).json({ error: 'Max tokens must be between 1 and 10000' });
        }

        const updatedSettings = aiService.updateSettings(req.userId, {
            provider,
            model,
            temperature,
            maxTokens,
            enabled,
            apiKey
        });

        res.json({
            success: true,
            settings: updatedSettings
        });
    } catch (error) {
        console.error('[AI Routes] Update settings error:', error);
        res.status(400).json({ error: error.message });
    }
});

/**
 * DELETE /api/ai/cache
 * Clear AI cache for current user
 */
router.delete('/cache', requireAuth, (req, res) => {
    try {
        aiService.clearCache(req.userId);
        res.json({ success: true, message: 'Cache cleared' });
    } catch (error) {
        console.error('[AI Routes] Clear cache error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/ai/status
 * Get AI service status
 */
router.get('/status', requireAuth, (req, res) => {
    try {
        const status = aiService.getStatus();
        res.json(status);
    } catch (error) {
        console.error('[AI Routes] Status error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/ai/compose
 * Generate email content using AI (proxies to Anthropic via backend to avoid CORS)
 */
router.post('/compose', requireAuth, async (req, res) => {
    try {
        const { systemPrompt, userContent, tone, length, apiKey } = req.body;

        if (!userContent) {
            return res.status(400).json({ error: 'User content is required' });
        }

        const result = await aiService.composeEmail(req.userId, {
            systemPrompt: systemPrompt || 'You are an expert email writer.',
            userContent,
            tone,
            length,
            apiKey // Pass the API key from frontend
        });

        res.json(result);
    } catch (error) {
        console.error('[AI Routes] Compose error:', error);
        
        if (error.message.includes('Rate limit')) {
            return res.status(429).json({ error: error.message });
        }
        
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
