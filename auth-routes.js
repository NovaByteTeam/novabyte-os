/**
 * NovaByte Bridge - Authentication Routes
 * Express routes for authentication endpoints
 */

const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const { AuthService, User, Session, OAuthTokens, AppPassword, CONFIG } = require('./auth-service');
const rateLimit = require('express-rate-limit');

const crypto = require('crypto');
const router = express.Router();

// Rate limiter for login attempts to prevent brute force
const loginRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts per window
    message: {
        error: 'Too many login attempts',
        message: 'Please try again in 15 minutes or use account recovery.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req, res) => {
        // Skip if email is not provided to avoid counting validation errors
        return !req.body?.email;
    }
});

// Rate limiter for registration
const registerRateLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 3, // 3 registrations per hour from same IP
    message: {
        error: 'Too many accounts created',
        message: 'Please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false
});

// Temporary store for OAuth state -> redirectUrl mapping
const oauthStateMap = new Map();

// Initialize Google OAuth client
const googleClient = new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/auth/google/callback'
);

/**
 * Middleware: Authenticate session
 */
const authenticateSession = async (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.sessionToken;

    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    try {
        const result = await AuthService.validateSession(token);
        if (!result.valid) {
            return res.status(401).json({ error: result.error });
        }

        req.user = result.user;
        req.session = result.session;
        req.refreshToken = result.refreshToken;
        next();
    } catch (error) {
        console.error('[Auth] Session validation error:', error);
        res.status(401).json({ error: 'Invalid session' });
    }
};

/**
 * Middleware: Optional authentication (doesn't fail if not authenticated)
 */
const optionalAuth = async (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.sessionToken;

    if (token) {
        try {
            const result = await AuthService.validateSession(token);
            if (result.valid) {
                req.user = result.user;
                req.session = result.session;
            }
        } catch (error) {
            // Continue without auth
        }
    }
    next();
};

// ============================================================================
// LOCAL AUTHENTICATION
// ============================================================================

/**
 * POST /api/auth/register
 * Register a new user
 */
router.post('/register', registerRateLimiter, async (req, res) => {
    try {
        const { email, password, displayName } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        // Email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        const result = await AuthService.register({ email, password, displayName });

        res.status(201).json({
            message: result.message,
            user: {
                id: result.user.id,
                email: result.user.email,
                displayName: result.user.displayName,
                createdAt: result.user.createdAt
            }
        });
    } catch (error) {
        console.error('[Auth] Registration error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

/**
 * POST /api/auth/login
 * User login
 */
router.post('/login', loginRateLimiter, async (req, res) => {
    try {
        const { email, password, mfaCode, deviceInfo } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const ipAddress = req.ip || req.connection?.remoteAddress;
        const userAgent = req.headers['user-agent'];

        const result = await AuthService.login({
            email,
            password,
            deviceInfo,
            ipAddress,
            userAgent,
            mfaCode
        });

        if (result.mfaRequired) {
            return res.status(200).json({
                mfaRequired: true,
                message: result.message
            });
        }

        // Set session cookie
        res.cookie('sessionToken', result.session.token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: CONFIG.SESSION_EXPIRY_HOURS * 60 * 60 * 1000
        });

        res.json({
            message: result.message,
            user: {
                id: result.user.id,
                email: result.user.email,
                displayName: result.user.displayName,
                mfaEnabled: result.user.mfaEnabled,
                settings: result.user.settings
            },
            session: {
                token: result.session.token,
                expiresAt: result.session.expiresAt
            }
        });
    } catch (error) {
        console.error('[Auth] Login error:', error.message);
        res.status(401).json({ error: error.message });
    }
});

/**
 * POST /api/auth/logout
 * User logout
 */
router.post('/logout', authenticateSession, async (req, res) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        await AuthService.logout(token);

        res.clearCookie('sessionToken');
        res.json({ message: 'Logged out successfully' });
    } catch (error) {
        console.error('[Auth] Logout error:', error.message);
        res.status(500).json({ error: 'Logout failed' });
    }
});

/**
 * GET /api/auth/session
 * Validate current session
 */
router.get('/session', async (req, res) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.sessionToken;

        if (!token) {
            return res.status(401).json({ authenticated: false, error: 'No session token provided' });
        }

        const result = await AuthService.validateSession(token);

        if (!result.valid) {
            return res.status(401).json({ authenticated: false, error: result.error });
        }

        res.json({
            authenticated: true,
            user: {
                id: result.user.id,
                email: result.user.email,
                displayName: result.user.displayName,
                mfaEnabled: result.user.mfaEnabled,
                settings: result.user.settings,
                createdAt: result.user.createdAt,
                lastLogin: result.user.lastLogin
            },
            session: {
                id: result.session.id,
                expiresAt: result.session.expiresAt,
                lastActivity: result.session.lastActivity
            }
        });
    } catch (error) {
        console.error('[Auth] Session validation error:', error.message);
        res.status(401).json({ authenticated: false, error: 'Invalid session' });
    }
});

/**
 * POST /api/auth/refresh
 * Refresh session token
 */
router.post('/refresh', async (req, res) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.sessionToken;

        if (!token) {
            return res.status(401).json({ error: 'Session token required' });
        }

        const result = await AuthService.refreshSession(token);

        res.json({
            message: 'Session refreshed',
            session: {
                token: result.session.token,
                expiresAt: result.session.expiresAt
            }
        });
    } catch (error) {
        console.error('[Auth] Session refresh error:', error.message);
        res.status(401).json({ error: 'Invalid session' });
    }
});

/**
 * POST /api/auth/change-password
 * Change user password
 */
router.post('/change-password', authenticateSession, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current and new password are required' });
        }

        await AuthService.changePassword(req.user.id, currentPassword, newPassword);

        res.json({ message: 'Password changed successfully' });
    } catch (error) {
        console.error('[Auth] Password change error:', error.message);
        res.status(400).json({ error: error.message });
    }
});

// ============================================================================
// MULTI-FACTOR AUTHENTICATION
// ============================================================================

/**
 * POST /api/auth/setup-mfa
 * Setup TOTP MFA
 */
router.post('/setup-mfa', authenticateSession, async (req, res) => {
    try {
        // Check if MFA already enabled
        if (req.user.mfaEnabled) {
            return res.status(400).json({ error: 'MFA already enabled' });
        }

        const mfaSetup = await User.setupMFA(req.user.id);

        res.json({
            message: 'MFA setup initiated',
            secret: mfaSetup.secret,
            otpauth: mfaSetup.otpauth,
            backupCodes: mfaSetup.backupCodes
        });
    } catch (error) {
        console.error('[Auth] MFA setup error:', error.message);
        res.status(500).json({ error: 'MFA setup failed' });
    }
});

/**
 * POST /api/auth/verify-mfa
 * Verify TOTP code
 */
router.post('/verify-mfa', authenticateSession, async (req, res) => {
    try {
        const { code } = req.body;

        if (!code) {
            return res.status(400).json({ error: 'MFA code required' });
        }

        const result = User.verifyMFA(req.user.id, code);

        if (!result.valid) {
            return res.status(400).json({ error: result.error });
        }

        res.json({
            message: result.usedBackupCode ? 'Verified using backup code' : 'MFA verified successfully',
            usedBackupCode: result.usedBackupCode
        });
    } catch (error) {
        console.error('[Auth] MFA verification error:', error.message);
        res.status(500).json({ error: 'MFA verification failed' });
    }
});

/**
 * POST /api/auth/disable-mfa
 * Disable MFA
 */
router.post('/disable-mfa', authenticateSession, async (req, res) => {
    try {
        const { password } = req.body;

        if (!password) {
            return res.status(400).json({ error: 'Password required' });
        }

        // Verify password before disabling MFA
        const bcrypt = require('bcryptjs');
        const user = User.findByEmail(req.user.email);
        
        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid password' });
        }

        User.disableMFA(req.user.id);

        res.json({ message: 'MFA disabled successfully' });
    } catch (error) {
        console.error('[Auth] MFA disable error:', error.message);
        res.status(500).json({ error: 'MFA disable failed' });
    }
});

// ============================================================================
// OAUTH2 AUTHENTICATION - GOOGLE
// ============================================================================

/**
 * GET /api/auth/google
 * Initiate Google OAuth
 */
router.get('/google', (req, res) => {
    // Forward to google handler
    handleGoogleOAuth(req, res);
});

// Alias for gmail -> google
router.get('/gmail', (req, res) => {
    handleGoogleOAuth(req, res);
});

// Actual Google OAuth handler
function handleGoogleOAuth(req, res) {
    try {
        // Check if Google OAuth is configured
        if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
            console.warn('[Auth] Google OAuth not configured - GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET missing');
            return res.status(503).json({ 
                error: 'Google OAuth is not configured. Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your .env file.' 
            });
        }
        
        const scopes = [
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://mail.google.com/',
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/gmail.send',
            'https://www.googleapis.com/auth/calendar',
            'https://www.googleapis.com/auth/calendar.events'
        ];

        // Use a random state token instead of the redirectUrl to avoid path traversal issues
        const stateToken = crypto.randomBytes(16).toString('hex');
        oauthStateMap.set(stateToken, req.query.redirectUrl || '/');
        setTimeout(() => oauthStateMap.delete(stateToken), 10 * 60 * 1000);

        const authUrl = googleClient.generateAuthUrl({
            access_type: 'offline',
            scope: scopes,
            prompt: 'consent',
            state: stateToken
        });

        res.json({ authUrl });
    } catch (error) {
        console.error('[Auth] Google OAuth init error:', error.message);
        res.status(500).json({ error: 'Failed to initiate Google OAuth' });
    }
}

/**
 * GET /api/auth/google/callback
 * Google OAuth callback
 */
router.get('/google/callback', async (req, res) => {
    try {
        const { code, state } = req.query;

        console.log('[Auth] Google callback received, code present:', !!code);
        
        // Check if request is from an iframe - allow framing for same-origin scenarios
        // This fixes the "Unsafe attempt to load URL" error when OAuth callback
        // is loaded in a same-origin iframe (like the Horizon browser)
        const referer = req.headers.referer || '';
        const isFromSameOrigin = referer.includes('localhost:3001') || referer === '';
        
        if (isFromSameOrigin) {
            // Allow the callback to be framed within the same origin
            // Remove any existing X-Frame-Options that would block iframes
            res.removeHeader('X-Frame-Options');
            res.setHeader('X-Frame-Options', 'ALLOW-FROM http://localhost:3001');
            // Also update CSP frame-ancestors
            res.setHeader('Content-Security-Policy', "frame-ancestors 'self' http://localhost:3001");
        }
        
        if (!code) {
            console.log('[Auth] No code in callback, state:', state);
            return res.redirect(`/oauth-callback.html?error=no_code`);
        }

        // Exchange code for tokens
        console.log('[Auth] Exchanging code for tokens...');
        // Explicitly set the redirect URI to match what we registered
        googleClient.redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/auth/google/callback';
        console.log('[Auth] Using redirect URI:', googleClient.redirectUri);
        // Create a new client instance to ensure fresh token request
        const tempClient = new OAuth2Client(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            googleClient.redirectUri
        );
        const { tokens } = await tempClient.getToken(code);
        // Set credentials on the client for future API calls
        tempClient.setCredentials(tokens);
        console.log('[Auth] Got tokens, has access:', !!tokens.access_token, 'refresh:', !!tokens.refresh_token);

        // Get user info using the temp client
        const ticket = await tempClient.verifyIdToken({
            idToken: tokens.id_token,
            audience: process.env.GOOGLE_CLIENT_ID
        });

        const payload = ticket.getPayload();

        // Create or update user
        const profile = {
            id: payload.sub,
            email: payload.email,
            displayName: payload.name,
            profileImage: payload.picture
        };

        const result = await AuthService.oauthLogin({
            provider: 'google',
            profile: {
                ...profile,
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token,
                expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null
            },
            deviceInfo: req.headers['user-agent'],
            ipAddress: req.ip
        });

        // Store OAuth tokens
        const tokenScopes = [
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://mail.google.com/',
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/gmail.send',
            'https://www.googleapis.com/auth/calendar',
            'https://www.googleapis.com/auth/calendar.events'
        ];
        OAuthTokens.store({
            userId: result.user.id,
            provider: 'google',
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
            scope: tokenScopes.join(' ')
        });

        // Set session cookie
        res.cookie('sessionToken', result.session.token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: CONFIG.SESSION_EXPIRY_HOURS * 60 * 60 * 1000
        });

        // Redirect to OAuth callback page with email info
        const callbackUrl = `/oauth-callback.html`;
        res.redirect(`${callbackUrl}?auth=success&provider=google&email=${encodeURIComponent(profile.email)}`);
    } catch (error) {
        console.error('[Auth] Google OAuth callback error:', error.message);
        const callbackUrl = `/oauth-callback.html`;
        res.redirect(`${callbackUrl}?error=oauth_failed&provider=google`);
    }
});

// ============================================================================
// OAUTH2 AUTHENTICATION - MICROSOFT
// ============================================================================

/**
 * GET /api/auth/microsoft
 * Initiate Microsoft OAuth
 */
router.get('/microsoft', (req, res) => {
    try {
        // Check if Microsoft OAuth is configured
        if (!process.env.MICROSOFT_CLIENT_ID || !process.env.MICROSOFT_CLIENT_SECRET) {
            console.warn('[Auth] Microsoft OAuth not configured - MICROSOFT_CLIENT_ID or MICROSOFT_CLIENT_SECRET missing');
            return res.status(503).json({ 
                error: 'Microsoft OAuth is not configured. Please set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET in your .env file.' 
            });
        }
        
        const clientId = process.env.MICROSOFT_CLIENT_ID;
        const tenantId = process.env.MICROSOFT_TENANT_ID || 'common';
        const redirectUri = process.env.MICROSOFT_REDIRECT_URI || 'http://localhost:3001/api/auth/microsoft/callback';
        
        const scopes = [
            'openid',
            'profile',
            'email',
            'https://outlook.office.com/Mail.Read',
            'https://outlook.office.com/Mail.Send',
            'https://outlook.office.com/Calendars.ReadWrite',
            'offline_access'
        ];

        const msState_0 = crypto.randomBytes(16).toString('hex');
        oauthStateMap.set(msState_0, req.query.redirectUrl || '/');
        setTimeout(() => oauthStateMap.delete(msState_0), 600000);
        const authUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?` +
            `client_id=${clientId}` +
            `&response_type=code` +
            `&redirect_uri=${encodeURIComponent(redirectUri)}` +
            `&scope=${encodeURIComponent(scopes.join(' '))}` +
            `&response_mode=query` +
            `&state=${msState_0}`;

        res.json({ authUrl });
    } catch (error) {
        console.error('[Auth] Microsoft OAuth init error:', error.message);
        res.status(500).json({ error: 'Failed to initiate Microsoft OAuth' });
    }
});

// Outlook alias - redirects to Microsoft OAuth
router.get('/outlook', (req, res) => {
    // Use same logic as /microsoft
    if (!process.env.MICROSOFT_CLIENT_ID || !process.env.MICROSOFT_CLIENT_SECRET) {
        return res.status(503).json({ 
            error: 'Microsoft OAuth is not configured. Please set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET in your .env file.' 
        });
    }
    const clientId = process.env.MICROSOFT_CLIENT_ID;
    const tenantId = process.env.MICROSOFT_TENANT_ID || 'common';
    const redirectUri = process.env.MICROSOFT_REDIRECT_URI || 'http://localhost:3001/api/auth/microsoft/callback';
    
    const scopes = [
        'openid', 'profile', 'email',
        'https://outlook.office.com/Mail.Read',
        'https://outlook.office.com/Mail.Send',
        'https://outlook.office.com/Calendars.ReadWrite',
        'offline_access'
    ];

        const msState_1 = crypto.randomBytes(16).toString('hex');
        oauthStateMap.set(msState_1, req.query.redirectUrl || '/');
        setTimeout(() => oauthStateMap.delete(msState_1), 600000);
    const authUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?` +
        `client_id=${clientId}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&scope=${encodeURIComponent(scopes.join(' '))}` +
        `&response_mode=query` +
        `&state=${msState_1}`;

    res.json({ authUrl });
});

// Office365 alias - redirects to Microsoft OAuth  
router.get('/office365', (req, res) => {
    // Same as /outlook
    if (!process.env.MICROSOFT_CLIENT_ID || !process.env.MICROSOFT_CLIENT_SECRET) {
        return res.status(503).json({ 
            error: 'Microsoft OAuth is not configured. Please set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET in your .env file.' 
        });
    }
    const clientId = process.env.MICROSOFT_CLIENT_ID;
    const tenantId = process.env.MICROSOFT_TENANT_ID || 'common';
    const redirectUri = process.env.MICROSOFT_REDIRECT_URI || 'http://localhost:3001/api/auth/microsoft/callback';
    
    const scopes = [
        'openid', 'profile', 'email',
        'https://outlook.office.com/Mail.Read',
        'https://outlook.office.com/Mail.Send',
        'https://outlook.office.com/Calendars.ReadWrite',
        'offline_access'
    ];

        const msState_2 = crypto.randomBytes(16).toString('hex');
        oauthStateMap.set(msState_2, req.query.redirectUrl || '/');
        setTimeout(() => oauthStateMap.delete(msState_2), 600000);
    const authUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?` +
        `client_id=${clientId}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&scope=${encodeURIComponent(scopes.join(' '))}` +
        `&response_mode=query` +
        `&state=${msState_2}`;

    res.json({ authUrl });
});

/**
 * GET /api/auth/microsoft/callback
 * Microsoft OAuth callback
 */
router.get('/microsoft/callback', async (req, res) => {
    try {
        const { code, state } = req.query;

        // Check if request is from an iframe - allow framing for same-origin scenarios
        // This fixes the "Unsafe attempt to load URL" error when OAuth callback
        // is loaded in a same-origin iframe (like the Horizon browser)
        const referer = req.headers.referer || '';
        const isFromSameOrigin = referer.includes('localhost:3001') || referer === '';
        
        if (isFromSameOrigin) {
            // Allow the callback to be framed within the same origin
            // Remove any existing X-Frame-Options that would block iframes
            res.removeHeader('X-Frame-Options');
            res.setHeader('X-Frame-Options', 'ALLOW-FROM http://localhost:3001');
            // Also update CSP frame-ancestors
            res.setHeader('Content-Security-Policy', "frame-ancestors 'self' http://localhost:3001");
        }
        
        if (!code) {
            return res.redirect(`/oauth-callback.html?error=no_code&provider=microsoft`);
        }

        const clientId = process.env.MICROSOFT_CLIENT_ID;
        const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
        const tenantId = process.env.MICROSOFT_TENANT_ID || 'common';
        const redirectUri = process.env.MICROSOFT_REDIRECT_URI || 'http://localhost:3001/api/auth/microsoft/callback';

        // Exchange code for tokens
        const tokenResponse = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                code,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code',
                scope: 'openid profile email https://outlook.office.com/Mail.Read https://outlook.office.com/Mail.Send https://outlook.office.com/Calendars.ReadWrite offline_access'
            })
        });

        const tokens = await tokenResponse.json();

        if (tokens.error) {
            console.error('[Auth] Microsoft token error:', tokens.error_description);
            return res.redirect(`/oauth-callback.html?error=${encodeURIComponent(tokens.error_description)}&provider=microsoft`);
        }

        // Get user info
        const userResponse = await fetch('https://graph.microsoft.com/v1.0/me', {
            headers: { Authorization: `Bearer ${tokens.access_token}` }
        });

        const userInfo = await userResponse.json();
        console.log('[Auth] Microsoft user info:', JSON.stringify(userInfo));
        
        // Ensure we have an email
        const email = userInfo.mail || userInfo.userPrincipalName;
        if (!email) {
            console.error('[Auth] No email from Microsoft Graph:', userInfo);
            return res.redirect(`/oauth-callback.html?error=no_email&provider=microsoft`);
        }
        
        // Create or update user
        const profile = {
            id: userInfo.id,
            email: email,
            displayName: userInfo.displayName
        };

        const result = await AuthService.oauthLogin({
            provider: 'microsoft',
            profile: {
                ...profile,
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token,
                expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString()
            },
            deviceInfo: req.headers['user-agent'],
            ipAddress: req.ip
        });

        // Store OAuth tokens
        OAuthTokens.store({
            userId: result.user.id,
            provider: 'microsoft',
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
            scope: tokens.scope
        });

        // Set session cookie
        res.cookie('sessionToken', result.session.token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: CONFIG.SESSION_EXPIRY_HOURS * 60 * 60 * 1000
        });

        // Redirect to OAuth callback page with email info
        const callbackUrl = `/oauth-callback.html`;
        res.redirect(`${callbackUrl}?auth=success&provider=microsoft&email=${encodeURIComponent(profile.email)}`);
    } catch (error) {
        console.error('[Auth] Microsoft OAuth callback error:', error.message);
        res.redirect(`/oauth-callback.html?error=oauth_failed&provider=microsoft`);
    }
});

/**
 * POST /api/auth/oauth/complete
 * Complete OAuth flow (for frontend to receive tokens)
 */
router.post('/oauth/complete', authenticateSession, async (req, res) => {
    try {
        const { provider } = req.body;

        if (!provider) {
            return res.status(400).json({ error: 'Provider required' });
        }

        const tokens = OAuthTokens.get(req.user.id, provider);

        if (!tokens) {
            return res.status(404).json({ error: 'No OAuth tokens found for this provider' });
        }

        res.json({
            provider: tokens.provider,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: tokens.expiresAt,
            scope: tokens.scope
        });
    } catch (error) {
        console.error('[Auth] OAuth complete error:', error.message);
        res.status(500).json({ error: 'Failed to complete OAuth flow' });
    }
});

// ============================================================================
// APP PASSWORDS
// ============================================================================

/**
 * POST /api/auth/app-password
 * Create app-specific password
 */
router.post('/app-password', authenticateSession, async (req, res) => {
    try {
        const { name } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'Password name required' });
        }

        const appPassword = await AppPassword.create({
            userId: req.user.id,
            name
        });

        res.status(201).json({
            message: 'App password created',
            password: {
                id: appPassword.id,
                name: appPassword.name,
                password: appPassword.password, // Only returned once!
                createdAt: appPassword.createdAt
            }
        });
    } catch (error) {
        console.error('[Auth] App password creation error:', error.message);
        res.status(500).json({ error: 'Failed to create app password' });
    }
});

/**
 * GET /api/auth/app-passwords
 * List app passwords
 */
router.get('/app-passwords', authenticateSession, async (req, res) => {
    try {
        const passwords = AppPassword.list(req.user.id);
        res.json({ passwords });
    } catch (error) {
        console.error('[Auth] App passwords list error:', error.message);
        res.status(500).json({ error: 'Failed to list app passwords' });
    }
});

/**
 * DELETE /api/auth/app-password/:id
 * Delete app password
 */
router.delete('/app-password/:id', authenticateSession, async (req, res) => {
    try {
        AppPassword.delete(req.params.id, req.user.id);
        res.json({ message: 'App password deleted' });
    } catch (error) {
        console.error('[Auth] App password deletion error:', error.message);
        res.status(500).json({ error: 'Failed to delete app password' });
    }
});

// ============================================================================
// SESSION MANAGEMENT
// ============================================================================

/**
 * GET /api/auth/sessions
 * Get all user sessions
 */
router.get('/sessions', authenticateSession, async (req, res) => {
    try {
        const sessions = AuthService.getSessions(req.user.id);
        res.json({ sessions });
    } catch (error) {
        console.error('[Auth] Get sessions error:', error.message);
        res.status(500).json({ error: 'Failed to get sessions' });
    }
});

/**
 * DELETE /api/auth/sessions/:sessionId
 * Revoke specific session
 */
router.delete('/sessions/:sessionId', authenticateSession, async (req, res) => {
    try {
        await AuthService.revokeSession(req.user.id, req.params.sessionId);
        res.json({ message: 'Session revoked' });
    } catch (error) {
        console.error('[Auth] Revoke session error:', error.message);
        res.status(500).json({ error: 'Failed to revoke session' });
    }
});

/**
 * DELETE /api/auth/sessions
 * Revoke all sessions
 */
router.delete('/sessions', authenticateSession, async (req, res) => {
    try {
        await AuthService.revokeAllSessions(req.user.id);
        res.json({ message: 'All sessions revoked' });
    } catch (error) {
        console.error('[Auth] Revoke all sessions error:', error.message);
        res.status(500).json({ error: 'Failed to revoke sessions' });
    }
});

// ============================================================================
// PROVIDERS
// ============================================================================

/**
 * GET /api/auth/providers
 * Get available auth providers
 */
router.get('/providers', (req, res) => {
    try {
        const providers = [];

        // Google OAuth
        if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
            providers.push({
                id: 'google',
                name: 'Google',
                type: 'oauth',
                icon: 'google',
                scopes: [
                    'https://www.googleapis.com/auth/userinfo.email',
                    'https://www.googleapis.com/auth/userinfo.profile',
                    'https://mail.google.com/',
                    'https://www.googleapis.com/auth/gmail.readonly',
                    'https://www.googleapis.com/auth/gmail.send',
                    'https://www.googleapis.com/auth/calendar',
                    'https://www.googleapis.com/auth/calendar.events'
                ]
            });
        }

        // Microsoft OAuth
        if (process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET) {
            providers.push({
                id: 'microsoft',
                name: 'Microsoft',
                type: 'oauth',
                icon: 'microsoft',
                scopes: [
                    'openid',
                    'profile',
                    'email',
                    'https://outlook.office.com/Mail.Read',
                    'https://outlook.office.com/Mail.Send',
                    'https://outlook.office.com/Calendars.ReadWrite'
                ]
            });
        }

        // Local authentication (always available if not disabled)
        if (process.env.DISABLE_LOCAL_AUTH !== 'true') {
            providers.push({
                id: 'local',
                name: 'Email & Password',
                type: 'local',
                icon: 'email'
            });
        }

        // App passwords (always available for users with password)
        providers.push({
            id: 'app-password',
            name: 'App Password',
            type: 'app-password',
            icon: 'key',
            description: 'Use for apps that don\'t support OAuth'
        });

        res.json({ providers });
    } catch (error) {
        console.error('[Auth] Get providers error:', error.message);
        res.status(500).json({ error: 'Failed to get providers' });
    }
});

// ============================================================================
// USER PROFILE
// ============================================================================

/**
 * GET /api/auth/me
 * Get current user profile
 */
router.get('/me', authenticateSession, async (req, res) => {
    try {
        const user = User.findById(req.user.id);
        res.json({ user });
    } catch (error) {
        console.error('[Auth] Get profile error:', error.message);
        res.status(500).json({ error: 'Failed to get profile' });
    }
});

/**
 * PUT /api/auth/me
 * Update current user profile
 */
router.put('/me', authenticateSession, async (req, res) => {
    try {
        const { displayName, settings } = req.body;

        if (displayName) {
            const stmt = require('better-sqlite3')(require('path').join(__dirname, 'data', 'novabyte.db'))
                .prepare('UPDATE users SET displayName = ? WHERE id = ?');
            stmt.run(displayName, req.user.id);
        }

        if (settings) {
            User.updateSettings(req.user.id, settings);
        }

        const user = User.findById(req.user.id);
        res.json({ user });
    } catch (error) {
        console.error('[Auth] Update profile error:', error.message);
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

module.exports = router;