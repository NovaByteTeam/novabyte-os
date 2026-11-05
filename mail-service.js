/**
 * NovaByte Bridge - Mail Service Layer
 * Core component handling IMAP/SMTP connections for email operations
 */

const imap = require('imap-simple');
const nodemailer = require('nodemailer');
const { Readable } = require('stream');
const fs = require('fs');
const path = require('path');

// Load provider configurations
let providers = [];
try {
    providers = require('./providers.json');
} catch (error) {
    console.error('[MailService] Failed to load providers:', error.message);
}

/**
 * MailService - Core class for handling IMAP/SMTP email operations
 */
class MailService {
    constructor(options = {}) {
        this.connections = new Map(); // Connection pool: accountId -> imap connection
        this.smtpTransports = new Map(); // SMTP transports: accountId -> transporter
        this.tokenCache = new Map(); // Token cache: accountId -> tokens
        
        this.config = {
            connectionTimeout: options.connectionTimeout || 60000,
            imapTimeout: options.imapTimeout || 120000,
            smtpTimeout: options.smtpTimeout || 60000,
            maxConnectionsPerAccount: options.maxConnectionsPerAccount || 1,
            tokenRefreshBuffer: options.tokenRefreshBuffer || 300000, // 5 minutes before expiry
            ...options
        };
        
        this.logger = options.logger || {
            info: (msg, ...args) => console.log(`[MailService] ${msg}`, ...args),
            error: (msg, ...args) => console.error(`[MailService] ERROR: ${msg}`, ...args),
            debug: (msg, ...args) => process.env.DEBUG && console.log(`[MailService] DEBUG: ${msg}`, ...args)
        };
    }

    /**
     * Get provider configuration by provider ID
     * @param {string} providerId - Provider identifier
     * @returns {object|null} Provider configuration
     */
    getProvider(providerId) {
        return providers.find(p => p.id === providerId) || null;
    }

    /**
     * Validate account before connecting
     * @param {object} account - Account configuration
     * @returns {object} Validation result { valid: boolean, error?: string }
     */
    validateAccount(account) {
        const errors = [];
        
        if (!account) {
            return { valid: false, error: 'Account is required' };
        }
        
        if (!account.email && !account.emailAddress) {
            errors.push('Email address is required');
        }
        
        if (!account.providerId) {
            errors.push('Provider ID is required');
        }
        
        // Get provider configuration
        const provider = this.getProvider(account.providerId);
        if (!provider) {
            errors.push(`Unknown provider: ${account.providerId}`);
        }
        
        // Check authentication method
        const authMethod = account.authMethod || 'password';
        
        if (authMethod === 'oauth2') {
            if (!account.accessToken) {
                errors.push('OAuth2 access token is required');
            }
            if (provider && !provider.oauth_supported) {
                errors.push(`Provider ${provider.name} does not support OAuth2`);
            }
        } else if (authMethod === 'app_password') {
            if (!account.password) {
                errors.push('App password is required');
            }
            if (provider && provider.oauth_supported && !provider.app_password_required) {
                this.logger.info(`Provider ${provider.name} supports OAuth2, consider using it for better security`);
            }
        } else if (authMethod === 'password') {
            if (!account.password) {
                errors.push('Password is required');
            }
            if (provider && provider.oauth_supported) {
                this.logger.info(`Provider ${provider.name} supports OAuth2, consider using it for better security`);
            }
        }
        
        // Validate custom provider settings
        if (account.providerId === 'custom') {
            if (!account.imapHost) {
                errors.push('IMAP host is required for custom provider');
            }
            if (!account.smtpHost) {
                errors.push('SMTP host is required for custom provider');
            }
        }
        
        return {
            valid: errors.length === 0,
            error: errors.length > 0 ? errors.join('; ') : null
        };
    }

    /**
     * Build IMAP connection configuration
     * @param {object} account - Account configuration
     * @returns {object} IMAP connection config
     */
    getConnectionString(account) {
        const provider = this.getProvider(account.providerId) || {};
        
        const config = {
            user: account.email || account.emailAddress,
            password: account.password || '',
            host: account.imapHost || provider.imap_host || '',
            port: parseInt(account.imapPort) || provider.imap_port || 993,
            tls: account.imapSsl !== undefined ? account.imapSsl : (provider.imap_ssl !== undefined ? provider.imap_ssl : true),
            tlsOptions: {
                rejectUnauthorized: true,
                ...(account.tlsOptions || {})
            },
            connTimeout: this.config.connectionTimeout,
            authTimeout: this.config.imapTimeout,
            keepalive: {
                interval: 30000,
                idleInterval: 180000,
                forceNoop: true
            }
        };
        
        // Handle OAuth2 authentication
        if (account.authMethod === 'oauth2' && account.accessToken) {
            // For OAuth2, we need to use XOAuth2 mechanism
            // imap-simple doesn't natively support OAuth2, so we'll handle it differently
            config.password = account.accessToken;
            config.xoauth2 = true;
        }
        
        return config;
    }

    /**
     * Build SMTP transport configuration
     * @param {object} account - Account configuration
     * @returns {object} SMTP transport config
     */
    getSmtpConfig(account) {
        const provider = this.getProvider(account.providerId) || {};
        
        const config = {
            host: account.smtpHost || provider.smtp_host || '',
            port: parseInt(account.smtpPort) || provider.smtp_port || 587,
            secure: account.smtpSsl !== undefined ? account.smtpSsl : (provider.smtp_ssl !== undefined ? provider.smtp_ssl : false),
            tls: {
                rejectUnauthorized: true,
                ...(account.tlsOptions || {})
            },
            timeout: this.config.smtpTimeout,
            maxConnections: this.config.maxConnectionsPerAccount
        };
        
        // Configure authentication based on method
        if (account.authMethod === 'oauth2' && account.accessToken) {
            config.auth = {
                type: 'OAuth2',
                user: account.email || account.emailAddress,
                accessToken: account.accessToken,
                refreshToken: account.refreshToken,
                expires: account.tokenExpiry,
                clientId: account.oauthClientId,
                clientSecret: account.oauthClientSecret
            };
        } else {
            config.auth = {
                user: account.email || account.emailAddress,
                pass: account.password || ''
            };
        }
        
        return config;
    }

    /**
     * Connect to IMAP server
     * @param {string} accountId - Account identifier
     * @param {object} account - Account configuration
     * @returns {Promise<object>} Connection object
     */
    async connect(accountId, account) {
        // Validate account first
        const validation = this.validateAccount(account);
        if (!validation.valid) {
            throw new Error(`Account validation failed: ${validation.error}`);
        }
        
        // Check if already connected
        if (this.connections.has(accountId)) {
            const existingConnection = this.connections.get(accountId);
            try {
                // Test if connection is still alive
                await this.testConnection(existingConnection);
                this.logger.info(`[${accountId}] Using existing IMAP connection`);
                return existingConnection;
            } catch (error) {
                // Connection is dead, remove it
                this.logger.info(`[${accountId}] Existing connection dead, reconnecting`);
                await this.disconnect(accountId);
            }
        }
        
        try {
            // Refresh OAuth2 token if needed
            if (account.authMethod === 'oauth2') {
                account = await this.refreshTokenIfNeeded(accountId, account);
            }
            
            const imapConfig = this.getConnectionString(account);
            
            this.logger.info(`[${accountId}] Connecting to IMAP: ${imapConfig.host}:${imapConfig.port}`);
            
            const connection = await imap.connect({
                imap: imapConfig,
                onmail: () => {} // Disable automatic notifications
            });
            
            // Open INBOX by default
            await connection.openBox('INBOX');
            
            // Store connection in pool
            this.connections.set(accountId, connection);
            
            // Set up connection error handler
            connection.on('error', async (err) => {
                this.logger.error(`[${accountId}] IMAP connection error:`, err.message);
                this.connections.delete(accountId);
            });
            
            this.logger.info(`[${accountId}] IMAP connected successfully`);
            
            return connection;
        } catch (error) {
            this.logger.error(`[${accountId}] Failed to connect to IMAP:`, error.message);
            throw new Error(`IMAP connection failed: ${error.message}`);
        }
    }

    /**
     * Test if connection is still alive
     * @param {object} connection - IMAP connection
     * @returns {Promise<boolean>} True if alive
     */
    async testConnection(connection) {
        try {
            await connection.openBox('INBOX');
            return true;
        } catch (error) {
            throw error;
        }
    }

    /**
     * Disconnect from IMAP server
     * @param {string} accountId - Account identifier
     * @returns {Promise<void>}
     */
    async disconnect(accountId) {
        const connection = this.connections.get(accountId);
        
        if (connection) {
            try {
                await connection.end();
                this.logger.info(`[${accountId}] IMAP disconnected`);
            } catch (error) {
                this.logger.error(`[${accountId}] Error disconnecting:`, error.message);
            } finally {
                this.connections.delete(accountId);
            }
        }
        
        // Also close SMTP transport if exists
        const transporter = this.smtpTransports.get(accountId);
        if (transporter) {
            try {
                transporter.close();
                this.logger.info(`[${accountId}] SMTP transporter closed`);
            } catch (error) {
                this.logger.error(`[${accountId}] Error closing SMTP:`, error.message);
            } finally {
                this.smtpTransports.delete(accountId);
            }
        }
    }

    /**
     * Fetch emails from inbox with pagination
     * @param {string} accountId - Account identifier
     * @param {object} account - Account configuration
     * @param {object} options - Fetch options
     * @returns {Promise<array>} Array of email messages
     */
    async fetchInbox(accountId, account, options = {}) {
        const connection = await this.connect(accountId, account);
        
        const {
            page = 1,
            pageSize = 25,
            since,
            before,
            from,
            to,
            subject,
            unreadOnly = false,
            attachments = false
        } = options;
        
        const searchCriteria = [];
        
        // Date filters
        if (since) {
            searchCriteria.push(['SINCE', since]);
        }
        if (before) {
            searchCriteria.push(['BEFORE', before]);
        }
        
        // Sender/Recipient filters
        if (from) {
            searchCriteria.push(['FROM', from]);
        }
        if (to) {
            searchCriteria.push(['TO', to]);
        }
        
        // Subject filter
        if (subject) {
            searchCriteria.push(['SUBJECT', subject]);
        }
        
        // Unread filter
        if (unreadOnly) {
            searchCriteria.push(['UNSEEN']);
        } else {
            searchCriteria.push(['ALL']);
        }
        
        try {
            // Calculate offset
            const start = (page - 1) * pageSize;
            
            // Fetch messages
            const messages = await connection.search(searchCriteria, {
                bodies: ['HEADER', 'TEXT'],
                markSeen: false,
                struct: true
            });
            
            // Reverse to get newest first (IMAP returns oldest first)
            const sortedMessages = messages.reverse();
            
            // Paginate
            const paginatedMessages = sortedMessages.slice(start, start + pageSize);
            
            // Parse messages
            const parsedMessages = await Promise.all(
                paginatedMessages.map(msg => this.parseEmailMessage(msg, { includeAttachments: attachments }))
            );
            
            return {
                messages: parsedMessages,
                total: messages.length,
                page,
                pageSize,
                totalPages: Math.ceil(messages.length / pageSize)
            };
        } catch (error) {
            this.logger.error(`[${accountId}] Failed to fetch inbox:`, error.message);
            throw new Error(`Failed to fetch inbox: ${error.message}`);
        }
    }

    /**
     * Fetch full email by ID
     * @param {string} accountId - Account identifier
     * @param {object} account - Account configuration
     * @param {string} messageId - Message UID
     * @returns {Promise<object>} Parsed email message
     */
    async fetchEmail(accountId, account, messageId) {
        const connection = await this.connect(accountId, account);
        
        try {
            // Fetch the specific message
            const messages = await connection.search([['UID', messageId]], {
                bodies: ['HEADER', 'TEXT', ''],
                markSeen: false,
                struct: true
            });
            
            if (messages.length === 0) {
                throw new Error('Message not found');
            }
            
            const parsedMessage = await this.parseEmailMessage(messages[0], {
                includeAttachments: true,
                includeRaw: true
            });
            
            return parsedMessage;
        } catch (error) {
            this.logger.error(`[${accountId}] Failed to fetch email ${messageId}:`, error.message);
            throw new Error(`Failed to fetch email: ${error.message}`);
        }
    }

    /**
     * Get all available folders
     * @param {string} accountId - Account identifier
     * @param {object} account - Account configuration
     * @returns {Promise<array>} Array of folder objects
     */
    async getFolders(accountId, account) {
        const connection = await this.connect(accountId, account);
        
        try {
            const boxInfo = await connection.getBoxes();
            const folders = this.parseFolders(boxInfo);
            
            return folders;
        } catch (error) {
            this.logger.error(`[${accountId}] Failed to get folders:`, error.message);
            throw new Error(`Failed to get folders: ${error.message}`);
        }
    }

    /**
     * Parse folder structure from IMAP response
     * @param {object} boxes - IMAP boxes response
     * @param {string} prefix - Folder prefix for nested folders
     * @returns {array} Flattened folder array
     */
    parseFolders(boxes, prefix = '') {
        const folders = [];
        
        for (const [name, info] of Object.entries(boxes)) {
            const fullPath = prefix ? `${prefix}${name}` : name;
            
            folders.push({
                name: fullPath,
                path: fullPath,
                delimiter: info.delimiter || '/',
                children: info.children ? Object.keys(info.children) : [],
                attributes: info.attributes || [],
                specialUse: this.getSpecialUse(name)
            });
            
            if (info.children) {
                const childFolders = this.parseFolders(info.children, fullPath + (info.delimiter || '/'));
                folders.push(...childFolders);
            }
        }
        
        return folders;
    }

    /**
     * Determine special use for common folder names
     * @param {string} name - Folder name
     * @returns {string|null} Special use identifier
     */
    getSpecialUse(name) {
        const lowerName = name.toLowerCase();
        
        if (lowerName === 'inbox') return 'inbox';
        if (lowerName === 'sent' || lowerName === '[sent]' || lowerName === 'sent mail') return 'sent';
        if (lowerName === 'drafts' || lowerName === '[drafts]') return 'drafts';
        if (lowerName === 'trash' || lowerName === '[trash]' || lowerName === 'deleted') return 'trash';
        if (lowerName === 'spam' || lowerName === 'junk' || lowerName === '[spam]') return 'spam';
        if (lowerName === 'archive' || lowerName === '[archive]') return 'archive';
        
        return null;
    }

    /**
     * Sync a specific folder
     * @param {string} accountId - Account identifier
     * @param {object} account - Account configuration
     * @param {string} folderName - Folder name to sync
     * @returns {Promise<object>} Sync result
     */
    async syncFolder(accountId, account, folderName) {
        const connection = await this.connect(accountId, account);
        
        try {
            // Open the specified folder
            await connection.openBox(folderName);
            
            // Get folder status
            const boxStatus = await connection.status(folderName, ['UNSEEN', 'MESSAGES', 'RECENT']);
            
            // Fetch recent messages (last 100)
            const messages = await connection.search(['ALL'], {
                bodies: ['HEADER', 'TEXT'],
                markSeen: false,
                struct: true
            });
            
            // Parse messages
            const parsedMessages = await Promise.all(
                messages.slice(0, 100).map(msg => this.parseEmailMessage(msg, { includeAttachments: false }))
            );
            
            return {
                folder: folderName,
                totalMessages: boxStatus.messages || 0,
                unreadMessages: boxStatus.unseen || 0,
                recentMessages: boxStatus.recent || 0,
                synced: parsedMessages.length,
                messages: parsedMessages
            };
        } catch (error) {
            this.logger.error(`[${accountId}] Failed to sync folder ${folderName}:`, error.message);
            throw new Error(`Failed to sync folder: ${error.message}`);
        }
    }

    /**
     * Search emails with custom query
     * @param {string} accountId - Account identifier
     * @param {object} account - Account configuration
     * @param {object} query - Search query
     * @returns {Promise<array>} Array of matching messages
     */
    async search(accountId, account, query = {}) {
        const connection = await this.connect(accountId, account);
        
        const {
            text,
            from,
            to,
            cc,
            bcc,
            subject,
            body,
            since,
            before,
            on,
            sentSince,
            sentBefore,
            sentOn,
            unread,
            answered,
            flagged,
            deleted,
            draft,
            largerThan,
            smallerThan,
            uidRange,
            emailId
        } = query;
        
        const searchCriteria = [];
        
        // Text search (searches in FROM, TO, SUBJECT, BODY)
        if (text) {
            searchCriteria.push(['TEXT', text]);
        }
        
        // From/To/Cc/Bcc
        if (from) searchCriteria.push(['FROM', from]);
        if (to) searchCriteria.push(['TO', to]);
        if (cc) searchCriteria.push(['CC', cc]);
        if (bcc) searchCriteria.push(['BCC', bcc]);
        
        // Subject
        if (subject) searchCriteria.push(['SUBJECT', subject]);
        
        // Body search (requires BODY extension)
        if (body) searchCriteria.push(['BODY', body]);
        
        // Date filters (received)
        if (since) searchCriteria.push(['SINCE', since]);
        if (before) searchCriteria.push(['BEFORE', before]);
        if (on) searchCriteria.push(['ON', on]);
        
        // Date filters (sent)
        if (sentSince) searchCriteria.push(['SENTSINCE', sentSince]);
        if (sentBefore) searchCriteria.push(['SENTBEFORE', sentBefore]);
        if (sentOn) searchCriteria.push(['SENTON', sentOn]);
        
        // Flag filters
        if (unread) searchCriteria.push(['UNSEEN']);
        if (answered) searchCriteria.push(['ANSWERED']);
        if (flagged) searchCriteria.push(['FLAGGED']);
        if (deleted) searchCriteria.push(['DELETED']);
        if (draft) searchCriteria.push(['DRAFT']);
        
        // Size filters
        if (largerThan) searchCriteria.push(['LARGER', largerThan]);
        if (smallerThan) searchCriteria.push(['SMALLER', smallerThan]);
        
        // UID range
        if (uidRange) {
            const [start, end] = uidRange.split(':');
            searchCriteria.push(['UID', `${start}:${end}`]);
        }
        
        // Specific message ID
        if (emailId) {
            searchCriteria.push(['UID', emailId]);
        }
        
        // Default to ALL if no criteria
        if (searchCriteria.length === 0) {
            searchCriteria.push(['ALL']);
        }
        
        try {
            const messages = await connection.search(searchCriteria, {
                bodies: ['HEADER', 'TEXT'],
                markSeen: false,
                struct: true
            });
            
            // Parse messages
            const parsedMessages = await Promise.all(
                messages.map(msg => this.parseEmailMessage(msg, { includeAttachments: false }))
            );
            
            return {
                total: messages.length,
                messages: parsedMessages
            };
        } catch (error) {
            this.logger.error(`[${accountId}] Search failed:`, error.message);
            throw new Error(`Search failed: ${error.message}`);
        }
    }

    /**
     * Move emails to a specific folder
     * @param {string} accountId - Account identifier
     * @param {object} account - Account configuration
     * @param {array} messageIds - Array of message UIDs
     * @param {string} targetFolder - Target folder name
     * @returns {Promise<object>} Move result
     */
    async moveToFolder(accountId, account, messageIds, targetFolder) {
        const connection = await this.connect(accountId, account);
        
        if (!Array.isArray(messageIds) || messageIds.length === 0) {
            throw new Error('Message IDs array is required');
        }
        
        try {
            // Ensure target folder exists
            await connection.openBox(targetFolder);
            
            // Move messages
            const result = await connection.move(messageIds, targetFolder);
            
            this.logger.info(`[${accountId}] Moved ${messageIds.length} messages to ${targetFolder}`);
            
            return {
                success: true,
                moved: messageIds.length,
                targetFolder,
                result
            };
        } catch (error) {
            this.logger.error(`[${accountId}] Failed to move messages:`, error.message);
            throw new Error(`Failed to move messages: ${error.message}`);
        }
    }

    /**
     * Send email via SMTP
     * @param {string} accountId - Account identifier
     * @param {object} account - Account configuration
     * @param {object} emailData - Email data to send
     * @returns {Promise<object>} Send result
     */
    async sendMessage(accountId, account, emailData) {
        const {
            from,
            to,
            cc,
            bcc,
            subject,
            text,
            html,
            attachments,
            inReplyTo,
            references,
            headers
        } = emailData;
        
        // Validate required fields
        if (!to && !cc && !bcc) {
            throw new Error('At least one recipient (to, cc, or bcc) is required');
        }
        
        if (!subject) {
            throw new Error('Subject is required');
        }
        
        try {
            // Refresh OAuth2 token if needed
            if (account.authMethod === 'oauth2') {
                account = await this.refreshTokenIfNeeded(accountId, account);
            }
            
            // Get or create SMTP transporter
            let transporter = this.smtpTransports.get(accountId);
            
            if (!transporter) {
                const smtpConfig = this.getSmtpConfig(account);
                transporter = nodemailer.createTransport(smtpConfig);
                this.smtpTransports.set(accountId, transporter);
            }
            
            // Verify connection
            try {
                await transporter.verify();
                this.logger.info(`[${accountId}] SMTP connection verified`);
            } catch (error) {
                // Try to recreate transport
                this.logger.info(`[${accountId}] Recreating SMTP transport`);
                const smtpConfig = this.getSmtpConfig(account);
                transporter = nodemailer.createTransport(smtpConfig);
                this.smtpTransports.set(accountId, transporter);
                await transporter.verify();
            }
            
            // Prepare email
            const mailOptions = {
                from: from || account.email || account.emailAddress,
                to: Array.isArray(to) ? to.join(', ') : to,
                cc: cc ? (Array.isArray(cc) ? cc.join(', ') : cc) : undefined,
                bcc: bcc ? (Array.isArray(bcc) ? bcc.join(', ') : bcc) : undefined,
                subject,
                text: text || '',
                html: html || '',
                inReplyTo,
                references,
                headers: headers || {},
                attachments: attachments ? this.formatAttachments(attachments) : undefined
            };
            
            // Send email
            const info = await transporter.sendMail(mailOptions);
            
            this.logger.info(`[${accountId}] Email sent: ${info.messageId}`);
            
            return {
                success: true,
                messageId: info.messageId,
                accepted: info.accepted,
                rejected: info.rejected,
                pending: info.pending
            };
        } catch (error) {
            this.logger.error(`[${accountId}] Failed to send email:`, error.message);
            throw new Error(`Failed to send email: ${error.message}`);
        }
    }

    /**
     * Format attachments for nodemailer
     * @param {array} attachments - Array of attachment objects
     * @returns {array} Formatted attachments
     */
    formatAttachments(attachments) {
        return attachments.map(att => {
            const formatted = {
                filename: att.filename || att.name || 'attachment',
                contentType: att.contentType || att.mimeType
            };
            
            // Handle different attachment sources
            if (att.path) {
                // File path
                formatted.path = att.path;
            } else if (att.content) {
                // Raw content
                if (att.encoding === 'base64') {
                    formatted.content = Buffer.from(att.content, 'base64');
                } else {
                    formatted.content = att.content;
                }
            } else if (att.url) {
                // URL - will be fetched
                formatted.path = att.url;
            }
            
            // CID for inline images
            if (att.cid) {
                formatted.cid = att.cid;
            }
            
            return formatted;
        });
    }

    // ==================== Token Management ====================

    /**
     * Check if token needs refresh
     * @param {object} account - Account with tokens
     * @returns {boolean} True if refresh needed
     */
    needsTokenRefresh(account) {
        if (!account.tokenExpiry) return false;
        
        const expiryTime = new Date(account.tokenExpiry).getTime();
        const currentTime = Date.now();
        const bufferTime = this.config.tokenRefreshBuffer;
        
        return (expiryTime - currentTime) < bufferTime;
    }

    /**
     * Refresh OAuth2 token if needed
     * @param {string} accountId - Account identifier
     * @param {object} account - Account with tokens
     * @returns {Promise<object>} Account with refreshed tokens
     */
    async refreshTokenIfNeeded(accountId, account) {
        if (account.authMethod !== 'oauth2') {
            return account;
        }
        
        if (!this.needsTokenRefresh(account)) {
            return account;
        }
        
        if (!account.refreshToken) {
            this.logger.warn(`[${accountId}] Token expired but no refresh token available`);
            throw new Error('OAuth2 token expired and no refresh token available');
        }
        
        try {
            const provider = this.getProvider(account.providerId);
            const oauthConfig = provider?.oauth_config || {};
            
            // Build token refresh request
            const tokenUrl = oauthConfig.token_endpoint || 'https://oauth2.googleapis.com/token';
            
            const params = new URLSearchParams({
                client_id: account.oauthClientId || process.env.OAUTH_CLIENT_ID,
                client_secret: account.oauthClientSecret || process.env.OAUTH_CLIENT_SECRET,
                refresh_token: account.refreshToken,
                grant_type: 'refresh_token'
            });
            
            this.logger.info(`[${accountId}] Refreshing OAuth2 token`);
            
            const response = await fetch(tokenUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: params.toString()
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Token refresh failed: ${errorText}`);
            }
            
            const tokenData = await response.json();
            
            // Update account tokens
            const updatedAccount = {
                ...account,
                accessToken: tokenData.access_token,
                tokenExpiry: tokenData.expires_in 
                    ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
                    : account.tokenExpiry,
                // Some providers return new refresh token
                refreshToken: tokenData.refresh_token || account.refreshToken
            };
            
            // Update cache
            this.tokenCache.set(accountId, {
                accessToken: updatedAccount.accessToken,
                refreshToken: updatedAccount.refreshToken,
                tokenExpiry: updatedAccount.tokenExpiry
            });
            
            this.logger.info(`[${accountId}] OAuth2 token refreshed successfully`);
            
            return updatedAccount;
        } catch (error) {
            this.logger.error(`[${accountId}] Token refresh failed:`, error.message);
            throw new Error(`Failed to refresh OAuth2 token: ${error.message}`);
        }
    }

    /**
     * Store tokens in cache
     * @param {string} accountId - Account identifier
     * @param {object} tokens - Token object
     */
    storeTokens(accountId, tokens) {
        this.tokenCache.set(accountId, {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            tokenExpiry: tokens.tokenExpiry
        });
    }

    /**
     * Get cached tokens
     * @param {string} accountId - Account identifier
     * @returns {object|null} Cached tokens
     */
    getTokens(accountId) {
        return this.tokenCache.get(accountId) || null;
    }

    /**
     * Clear cached tokens
     * @param {string} accountId - Account identifier
     */
    clearTokens(accountId) {
        this.tokenCache.delete(accountId);
    }

    // ==================== Email Parsing ====================

    /**
     * Parse email message from IMAP response
     * @param {object} message - Raw IMAP message
     * @param {object} options - Parsing options
     * @returns {Promise<object>} Parsed message
     */
    async parseEmailMessage(message, options = {}) {
        const { includeAttachments = false, includeRaw = false } = options;
        
        try {
            // Get headers
            const headers = message.HEADER;
            const body = message.TEXT;
            
            // Parse standard headers
            const parsed = {
                messageId: this.extractHeader(headers, 'message-id') || this.generateMessageId(),
                inReplyTo: this.extractHeader(headers, 'in-reply-to'),
                references: this.extractHeader(headers, 'references'),
                from: this.parseAddress(this.extractHeader(headers, 'from')),
                to: this.parseAddressList(this.extractHeader(headers, 'to')),
                cc: this.parseAddressList(this.extractHeader(headers, 'cc')),
                bcc: this.parseAddressList(this.extractHeader(headers, 'bcc')),
                subject: this.decodeSubject(this.extractHeader(headers, 'subject')),
                date: this.parseDate(this.extractHeader(headers, 'date')),
                priority: this.extractPriority(headers),
                flags: this.parseFlags(message.attributes ? message.attributes.flags : [])
            };
            
            // Get UID
            parsed.uid = message.attributes ? message.attributes.uid : null;
            parsed.emailId = parsed.uid; // For compatibility
            
            // Parse body content
            const bodyContent = await this.extractBody(message, body);
            parsed.text = bodyContent.text;
            parsed.html = bodyContent.html;
            
            // Parse attachments if requested
            if (includeAttachments && message.attributes && message.attributes.struct) {
                parsed.attachments = await this.parseAttachments(message);
            }
            
            // Include raw message if requested
            if (includeRaw) {
                parsed.raw = body;
            }
            
            return parsed;
        } catch (error) {
            this.logger.error('Failed to parse email message:', error.message);
            return {
                error: 'Failed to parse message',
                message: error.message
            };
        }
    }

    /**
     * Extract header value
     * @param {object} headers - Headers object
     * @param {string} name - Header name
     * @returns {string} Header value
     */
    extractHeader(headers, name) {
        if (!headers) return null;
        const value = headers[name.toLowerCase()];
        if (Array.isArray(value)) {
            return value[0];
        }
        return value || null;
    }

    /**
     * Parse email address
     * @param {string} address - Raw address string
     * @returns {object} Parsed address
     */
    parseAddress(address) {
        if (!address) return null;
        
        // Match format: "Name <email@example.com>" or just "email@example.com"
        const match = address.match(/^(?:["']?(.+?)["']?\s*)?<?(.+?)>?$/);
        
        if (match) {
            return {
                name: match[1] || '',
                address: match[2]
            };
        }
        
        return { name: '', address };
    }

    /**
     * Parse address list
     * @param {string} addressList - Raw address list
     * @returns {array} Array of parsed addresses
     */
    parseAddressList(addressList) {
        if (!addressList) return [];
        
        // Split by comma, handling quoted strings
        const addresses = [];
        let current = '';
        let inQuotes = false;
        
        for (const char of addressList) {
            if (char === '"') {
                inQuotes = !inQuotes;
                current += char;
            } else if (char === ',' && !inQuotes) {
                if (current.trim()) {
                    addresses.push(this.parseAddress(current.trim()));
                }
                current = '';
            } else {
                current += char;
            }
        }
        
        if (current.trim()) {
            addresses.push(this.parseAddress(current.trim()));
        }
        
        return addresses;
    }

    /**
     * Decode subject line
     * @param {string} subject - Encoded subject
     * @returns {string} Decoded subject
     */
    decodeSubject(subject) {
        if (!subject) return '';
        
        // Handle RFC 2047 encoding
        const encodedWordRegex = /=\?([^\?]+)\?([BQ])\?([^\?]+)\?=/gi;
        let decoded = subject;
        let match;
        
        while ((match = encodedWordRegex.exec(subject)) !== null) {
            const charset = match[1];
            const encoding = match[2].toUpperCase();
            const text = match[3];
            
            try {
                let decodedText;
                if (encoding === 'B') {
                    decodedText = Buffer.from(text, 'base64').toString(charset || 'utf-8');
                } else if (encoding === 'Q') {
                    decodedText = text.replace(/_/g, ' ');
                    decodedText = Buffer.from(decodedText, 'quoted-printable').toString(charset || 'utf-8');
                }
                decoded = decoded.replace(match[0], decodedText);
            } catch (e) {
                // Keep original if decode fails
            }
        }
        
        return decoded;
    }

    /**
     * Parse date header
     * @param {string} dateStr - Date string
     * @returns {string} ISO date string
     */
    parseDate(dateStr) {
        if (!dateStr) return null;
        
        try {
            const date = new Date(dateStr);
            if (isNaN(date.getTime())) {
                return dateStr; // Return original if parsing fails
            }
            return date.toISOString();
        } catch {
            return dateStr;
        }
    }

    /**
     * Extract priority from headers
     * @param {object} headers - Headers object
     * @returns {string} Priority level
     */
    extractPriority(headers) {
        const priority = this.extractHeader(headers, 'x-priority') || 
                         this.extractHeader(headers, 'priority');
        
        if (!priority) return 'normal';
        
        const priorityNum = parseInt(priority);
        if (priorityNum <= 1 || priorityNum === 'high') return 'high';
        if (priorityNum >= 5 || priorityNum === 'low') return 'low';
        return 'normal';
    }

    /**
     * Parse IMAP flags
     * @param {array} flags - Array of flags
     * @returns {object} Parsed flags
     */
    parseFlags(flags = []) {
        return {
            seen: flags.includes('\\Seen'),
            answered: flags.includes('\\Answered'),
            flagged: flags.includes('\\Flagged'),
            deleted: flags.includes('\\Deleted'),
            draft: flags.includes('\\Draft'),
            recent: flags.includes('\\Recent')
        };
    }

    /**
     * Extract body content from message
     * @param {object} message - IMAP message
     * @param {string} bodyText - Body text
     * @returns {Promise<object>} Text and HTML content
     */
    async extractBody(message, bodyText) {
        let text = '';
        let html = '';
        
        // Try to get from structure
        if (message.attributes && message.attributes.struct) {
            const struct = message.attributes.struct;
            
            // Find text/plain and text/html parts
            for (const part of struct) {
                if (part.type === 'text' && part.subtype === 'plain' && !text) {
                    text = await this.getPartBody(message, part);
                }
                if (part.type === 'text' && part.subtype === 'html' && !html) {
                    html = await this.getPartBody(message, part);
                }
            }
        }
        
        // Fallback to body text if not found
        if (!text && bodyText) {
            text = bodyText;
        }
        
        // Generate HTML from text if not available
        if (!html && text) {
            html = this.textToHtml(text);
        }
        
        return { text, html };
    }

    /**
     * Get body of specific message part
     * @param {object} message - IMAP message
     * @param {object} part - Part structure
     * @returns {Promise<string>} Part body
     */
    async getPartBody(message, part) {
        try {
            // For now, return empty if we can't get the specific part
            // In a full implementation, you'd fetch the specific part
            return '';
        } catch {
            return '';
        }
    }

    /**
     * Convert plain text to HTML
     * @param {string} text - Plain text
     * @returns {string} HTML
     */
    textToHtml(text) {
        if (!text) return '';
        
        // Escape HTML
        let html = text
            .replace(/&/g, '&')
            .replace(/</g, '<')
            .replace(/>/g, '>');
        
        // Convert URLs to links
        html = html.replace(
            /(https?:\/\/[^\s<]+)/g,
            '<a href="$1">$1</a>'
        );
        
        // Convert newlines to <br>
        html = html.replace(/\n/g, '<br>');
        
        return `<html><body><pre style="white-space: pre-wrap; word-wrap: break-word;">${html}</pre></body></html>`;
    }

    /**
     * Parse attachments from message
     * @param {object} message - IMAP message
     * @returns {Promise<array>} Array of attachments
     */
    async parseAttachments(message) {
        const attachments = [];
        
        if (!message.attributes || !message.attributes.struct) {
            return attachments;
        }
        
        const struct = message.attributes.struct;
        
        for (const part of struct) {
            if (part.disposition && part.disposition.type === 'attachment') {
                attachments.push({
                    filename: part.disposition.params?.filename || part.params?.name || 'attachment',
                    contentType: `${part.type}/${part.subtype}`,
                    size: part.size || 0,
                    id: part.id
                });
            }
        }
        
        return attachments;
    }

    /**
     * Generate a unique message ID
     * @returns {string} Message ID
     */
    generateMessageId() {
        const uuid = require('uuid');
        return `<${uuid.v4()}@novabyte-bridge>`;
    }

    // ==================== Utility Methods ====================

    /**
     * Close all connections
     * @returns {Promise<void>}
     */
    async closeAll() {
        const accountIds = Array.from(this.connections.keys());
        
        for (const accountId of accountIds) {
            await this.disconnect(accountId);
        }
        
        this.logger.info('All connections closed');
    }

    /**
     * Get connection status
     * @returns {object} Connection status
     */
    getStatus() {
        const connectionStatuses = {};
        
        for (const [accountId, connection] of this.connections) {
            connectionStatuses[accountId] = {
                connected: true,
                state: connection?.state || 'unknown'
            };
        }
        
        return {
            activeConnections: this.connections.size,
            activeTransports: this.smtpTransports.size,
            cachedTokens: this.tokenCache.size,
            connections: connectionStatuses
        };
    }
}

// Export for both Node.js and browser
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MailService;
}
