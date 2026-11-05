/**
 * AI Service - AI Copilot Integration
 * Provides AI-powered email assistance using Anthropic API (or configurable provider)
 */

const crypto = require('crypto');

// In-memory cache for AI requests (production would use Redis)
const requestCache = new Map();
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// Rate limiting storage (production would use Redis)
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 10; // 10 requests per minute

// List of free models to try in order when rate limited
const freeModels = [
    'meta-llama/llama-3.3-70b-instruct:free',
    'google/gemma-2-9b-it:free',
    'deepseek/deepseek-chat:free',
    'mistralai/mistral-7b-instruct:free',
    'qwen/qwen-2-7b-instruct:free'
];

// NVIDIA API configuration
const nvidiaConfig = {
    apiKey: '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',
    invokeUrl: 'https://integrate.api.nvidia.com/v1/chat/completions',
    model: 'moonshotai/kimi-k2.5'
};

// OpenRouter fallback configuration
const openRouterConfig = {
    apiKey: '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',
    model: 'meta-llama/llama-3.3-70b-instruct:free'
};

// Default AI settings
const defaultSettings = {
    provider: 'nvidia', // nvidia, openrouter, anthropic, openai, google
    model: nvidiaConfig.model,
    apiKey: nvidiaConfig.apiKey,
    temperature: 1.0,
    maxTokens: 4096,
    enabled: true
};

// User-specific AI settings storage (production would use database)
const userSettings = new Map();

/**
 * Generate cache key for request
 */
function generateCacheKey(data) {
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify(data));
    return hash.digest('hex');
}

/**
 * Get cached response if available and not expired
 */
function getCachedResponse(key) {
    const cached = requestCache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.response;
    }
    requestCache.delete(key);
    return null;
}

/**
 * Store response in cache
 */
function setCachedResponse(key, response, userId) {
    requestCache.set(key, {
        response,
        userId: userId || null,
        timestamp: Date.now()
    });

    // Clean old cache entries periodically
    if (requestCache.size > 1000) {
        const now = Date.now();
        for (const [k, v] of requestCache.entries()) {
            if (now - v.timestamp > CACHE_TTL) {
                requestCache.delete(k);
            }
        }
    }
}

/**
 * Check rate limit for user
 */
function checkRateLimit(userId) {
    const now = Date.now();
    const userLimits = rateLimitStore.get(userId) || { requests: [], blocked: false };

    // Check if blocked
    if (userLimits.blocked) {
        const blockExpiry = userLimits.blockedUntil || 0;
        if (now < blockExpiry) {
            return { allowed: false, retryAfter: Math.ceil((blockExpiry - now) / 1000) };
        } else {
            // Unblock
            userLimits.blocked = false;
            userLimits.blockedUntil = 0;
        }
    }

    // Clean old requests
    userLimits.requests = userLimits.requests.filter(time => now - time < RATE_LIMIT_WINDOW);

    // Check limit
    if (userLimits.requests.length >= RATE_LIMIT_MAX_REQUESTS) {
        userLimits.blocked = true;
        userLimits.blockedUntil = now + RATE_LIMIT_WINDOW;
        rateLimitStore.set(userId, userLimits);
        return { allowed: false, retryAfter: Math.ceil(RATE_LIMIT_WINDOW / 1000) };
    }

    // Add current request
    userLimits.requests.push(now);
    rateLimitStore.set(userId, userLimits);
    return { allowed: true };
}

/**
 * Call AI provider API
 */
async function callAIProvider(prompt, settings, options = {}) {
    const { provider, model, temperature, maxTokens } = { ...settings, ...options };

    // Use API key from settings or defaultSettings
    const apiKey = settings.apiKey || defaultSettings.apiKey;
    if (!apiKey) {
        throw new Error('AI API key not configured');
    }

    const requestOptions = {
        model: options.model || model || defaultSettings.model,
        temperature: options.temperature ?? temperature ?? defaultSettings.temperature,
        max_tokens: options.maxTokens || maxTokens || defaultSettings.maxTokens,
        messages: Array.isArray(prompt) ? prompt : [{ role: 'user', content: prompt }]
    };

    if (provider === 'openrouter') {
        return callOpenRouter(openRouterConfig.apiKey, {
                ...requestOptions,
                model: openRouterConfig.model
            });
    } else if (provider === 'anthropic') {
        return callAnthropic(apiKey, requestOptions);
    } else if (provider === 'openai') {
        return callOpenAI(apiKey, requestOptions);
    } else if (provider === 'google') {
        return callGoogleAI(apiKey, requestOptions);
    } else if (provider === 'nvidia') {
        try {
            return await callNVIDIA(apiKey, requestOptions);
        } catch (nvidiaError) {
            console.log('[AI Service] NVIDIA failed, trying OpenRouter:', nvidiaError.message);
            // Fallback to OpenRouter if NVIDIA fails
            return callOpenRouter(openRouterConfig.apiKey, {
                ...requestOptions,
                model: openRouterConfig.model
            });
        }
    } else {
        // Default to NVIDIA
        return callNVIDIA(apiKey, requestOptions);
    }
}

/**
 * Call OpenRouter API (default)
 */
async function callOpenRouter(apiKey, options, modelIndex = 0) {
    const model = options.model || freeModels[modelIndex] || freeModels[0];
    
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://novabyte.os',
            'X-Title': 'NovaByte OS'
        },
        body: JSON.stringify({
            model: model,
            messages: options.messages,
            temperature: options.temperature || 0.7,
            max_tokens: options.max_tokens || 1024
        })
    });

    // If rate limited and we have more models to try
    if (response.status === 429 && modelIndex < freeModels.length - 1) {
        console.log(`[AI Service] Rate limited on ${model}, trying next model...`);
        return callOpenRouter(apiKey, options, modelIndex + 1);
    }

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenRouter API error: ${error}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

/**
 * Call Anthropic API
 */
async function callAnthropic(apiKey, options) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            model: options.model,
            messages: options.messages,
            temperature: options.temperature,
            max_tokens: options.max_tokens
        })
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Anthropic API error: ${error}`);
    }

    const data = await response.json();
    return data.content[0].text;
}

/**
 * Call OpenAI API
 */
async function callOpenAI(apiKey, options) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: options.model || 'gpt-4',
            messages: options.messages,
            temperature: options.temperature,
            max_tokens: options.max_tokens
        })
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenAI API error: ${error}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

/**
 * Call Google AI API
 */
async function callGoogleAI(apiKey, options) {
    const modelMap = {
        'gemini-pro': 'gemini-1.5-pro'
    };
    const model = modelMap[options.model] || options.model;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            contents: options.messages.map(m => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }]
            })),
            generationConfig: {
                temperature: options.temperature,
                maxOutputTokens: options.max_tokens
            }
        })
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Google AI API error: ${error}`);
    }

    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
}

/**
 * Call NVIDIA API (Kimi K2.5)
 */
async function callNVIDIA(apiKey, options) {
    const invokeUrl = nvidiaConfig.invokeUrl || 'https://integrate.api.nvidia.com/v1/chat/completions';
    const model = options.model || nvidiaConfig.model || 'moonshotai/kimi-k2.5';
    
    // Add timeout to fetch
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
    
    try {
        const response = await fetch(invokeUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: model,
                messages: options.messages,
                max_tokens: options.max_tokens || 4096,
                temperature: options.temperature || 1.0,
                top_p: options.top_p || 1.0,
                stream: false
            }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[NVIDIA API] Error response:', response.status, errorText);
            throw new Error(`NVIDIA API error (${response.status}): ${errorText}`);
        }

        const data = await response.json();
        if (!data.choices || !data.choices[0]) {
            console.error('[NVIDIA API] Invalid response:', data);
            throw new Error('NVIDIA API returned invalid response');
        }
        return data.choices[0].message.content;
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error('NVIDIA API request timed out after 30 seconds');
        }
        throw error;
    }
}

/**
 * Generate reply suggestions for an email
 */
async function suggestReply(userId, emailData) {
    // Check rate limit
    const rateCheck = checkRateLimit(userId);
    if (!rateCheck.allowed) {
        throw new Error(`Rate limit exceeded. Retry after ${rateCheck.retryAfter} seconds.`);
    }

    // Check cache
    const cacheKey = generateCacheKey({ type: 'suggest-reply', ...emailData });
    const cached = getCachedResponse(cacheKey);
    if (cached) {
        return cached;
    }

    // Get settings - use apiKey from emailData if provided
    let settings = { ...defaultSettings };
    if (emailData.apiKey) {
        settings.apiKey = emailData.apiKey;
        settings.enabled = true;
    } else {
        settings = userSettings.get(userId) || defaultSettings;
    }
    
    if (!settings.enabled) {
        throw new Error('AI features are disabled');
    }

    const { subject, from, body, bodyText, bodyHtml, thread } = emailData;

    let context = '';
    if (thread && thread.length > 0) {
        context = '\n\nEmail thread:\n' + thread.map(m =>
            `From: ${m.from}\nDate: ${m.date}\n${m.bodyText || m.body || m.bodyHtml || m.text || m.snippet || ''}`
        ).join('\n---\n');
    }

    const prompt = [
        { role: 'system', content: `You are an AI email assistant. Generate 3 concise, professional reply suggestions for the following email. 
IMPORTANT: Return ONLY plain text suggestions, one per line, with NO formatting, NO markdown, NO bold text, NO asterisks, NO numbering.
Format each suggestion as just the reply text itself, nothing else.
Keep each suggestion brief (1-2 sentences).` },
        { role: 'user', content: `Subject: ${subject}\nFrom: ${from}\n\nEmail:\n${bodyText || body || bodyHtml || body || '(No content)'}${context}` }
    ];

    try {
        const response = await callAIProvider(prompt, settings);
        // Split by newlines and clean up
        let suggestions = response.split(/\n/)
            .map(s => s.replace(/^(?:Suggestion \d+:|\d+\.?|Option \d+:)\s*/i, '').trim())
            .filter(s => s.length > 5);
        
        // If parsing failed, fallback to trying other patterns
        if (suggestions.length < 2) {
            suggestions = response.split(/(?:^|\n)(?:Suggestion \d+:|\d+\.|Option \d+:)/i)
                .map(s => s.trim())
                .filter(s => s.length > 5);
        }

        const result = {
            suggestions: suggestions.length > 0 ? suggestions : [response],
            model: settings.model,
            provider: settings.provider
        };

        setCachedResponse(cacheKey, result, userId);
        return {
            suggestions: [
                'Thank you for your email. I will review and respond shortly.',
                'Thanks for reaching out. Let me get back to you on this.',
                'Received. I will follow up with more details soon.'
            ],
            model: settings.model,
            provider: settings.provider
        };
    } catch (error) {
        console.error('Error generating reply suggestions:', error);
        return {
            suggestions: [
                'Thank you for your email. I will review and respond shortly.',
                'Thanks for reaching out. Let me get back to you on this.',
                'Received. I will follow up with more details soon.'
            ],
            error: error.message,
            fallback: true
        };
    }
}

/**
 * Summarize an email thread
 */
async function summarizeThread(userId, emailData) {
    const rateCheck = checkRateLimit(userId);
    if (!rateCheck.allowed) {
        throw new Error(`Rate limit exceeded. Retry after ${rateCheck.retryAfter} seconds.`);
    }

    const cacheKey = generateCacheKey({ type: 'summarize', ...emailData });
    const cached = getCachedResponse(cacheKey);
    if (cached) {
        return cached;
    }

    // Get settings - use apiKey from emailData if provided
    let settings = { ...defaultSettings };
    if (emailData.apiKey) {
        settings.apiKey = emailData.apiKey;
        settings.enabled = true;
    } else {
        settings = userSettings.get(userId) || defaultSettings;
    }
    
    if (!settings.enabled) {
        throw new Error('AI features are disabled');
    }

    const { subject, thread } = emailData;

    if (!thread || thread.length === 0) {
        throw new Error('No thread provided for summarization');
    }

    const threadContent = thread.map((email, i) =>
        `Email ${i + 1}:\nFrom: ${email.from}\nDate: ${email.date}\nSubject: ${email.subject || subject}\n\n${email.bodyText || email.body || email.bodyHtml || email.text || email.snippet || '(No content available)'}`
    ).join('\n\n---\n\n');

    const prompt = [
        { role: 'system', content: `Summarize the following email thread concisely. 
IMPORTANT: Return ONLY plain text with NO formatting, NO markdown, NO bold text.
Write 2-4 sentences that capture: 1) Main topics discussed, 2) Key decisions made, 3) Any action items mentioned.` },
        { role: 'user', content: threadContent }
    ];

    try {
        const response = await callAIProvider(prompt, settings, { maxTokens: 500 });
        
        const result = {
            summary: response,
            emailCount: thread.length,
            model: settings.model,
            provider: settings.provider
        };

        setCachedResponse(cacheKey, result, userId);
        return {
            summary: response,
            emailCount: thread.length,
            model: settings.model,
            provider: settings.provider
        };
    } catch (error) {
        console.error('Error summarizing thread:', error);
        return {
            summary: `This thread contains ${thread.length} emails. The conversation appears to be about: ${subject}`,
            error: error.message,
            fallback: true
        };
    }
}

/**
 * Analyze email for sentiment and urgency
 */
async function analyzeEmail(userId, emailData) {
    const rateCheck = checkRateLimit(userId);
    if (!rateCheck.allowed) {
        throw new Error(`Rate limit exceeded. Retry after ${rateCheck.retryAfter} seconds.`);
    }

    const cacheKey = generateCacheKey({ type: 'analyze', ...emailData });
    const cached = getCachedResponse(cacheKey);
    if (cached) {
        return cached;
    }

    let settings = userSettings.get(userId) || { ...defaultSettings };
    if (emailData.apiKey) {
        settings = { ...settings, apiKey: emailData.apiKey, enabled: true };
    }
    if (!settings.enabled) {
        throw new Error('AI features are disabled');
    }

    const { subject, from, body, bodyText, bodyHtml, apiKey } = emailData;
    const bodyContent = bodyText || body || bodyHtml || '';
    
    const prompt = [
        { role: 'system', content: `Analyze the following email and provide a JSON response with:
- sentiment: "positive", "negative", or "neutral"
- urgency: "high", "medium", or "low"
- category: "meeting", "action_required", "informational", "urgent", "promotional", "personal"
- key_topics: array of main topics (max 5)
- suggested_response_type: "reply", "forward", "archive", "reply_urgent"
- brief_reasoning: 1-2 sentence explanation

Respond ONLY with valid JSON, no markdown formatting, no code blocks.` },
        { role: 'user', content: `Subject: ${subject}\nFrom: ${from}\n\nEmail:\n${bodyContent}` }
    ];

    try {
        const response = await callAIProvider(prompt, settings, { maxTokens: 500, temperature: 0.3 });
        
        // Parse JSON response
        let analysis;
        try {
            analysis = JSON.parse(response);
        } catch {
            // Fallback if AI doesn't return valid JSON
            analysis = {
                sentiment: 'neutral',
                urgency: 'low',
                category: 'informational',
                key_topics: [],
                suggested_response_type: 'reply',
                brief_reasoning: 'Could not parse AI response'
            };
        }

        const result = {
            analysis,
            model: settings.model,
            provider: settings.provider
        };

        setCachedResponse(cacheKey, result, userId);
        return {
            analysis,
            model: settings.model,
            provider: settings.provider
        };
    } catch (error) {
        console.error('Error analyzing email:', error);
        return {
            analysis: {
                sentiment: 'neutral',
                urgency: 'low',
                category: 'informational',
                key_topics: [],
                suggested_response_type: 'reply',
                brief_reasoning: 'Analysis unavailable due to error'
            },
            error: error.message,
            fallback: true
        };
    }
}

/**
 * Get user AI settings
 */
function getSettings(userId) {
    const settings = userSettings.get(userId) || defaultSettings;
    // Don't expose API key
    return {
        provider: settings.provider,
        model: settings.model,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        enabled: settings.enabled
    };
}

/**
 * Update user AI settings
 */
function updateSettings(userId, newSettings) {
    const current = userSettings.get(userId) || { ...defaultSettings };
    
    // Validate provider
    if (newSettings.provider && !['anthropic', 'openai', 'google', 'nvidia', 'openrouter'].includes(newSettings.provider)) {
        throw new Error('Invalid AI provider');
    }

    // Validate model (only enforce known lists for providers that have fixed model sets)
    if (newSettings.model) {
        const validModels = {
            anthropic: ['claude-3-haiku-20240307', 'claude-3-sonnet-20240229', 'claude-3-opus-20240229'],
            openai: ['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo'],
            google: ['gemini-pro', 'gemini-pro-vision']
        };
        const provider = newSettings.provider || current.provider;
        // nvidia and openrouter accept arbitrary model strings — skip validation for them
        if (validModels[provider] && !validModels[provider].includes(newSettings.model)) {
            throw new Error('Invalid model for selected provider');
        }
    }

    // Update settings
    const updated = { ...current, ...newSettings };
    
    // Store API key securely if provided (never exposed to frontend)
    if (newSettings.apiKey) {
        updated.apiKey = newSettings.apiKey;
    }

    userSettings.set(userId, updated);

    // Return without API key
    const { apiKey, ...safeSettings } = updated;
    return safeSettings;
}

/**
 * Clear user cache
 */
function clearCache(userId) {
    for (const [key, value] of requestCache.entries()) {
        if (value.userId === userId) {
            requestCache.delete(key);
        }
    }
}

/**
 * Get AI service status
 */
function getStatus() {
    return {
        provider: process.env.AI_PROVIDER || 'anthropic',
        cacheSize: requestCache.size,
        rateLimitStoreSize: rateLimitStore.size,
        configured: !!(process.env.AI_API_KEY)
    };
}

/**
 * Compose email content using AI
 */
async function composeEmail(userId, options) {
    const { systemPrompt, userContent, tone, length, apiKey } = options;
    
    // Check rate limit
    const rateCheck = checkRateLimit(userId);
    if (!rateCheck.allowed) {
        throw new Error(`Rate limit exceeded. Try again in ${rateCheck.retryAfter} seconds.`);
    }
    
    // Get settings - use apiKey from options if provided, otherwise use defaults
    let settings = { ...defaultSettings };
    if (apiKey) {
        settings.apiKey = apiKey;
        settings.enabled = true;
    } else {
        settings = userSettings.get(userId) || { ...defaultSettings };
    }
    
    if (!settings.enabled) {
        throw new Error('AI features are disabled');
    }
    
    const key = settings.apiKey || defaultSettings.apiKey;
    
    if (!key) {
        throw new Error('AI API key not configured. Please try again later.');
    }
    
    // Build the prompt based on tone and length
    let lengthInstruction = '';
    if (length === 'Short (1 para)') {
        lengthInstruction = 'Keep it brief, 1 short paragraph.';
    } else if (length === 'Medium (2-3 paras)') {
        lengthInstruction = 'Write 2-3 paragraphs.';
    } else if (length === 'Long') {
        lengthInstruction = 'Write a detailed, comprehensive response.';
    }
    
    const fullSystemPrompt = `${systemPrompt} Write in a ${tone || 'professional'} tone. ${lengthInstruction} Write ONLY the email body text, no greeting or sign-off. Use plain text only, no markdown formatting. Use British English.`;
    
    // Build messages in the format expected by callAIProvider
    const prompt = [
        { role: 'system', content: fullSystemPrompt },
        { role: 'user', content: userContent }
    ];
    
    console.log('[AI Compose] Calling AI with provider:', settings.provider, 'model:', settings.model);
    
    const result = await callAIProvider(prompt, settings);
    
    return {
        content: result,
        usage: { prompt_tokens: 0, completion_tokens: 0 }
    };
}

module.exports = {
    suggestReply,
    summarizeThread,
    analyzeEmail,
    getSettings,
    updateSettings,
    clearCache,
    getStatus,
    defaultSettings,
    composeEmail
};