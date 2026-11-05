/**
 * Contacts Routes - API endpoints for Contacts management
 */

const express = require('express');
const router = express.Router();
const contactsService = require('./contacts-service');
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
 * GET /api/contacts
 * List contacts with optional filtering and pagination
 */
router.get('/', requireAuth, (req, res) => {
    try {
        const { search, category, favourites, page, limit, sortBy } = req.query;

        const result = contactsService.getContacts(req.userId, {
            search,
            category,
            favourites: favourites === 'true',
            page: parseInt(page) || 1,
            limit: parseInt(limit) || 50,
            sortBy
        });

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('[Contacts Routes] Get contacts error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/contacts/:id
 * Get a specific contact by ID
 */
router.get('/:id', requireAuth, (req, res) => {
    try {
        const { id } = req.params;
        const contact = contactsService.getContact(req.userId, id);

        if (!contact) {
            return res.status(404).json({ error: 'Contact not found' });
        }

        res.json({
            success: true,
            contact
        });
    } catch (error) {
        console.error('[Contacts Routes] Get contact error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/contacts
 * Add a new contact
 */
router.post('/', requireAuth, (req, res) => {
    try {
        const { displayName, firstName, lastName, email, phone, organisation, title, address, website, note, categories, tags } = req.body;

        // Validate at least one identifier
        if (!displayName && !firstName && !lastName && (!email || email.length === 0)) {
            return res.status(400).json({ error: 'At least a name or email is required' });
        }

        const contact = contactsService.addContact(req.userId, {
            displayName,
            firstName,
            lastName,
            email: email ? (Array.isArray(email) ? email : [{ address: email, type: 'other' }]) : [],
            phone: phone ? (Array.isArray(phone) ? phone : [{ number: phone, type: 'other' }]) : [],
            organisation,
            title,
            address,
            website,
            note,
            categories,
            tags
        });

        res.status(201).json({
            success: true,
            contact
        });
    } catch (error) {
        console.error('[Contacts Routes] Add contact error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/contacts/:id
 * Update an existing contact
 */
router.put('/:id', requireAuth, (req, res) => {
    try {
        const { id } = req.params;
        const { displayName, firstName, lastName, email, phone, organisation, title, address, website, note, categories, tags, isFavourite } = req.body;

        const updated = contactsService.updateContact(req.userId, id, {
            displayName,
            firstName,
            lastName,
            email,
            phone,
            organisation,
            title,
            address,
            website,
            note,
            categories,
            tags,
            isFavourite
        });

        if (!updated) {
            return res.status(404).json({ error: 'Contact not found' });
        }

        res.json({
            success: true,
            contact: updated
        });
    } catch (error) {
        console.error('[Contacts Routes] Update contact error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /api/contacts/:id
 * Delete a contact
 */
router.delete('/:id', requireAuth, (req, res) => {
    try {
        const { id } = req.params;
        
        const deleted = contactsService.deleteContact(req.userId, id);
        
        if (!deleted) {
            return res.status(404).json({ error: 'Contact not found' });
        }

        res.json({
            success: true,
            message: 'Contact deleted'
        });
    } catch (error) {
        console.error('[Contacts Routes] Delete contact error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/contacts/sync
 * Sync contacts from email
 */
router.post('/sync', requireAuth, (req, res) => {
    try {
        const { emails } = req.body;

        if (!emails || !Array.isArray(emails) || emails.length === 0) {
            return res.status(400).json({ error: 'Emails array is required' });
        }

        const result = contactsService.syncFromEmail(req.userId, emails);

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('[Contacts Routes] Sync error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/contacts/import
 * Import contacts from vCard
 */
router.post('/import', requireAuth, (req, res) => {
    try {
        const { vCardContent } = req.body;

        if (!vCardContent) {
            return res.status(400).json({ error: 'vCard content is required' });
        }

        const result = contactsService.importVCard(req.userId, vCardContent);

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('[Contacts Routes] Import error:', error);
        res.status(400).json({ error: error.message });
    }
});

/**
 * GET /api/contacts/export
 * Export contacts as vCard
 */
router.get('/export', requireAuth, (req, res) => {
    try {
        const { format, contactIds } = req.query;

        let contacts;
        if (contactIds) {
            const ids = contactIds.split(',');
            contacts = ids.map(id => contactsService.getContact(req.userId, id)).filter(Boolean);
        } else {
            const result = contactsService.getContacts(req.userId, { limit: 1000 });
            contacts = result.contacts;
        }

        if (contacts.length === 0) {
            return res.status(404).json({ error: 'No contacts to export' });
        }

        const vCardContent = contactsService.generateVCard(contacts);

        res.setHeader('Content-Type', 'text/vcard');
        res.setHeader('Content-Disposition', 'attachment; filename="contacts.vcf"');
        res.send(vCardContent);
    } catch (error) {
        console.error('[Contacts Routes] Export error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/contacts/:id/favourite
 * Toggle favourite status
 */
router.put('/:id/favourite', requireAuth, (req, res) => {
    try {
        const { id } = req.params;
        
        const contact = contactsService.toggleFavourite(req.userId, id);
        
        if (!contact) {
            return res.status(404).json({ error: 'Contact not found' });
        }

        res.json({
            success: true,
            contact
        });
    } catch (error) {
        console.error('[Contacts Routes] Toggle favourite error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/contacts/search
 * Search contacts (alias for GET /api/contacts with search param)
 */
router.get('/search', requireAuth, (req, res) => {
    try {
        const { q } = req.query;

        if (!q) {
            return res.status(400).json({ error: 'Search query is required' });
        }

        const result = contactsService.getContacts(req.userId, {
            search: q,
            limit: 20
        });

        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        console.error('[Contacts Routes] Search error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
