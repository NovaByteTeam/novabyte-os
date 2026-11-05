/**
 * NovaByte Bridge - Proxy Routes
 * Express routes for frontend (NovaMail client) communication
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');

// Import services
const authService = require('./auth-service');
const accountService = require('./account-service');
const MailService = require('./mail-service');
const mailService = new MailService();

// Load providers
let providers = [];
try {
    providers = require('./providers.json');
} catch (error) {
    console.error('[ProxyRoutes] Failed to load providers:', error.message);
}

// Create router
const router = express.Router();

// Rate limiter for mail operations
const mailRateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 30, // 30 requests per minute
    message: { error: 'Too many mail requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false
});

// Rate limiter for sync operations
const syncRateLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 5, // 5 sync requests per 5 minutes
    message: { error: 'Too many sync requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false
});

// Rate limiter for Horizon browser proxy - higher limits for browsing
const proxyRateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 120, // 120 requests per minute (browsing needs more)
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        return req.ip + (req.query.url || '').substring(0, 50);
    }
});

// Helper function to fetch using Node's https module (fallback for older Node)
const fetchWithHttps = function(targetUrl) {
    return new Promise((resolve, reject) => {
        const protocol = targetUrl.protocol === 'https:' ? require('https') : require('http');
        const options = {
            hostname: targetUrl.hostname,
            port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
            path: targetUrl.pathname + targetUrl.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
            },
            timeout: 15000
        };
        
        const req = protocol.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                // Create a mock response object compatible with fetch API
                resolve({
                    status: res.statusCode,
                    ok: res.statusCode >= 200 && res.statusCode < 400,
                    headers: new Map(Object.entries(res.headers)),
                    text: () => Promise.resolve(body),
                    json: () => Promise.resolve(JSON.parse(body))
                });
            });
        });
        
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
        
        req.end();
    });
};

/* ─────────────────────────────────────────────────────────────────────────────
   HORIZON BROWSER PROXY - Fetch external URLs for Horizon browser
   This allows Horizon to load any website without CORS issues
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * GET /api/mail/proxy?url=<encoded-url>
 * Proxy endpoint to fetch external websites for Horizon browser
 * Returns the response with CORS headers allowing any origin
 */
router.get('/proxy', proxyRateLimiter, async (req, res) => {
    let { url } = req.query;
    
    // Decode the URL if it's double-encoded
    try { url = decodeURIComponent(url); } catch {}
    
    // Decode HTML entities injected by browsers or rich-text encoding paths
    // e.g. &#x2F; → /   &#x3A; → :   &amp; → &
    url = url
        .replace(/&#x2F;/gi, '/')
        .replace(/&#x3A;/gi, ':')
        .replace(/&amp;/gi, '&')
        .replace(/&#x26;/gi, '&');
    
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }
    
    // Validate URL is HTTP/HTTPS
    let targetUrl;
    try {
        targetUrl = new URL(url);
        if (!['http:', 'https:'].includes(targetUrl.protocol)) {
            return res.status(400).json({ error: 'Only HTTP and HTTPS URLs are allowed' });
        }
    } catch (e) {
        return res.status(400).json({ error: 'Invalid URL format' });
    }
    
    try {
        // Try native fetch first (Node 18+)
        console.log('[Proxy] Fetching:', targetUrl.toString());
        let response;
        try {
            response = await fetch(targetUrl.toString(), {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                },
                signal: AbortSignal.timeout(15000)
            });
        } catch (fetchErr) {
            // Fallback to https module if native fetch fails
            console.log('[Proxy] Native fetch failed, trying https module:', fetchErr.message);
            response = await fetchWithHttps(targetUrl);
        }
        console.log('[Proxy] Response status:', response.status);
        
        // Set CORS headers - forward from target if present, otherwise allow all
        const corsOrigin = response.headers.get('access-control-allow-origin') || '*';
        res.setHeader('Access-Control-Allow-Origin', corsOrigin);
        
        // Forward other CORS headers if present in target response
        const corsMethods = response.headers.get('access-control-allow-methods');
        if (corsMethods) res.setHeader('Access-Control-Allow-Methods', corsMethods);
        else res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        
        const corsHeaders = response.headers.get('access-control-allow-headers');
        if (corsHeaders) res.setHeader('Access-Control-Allow-Headers', corsHeaders);
        else res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        
        res.setHeader('Access-Control-Max-Age', '86400');
        
        // Set Origin-Agent-Cluster to ensure this proxy response is treated as origin-keyed
        // This prevents the browser from combining it with site-keyed content
        res.setHeader('Origin-Agent-Cluster', '?1');
        
        // Get content type - handle both native fetch Headers and Map from fallback
        let contentType = '';
        if (typeof response.headers.get === 'function') {
            contentType = response.headers.get('content-type') || '';
        } else if (response.headers instanceof Map) {
            contentType = response.headers.get('content-type') || response.headers.get('Content-Type') || '';
        } else if (response.headers && typeof response.headers === 'object') {
            contentType = response.headers['content-type'] || response.headers['Content-Type'] || '';
        }
        
        // Forward Set-Cookie header if present (strip HttpOnly for security in sandboxed context)
        const setCookie = response.headers.get('set-cookie');
        if (setCookie) {
            // Remove HttpOnly flag since iframe cannot access HttpOnly cookies anyway
            const sanitizedCookie = setCookie.replace('HttpOnly', '').replace('; Secure', '').trim();
            res.setHeader('Set-Cookie', sanitizedCookie);
        }
        
        let body = await response.text();
        
        if (contentType.includes('text/html')) {
            // Strip X-Frame-Options and CSP frame-ancestors — these are the #1 reason
            // websites refuse to load in iframes. We strip them server-side before
            // the browser ever sees them.
            res.removeHeader('X-Frame-Options');
            res.removeHeader('x-frame-options');

            // Set a permissive CSP for proxied content
            res.setHeader(
                'Content-Security-Policy',
                "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;"
            );
            
            // Inject base tag to fix relative URLs
            const baseTag = `<base href="${targetUrl.origin}/">`;
            if (body.includes('<head>')) {
                body = body.replace('<head>', '<head>' + baseTag);
            } else if (body.includes('<body>')) {
                body = body.replace('<body>', baseTag + '<body>');
            } else {
                body = baseTag + body;
            }
            
            // Set content type to HTML
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
        } else {
            // Pass through original content type
            res.setHeader('Content-Type', contentType || 'application/octet-stream');
        }
        
        res.status(response.status).send(body);
        
    } catch (error) {
        console.error('[Proxy] Fetch error:', error.message);
        res.status(502).json({ error: 'Failed to fetch URL: ' + error.message });
    }
});

/**
 * OPTIONS /api/mail/proxy - Handle CORS preflight
 */
router.options('/proxy', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.status(204).end();
});

// Store Socket.io instance for WebSocket events
let io = null;

/**
 * Set Socket.io instance for WebSocket events
 */
const setSocketIO = (socketIO) => {
    io = socketIO;
};

/**
 * Middleware to validate session and get user
 */
const requireAuth = async (req, res, next) => {
    try {
        // Get session token from cookie or header
        const token = req.cookies?.sessionToken || req.headers?.authorization?.replace('Bearer ', '');
        
        if (!token) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        
        // Validate session
        const session = await authService.Session.validate(token);
        
        if (!session.valid) {
            return res.status(401).json({ error: 'Invalid or expired session' });
        }
        
        // Attach user to request
        req.userId = session.userId;
        req.session = session;
        
        next();
    } catch (error) {
        console.error('[ProxyRoutes] Auth error:', error.message);
        return res.status(401).json({ error: 'Authentication failed' });
    }
};

/**
 * Middleware to validate account ownership
 */
const validateAccountOwnership = async (req, res, next) => {
    try {
        const { id: accountId } = req.params;
        const userId = req.userId;
        
        // Require user ID - must be authenticated or provide valid session
        if (!userId) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        
        // Validate ownership
        const isOwner = await accountService.validateOwnership(accountId, userId);
        if (!isOwner) {
            return res.status(403).json({ error: 'Access denied: You do not own this account' });
        }
        
        next();
    } catch (error) {
        console.error('[ProxyRoutes] Ownership validation error:', error.message);
        return res.status(500).json({ error: 'Failed to validate account ownership' });
    }
};

// ============================================================================
// ACCOUNT MANAGEMENT ROUTES
// ============================================================================

/**
 * POST /api/mail/accounts - Add new email account
 * Requires authentication
 */
router.post('/accounts', requireAuth, async (req, res) => {
    try {
        // For local email client, use a default user ID or get from session
        let userId = req.userId || req.cookies?.sessionUserId || 'local-user';
        const accountData = req.body;
        
        // Validate required fields
        if (!accountData.email && !accountData.emailAddress) {
            return res.status(400).json({ error: 'Email address is required' });
        }
        
        if (!accountData.providerId) {
            return res.status(400).json({ error: 'Provider ID is required' });
        }
        
        // Validate provider exists
        const provider = providers.find(p => p.id === accountData.providerId);
        if (!provider) {
            return res.status(400).json({ error: 'Invalid provider' });
        }
        
        // If custom provider, use custom settings
        if (accountData.providerId === 'custom') {
            if (!accountData.imapHost || !accountData.smtpHost) {
                return res.status(400).json({ error: 'Custom IMAP/SMTP host required' });
            }
            accountData.isCustomProvider = true;
        }
        
        // Auto-fill provider settings if not custom
        if (provider && !accountData.isCustomProvider) {
            accountData.imapHost = provider.imap_host;
            accountData.imapPort = provider.imap_port;
            accountData.imapSsl = provider.imap_ssl;
            accountData.smtpHost = provider.smtp_host;
            accountData.smtpPort = provider.smtp_port;
            accountData.smtpSsl = provider.smtp_ssl;
            accountData.smtpTls = provider.smtp_tls;
        }
        
        const account = await accountService.addAccount(userId, accountData);
        
        res.status(201).json({
            success: true,
            account
        });
    } catch (error) {
        console.error('[ProxyRoutes] Add account error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

/**
 * GET /api/mail/accounts - List all accounts for user
 * Requires authentication
 */
router.get('/accounts', requireAuth, async (req, res) => {
    try {
        // For local email client, use a default user ID
        const userId = req.userId || req.cookies?.sessionUserId || 'local-user';
        const userAccounts = await accountService.getAccounts(userId);
        
        res.json({
            success: true,
            accounts: userAccounts,
            count: userAccounts.length
        });
    } catch (error) {
        console.error('[ProxyRoutes] Get accounts error:', error.message);
        res.status(500).json({ error: 'Failed to retrieve accounts' });
    }
});

/**
 * GET /api/mail/accounts/:id - Get account details
 * Requires authentication
 */
router.get('/accounts/:id', requireAuth, async (req, res) => {
    try {
        const { id: accountId } = req.params;
        const userId = req.userId || req.cookies?.sessionUserId || 'local-user';
        
        const account = await accountService.getAccountByIdMasked(accountId);
        
        if (!account) {
            return res.status(404).json({ error: 'Account not found' });
        }
        
        // Get provider info
        const provider = providers.find(p => p.id === account.providerId);
        
        res.json({
            success: true,
            account: {
                ...account,
                provider: provider ? {
                    name: provider.name,
                    provider: provider.provider,
                    oauthSupported: provider.oauth_supported,
                    description: provider.description
                } : null
            }
        });
    } catch (error) {
        console.error('[ProxyRoutes] Get account error:', error.message);
        res.status(500).json({ error: 'Failed to retrieve account' });
    }
});

/**
 * DELETE /api/mail/accounts/:id - Remove account
 * Requires authentication
 */
router.delete('/accounts/:id', requireAuth, async (req, res) => {
    try {
        const { id: accountId } = req.params;
        // For local email client, use the same default user ID
        const userId = req.userId || req.cookies?.sessionUserId || 'local-user';
        
        await accountService.removeAccount(accountId, userId);
        
        res.json({
            success: true,
            message: 'Account removed successfully'
        });
    } catch (error) {
        console.error('[ProxyRoutes] Remove account error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

/**
 * PUT /api/mail/accounts/:id - Update account settings
 * Requires authentication
 */
router.put('/accounts/:id', requireAuth, async (req, res) => {
    try {
        const { id: accountId } = req.params;
        const userId = req.userId || req.cookies?.sessionUserId || 'local-user';
        const updates = req.body;
        
        // Prevent updating certain fields
        delete updates.id;
        delete updates.userId;
        delete updates.createdAt;
        
        const account = await accountService.updateAccount(accountId, req.userId, updates);
        
        res.json({
            success: true,
            account
        });
    } catch (error) {
        console.error('[ProxyRoutes] Update account error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

/**
 * POST /api/mail/accounts/:id/test - Test account connection
 * Requires authentication
 */
router.post('/accounts/:id/test', requireAuth, async (req, res) => {
    try {
        const { id: accountId } = req.params;
        const userId = req.userId || req.cookies?.sessionUserId || 'local-user';
        
        // Get decrypted credentials
        const credentials = await accountService.getDecryptedCredentials(accountId);
        
        if (!credentials) {
            return res.status(404).json({ error: 'Account not found' });
        }
        
        // Test IMAP connection by connecting
        try {
            const connection = await mailService.connect(accountId, credentials);
            const imapTest = await mailService.testConnection(connection);
            await mailService.disconnect(accountId);
            
            res.json({
                success: imapTest,
                imap: { success: imapTest },
                message: imapTest ? 'Connection successful' : 'Connection failed'
            });
        } catch (connError) {
            res.json({
                success: false,
                imap: { success: false, error: connError.message },
                message: 'Connection failed'
            });
        }
        
        res.json({
            success: true,
            imap: imapTest,
            message: imapTest.success ? 'Connection successful' : 'Connection failed'
        });
    } catch (error) {
        console.error('[ProxyRoutes] Test connection error:', error.message);
        res.status(500).json({ error: 'Connection test failed', details: error.message });
    }
});

/**
 * GET /api/mail/accounts/:id/status - Get sync status
 * Requires authentication
 */
router.get('/accounts/:id/status', requireAuth, async (req, res) => {
    try {
        const { id: accountId } = req.params;
        const userId = req.userId || req.cookies?.sessionUserId || 'local-user';
        
        const account = await accountService.getAccountByIdMasked(accountId);
        
        if (!account) {
            return res.status(404).json({ error: 'Account not found' });
        }
        
        res.json({
            success: true,
            status: {
                syncStatus: account.syncStatus,
                lastSyncAt: account.lastSyncAt,
                syncError: account.syncError,
                syncEnabled: account.syncEnabled,
                syncInterval: account.syncInterval
            }
        });
    } catch (error) {
        console.error('[ProxyRoutes] Get status error:', error.message);
        res.status(500).json({ error: 'Failed to get account status' });
    }
});

// ============================================================================
// EMAIL OPERATIONS ROUTES
// ============================================================================

/**
 * GET /api/mail/accounts/:id/inbox - Fetch inbox emails (pagination)
 */
router.get('/accounts/:id/inbox', async (req, res) => {
    try {
        const { id: accountId } = req.params;
        const userId = req.userId || req.cookies?.sessionUserId || 'local-user';
        const { page = 1, limit = 50 } = req.query;
        
        // Get decrypted credentials
        const credentials = await accountService.getDecryptedCredentials(accountId);
        
        if (!credentials) {
            return res.status(404).json({ error: 'Account not found' });
        }
        
        // Fetch inbox emails
        const result = await mailService.fetchInbox(accountId, credentials, {
            page: parseInt(page),
            limit: parseInt(limit)
        });
        
        res.json({
            success: true,
            emails: result.emails,
            pagination: result.pagination
        });
    } catch (error) {
        console.error('[ProxyRoutes] Get inbox error:', error.message);
        res.status(500).json({ error: 'Failed to fetch inbox', details: error.message });
    }
});

/**
 * GET /api/mail/accounts/:id/emails - Fetch emails from folder
 */
router.get('/accounts/:id/emails', async (req, res) => {
    try {
        const { id: accountId } = req.params;
        const { folder = 'INBOX', page = 1, limit = 50 } = req.query;
        const userId = req.userId || req.cookies?.sessionUserId || 'local-user';
        
        // Get decrypted credentials
        const credentials = await accountService.getDecryptedCredentials(accountId);
        
        if (!credentials) {
            return res.status(404).json({ error: 'Account not found' });
        }
        
        // Fetch emails from folder
        const result = await mailService.fetchInbox(accountId, credentials, {
            page: parseInt(page),
            limit: parseInt(limit),
            folder: folder
        });
        
        res.json({
            success: true,
            emails: result.emails,
            folder,
            pagination: result.pagination
        });
    } catch (error) {
        console.error('[ProxyRoutes] Get emails error:', error.message);
        res.status(500).json({ error: 'Failed to fetch emails', details: error.message });
    }
});

/**
 * GET /api/mail/accounts/:id/emails/:messageId - Get full email
 */
router.get('/accounts/:id/emails/:messageId', async (req, res) => {
    try {
        const { id: accountId, messageId } = req.params;
        const userId = req.userId || req.cookies?.sessionUserId || 'local-user';
        
        // Get decrypted credentials
        const credentials = await accountService.getDecryptedCredentials(accountId);
        
        if (!credentials) {
            return res.status(404).json({ error: 'Account not found' });
        }
        
        // Decode messageId
        const decodedMessageId = decodeURIComponent(messageId);
        
        // Get full email
        const email = await mailService.fetchEmail(accountId, credentials, decodedMessageId);
        
        if (!email) {
            return res.status(404).json({ error: 'Email not found' });
        }
        
        res.json({
            success: true,
            email
        });
    } catch (error) {
        console.error('[ProxyRoutes] Get email error:', error.message);
        res.status(500).json({ error: 'Failed to fetch email', details: error.message });
    }
});

/**
 * POST /api/mail/accounts/:id/send - Send email
 */
router.post('/accounts/:id/send', requireAuth, validateAccountOwnership, mailRateLimiter, async (req, res) => {
    try {
        const { id: accountId } = req.params;
        const { to, cc, bcc, subject, body, html, attachments } = req.body;
        
        if (!to) {
            return res.status(400).json({ error: 'Recipient is required' });
        }
        
        if (!subject && !body && !html) {
            return res.status(400).json({ error: 'Email content is required' });
        }
        
        // Get decrypted credentials
        const credentials = await accountService.getDecryptedCredentials(accountId);
        
        if (!credentials) {
            return res.status(404).json({ error: 'Account not found' });
        }
        
        // Send email
        const result = await mailService.sendMessage(accountId, credentials, {
            to,
            cc,
            bcc,
            subject,
            text: body,
            html,
            attachments
        });
        
        res.json({
            success: true,
            messageId: result.messageId,
            sentAt: result.sentAt
        });
    } catch (error) {
        console.error('[ProxyRoutes] Send email error:', error.message);
        res.status(500).json({ error: 'Failed to send email', details: error.message });
    }
});

/**
 * POST /api/mail/accounts/:id/move - Move email to folder
 */
router.post('/accounts/:id/move', requireAuth, validateAccountOwnership, mailRateLimiter, async (req, res) => {
    try {
        const { id: accountId } = req.params;
        const { messageId, targetFolder } = req.body;
        
        if (!messageId) {
            return res.status(400).json({ error: 'Message ID is required' });
        }
        
        if (!targetFolder) {
            return res.status(400).json({ error: 'Target folder is required' });
        }
        
        // Get decrypted credentials
        const credentials = await accountService.getDecryptedCredentials(accountId);
        
        if (!credentials) {
            return res.status(404).json({ error: 'Account not found' });
        }
        
        // Move email
        const result = await mailService.moveToFolder(accountId, credentials, [messageId], targetFolder);
        
        res.json({
            success: true,
            message: `Email moved to ${targetFolder}`
        });
    } catch (error) {
        console.error('[ProxyRoutes] Move email error:', error.message);
        res.status(500).json({ error: 'Failed to move email', details: error.message });
    }
});

/**
 * POST /api/mail/accounts/:id/delete - Delete email
 */
router.post('/accounts/:id/delete', requireAuth, validateAccountOwnership, mailRateLimiter, async (req, res) => {
    try {
        const { id: accountId } = req.params;
        const { messageId, moveToTrash = true } = req.body;
        
        if (!messageId) {
            return res.status(400).json({ error: 'Message ID is required' });
        }
        
        // Get decrypted credentials
        const credentials = await accountService.getDecryptedCredentials(accountId);
        
        if (!credentials) {
            return res.status(404).json({ error: 'Account not found' });
        }
        
        // Delete email - move to trash
        await mailService.moveToFolder(accountId, credentials, [messageId], moveToTrash ? 'Trash' : '[Gmail]/Trash');
        
        res.json({
            success: true,
            message: moveToTrash ? 'Email moved to trash' : 'Email deleted permanently'
        });
    } catch (error) {
        console.error('[ProxyRoutes] Delete email error:', error.message);
        res.status(500).json({ error: 'Failed to delete email', details: error.message });
    }
});

/**
 * GET /api/mail/accounts/:id/folders - Get folders
 */
router.get('/accounts/:id/folders', requireAuth, validateAccountOwnership, async (req, res) => {
    try {
        const { id: accountId } = req.params;
        
        // Get decrypted credentials
        const credentials = await accountService.getDecryptedCredentials(accountId);
        
        if (!credentials) {
            return res.status(404).json({ error: 'Account not found' });
        }
        
        // Get folders
        const folders = await mailService.getFolders(credentials);
        
        res.json({
            success: true,
            folders
        });
    } catch (error) {
        console.error('[ProxyRoutes] Get folders error:', error.message);
        res.status(500).json({ error: 'Failed to get folders', details: error.message });
    }
});

/**
 * GET /api/mail/accounts/:id/search - Search emails
 */
router.get('/accounts/:id/search', requireAuth, validateAccountOwnership, mailRateLimiter, async (req, res) => {
    try {
        const { id: accountId } = req.params;
        const { query, folder = 'INBOX', page = 1, limit = 50 } = req.query;
        
        if (!query) {
            return res.status(400).json({ error: 'Search query is required' });
        }
        
        // Get decrypted credentials
        const credentials = await accountService.getDecryptedCredentials(accountId);
        
        if (!credentials) {
            return res.status(404).json({ error: 'Account not found' });
        }
        
        // Search emails
        const result = await mailService.search(accountId, credentials, {
            query,
            folder,
            page: parseInt(page),
            limit: parseInt(limit)
        });
        
        res.json({
            success: true,
            emails: result.emails,
            query,
            pagination: result.pagination
        });
    } catch (error) {
        console.error('[ProxyRoutes] Search emails error:', error.message);
        res.status(500).json({ error: 'Failed to search emails', details: error.message });
    }
});

// ============================================================================
// SYNC OPERATIONS ROUTES
// ============================================================================

/**
 * POST /api/mail/accounts/:id/sync - Trigger full sync
 */
router.post('/accounts/:id/sync', async (req, res) => {
    try {
        const { id: accountId } = req.params;
        const userId = req.userId || req.cookies?.sessionUserId || 'local-user';
        
        // Get account
        const account = await accountService.getAccountByIdMasked(accountId);
        
        if (!account) {
            return res.status(404).json({ error: 'Account not found' });
        }
        
        // Update sync status
        await accountService.updateSyncStatus(accountId, 'syncing');
        
        // Get decrypted credentials
        const credentials = await accountService.getDecryptedCredentials(accountId);
        
        if (!credentials) {
            return res.status(404).json({ error: 'Account not found' });
        }
        
        // Start sync in background
        setImmediate(async () => {
            try {
                // Get folders and sync inbox
                const folders = await mailService.getFolders(accountId, credentials);
                let messagesCount = 0;
                
                // Sync INBOX
                const inboxSync = await mailService.syncFolder(accountId, credentials, 'INBOX');
                messagesCount += inboxSync.newMessages || 0;
                
                // Update sync status
                await accountService.updateSyncStatus(accountId, 'complete');
                
                // Emit sync complete event
                if (io) {
                    io.to(`user:${req.userId}`).emit('sync_complete', {
                        accountId,
                        status: 'complete',
                        syncedAt: new Date().toISOString(),
                        messagesCount
                    });
                }
            } catch (syncError) {
                console.error('[ProxyRoutes] Sync error:', syncError.message);
                
                // Update sync status to error
                await accountService.updateSyncStatus(accountId, 'error', syncError.message);
                
                // Emit sync error event
                if (io) {
                    io.to(`user:${req.userId}`).emit('sync_error', {
                        accountId,
                        status: 'error',
                        error: syncError.message
                    });
                }
            }
        });
        
        res.json({
            success: true,
            message: 'Sync started',
            status: 'syncing'
        });
    } catch (error) {
        console.error('[ProxyRoutes] Start sync error:', error.message);
        res.status(500).json({ error: 'Failed to start sync', details: error.message });
    }
});

/**
 * GET /api/mail/accounts/:id/sync/status - Get sync status
 */
router.get('/accounts/:id/sync/status', requireAuth, validateAccountOwnership, async (req, res) => {
    try {
        const { id: accountId } = req.params;
        
        const account = await accountService.getAccountByIdMasked(accountId);
        
        if (!account) {
            return res.status(404).json({ error: 'Account not found' });
        }
        
        res.json({
            success: true,
            status: {
                syncStatus: account.syncStatus,
                lastSyncAt: account.lastSyncAt,
                syncError: account.syncError,
                syncEnabled: account.syncEnabled,
                syncInterval: account.syncInterval
            }
        });
    } catch (error) {
        console.error('[ProxyRoutes] Get sync status error:', error.message);
        res.status(500).json({ error: 'Failed to get sync status' });
    }
});

// ============================================================================
// PROVIDERS ROUTES
// ============================================================================

/**
 * GET /api/mail/providers - Get provider configurations
 */
router.get('/providers', async (req, res) => {
    try {
        // Return sanitized provider list (hide sensitive config)
        const sanitizedProviders = providers.map(p => ({
            id: p.id,
            name: p.name,
            provider: p.provider,
            icon_url: p.icon_url,
            description: p.description,
            notes: p.notes,
            oauth_supported: p.oauth_supported,
            app_password_required: p.app_password_required,
            requires_bridge: p.requires_bridge,
            custom_configurable: p.custom_configurable,
            app_password_url: p.app_password_url,
            bridge_url: p.bridge_url,
            limits: p.limits
        }));
        
        res.json({
            success: true,
            providers: sanitizedProviders
        });
    } catch (error) {
        console.error('[ProxyRoutes] Get providers error:', error.message);
        res.status(500).json({ error: 'Failed to get providers' });
    }
});

/**
 * POST /api/mail/providers/autodiscover - Auto-discover settings from email
 */
router.post('/providers/autodiscover', requireAuth, async (req, res) => {
    try {
        const { email } = req.body;
        
        if (!email) {
            return res.status(400).json({ error: 'Email address is required' });
        }
        
        const domain = email.split('@')[1]?.toLowerCase();
        
        if (!domain) {
            return res.status(400).json({ error: 'Invalid email address' });
        }
        
        // Try to find provider by domain
        let provider = null;
        
        // Known domain mappings
        const domainMappings = {
            'gmail.com': 'gmail',
            'googlemail.com': 'gmail',
            'outlook.com': 'outlook',
            'hotmail.com': 'outlook',
            'live.com': 'outlook',
            'msn.com': 'outlook',
            'office365.com': 'office365',
            'icloud.com': 'icloud',
            'me.com': 'icloud',
            'mac.com': 'icloud',
            'yahoo.com': 'yahoo',
            'ymail.com': 'yahoo',
            'protonmail.com': 'proton',
            'proton.me': 'proton-plus',
            'zoho.com': 'zoho',
            'fastmail.com': 'fastmail',
            'fastmail.fm': 'fastmail'
        };
        
        const providerId = domainMappings[domain];
        
        if (providerId) {
            provider = providers.find(p => p.id === providerId);
        }
        
        // If no known provider, return custom provider config
        if (!provider) {
            return res.json({
                success: true,
                provider: {
                    id: 'custom',
                    name: 'Custom IMAP/SMTP',
                    isCustom: true,
                    message: `No preset configuration for ${domain}. Please enter IMAP/SMTP settings manually.`
                }
            });
        }
        
        res.json({
            success: true,
            provider: {
                id: provider.id,
                name: provider.name,
                provider: provider.provider,
                imap_host: provider.imap_host,
                imap_port: provider.imap_port,
                imap_ssl: provider.imap_ssl,
                smtp_host: provider.smtp_host,
                smtp_port: provider.smtp_port,
                smtp_ssl: provider.smtp_ssl,
                smtp_tls: provider.smtp_tls,
                oauth_supported: provider.oauth_supported,
                app_password_required: provider.app_password_required,
                requires_bridge: provider.requires_bridge,
                description: provider.description,
                notes: provider.notes
            }
        });
    } catch (error) {
        console.error('[ProxyRoutes] Autodiscover error:', error.message);
        res.status(500).json({ error: 'Auto-discover failed', details: error.message });
    }
});

// ============================================================================
// WEBSOCKET INTEGRATION
// ============================================================================

/**
 * Setup Socket.io events for real-time notifications
 */
const setupWebSocketEvents = (socket) => {
    const { userId, sessionToken } = socket.handshake.auth;
    
    if (!userId || !sessionToken) {
        console.log('[ProxyRoutes] WebSocket: No credentials provided');
        socket.disconnect();
        return;
    }
    
    // Join user-specific room
    socket.join(`user:${userId}`);
    
    console.log(`[ProxyRoutes] WebSocket: User ${userId} connected`);
    
    // Handle new email subscription for specific account
    socket.on('subscribe:account', async (accountId) => {
        try {
            // Validate ownership
            const isOwner = await accountService.validateOwnership(accountId, userId);
            
            if (isOwner) {
                socket.join(`account:${accountId}`);
                console.log(`[ProxyRoutes] WebSocket: User ${userId} subscribed to account ${accountId}`);
            }
        } catch (error) {
            console.error('[ProxyRoutes] WebSocket subscribe error:', error.message);
        }
    });
    
    // Handle unsubscribe from account
    socket.on('unsubscribe:account', (accountId) => {
        socket.leave(`account:${accountId}`);
        console.log(`[ProxyRoutes] WebSocket: User ${userId} unsubscribed from account ${accountId}`);
    });
    
    // Handle disconnect
    socket.on('disconnect', () => {
        console.log(`[ProxyRoutes] WebSocket: User ${userId} disconnected`);
    });
};

/**
 * Emit new email event to connected clients
 */
const emitNewEmail = (userId, accountId, email) => {
    if (io) {
        io.to(`user:${userId}`).to(`account:${accountId}`).emit('new_email', {
            accountId,
            email,
            receivedAt: new Date().toISOString()
        });
    }
};

module.exports = {
    router,
    setSocketIO,
    setupWebSocketEvents,
    emitNewEmail,
    requireAuth,
    validateAccountOwnership
};