/**
 * Contacts Service - Contacts Management
 * Handles contact storage, sync from email, search, and vCard import/export
 */

const { v4: uuidv4 } = require('uuid');

// In-memory storage for contacts (production would use database)
const userContacts = new Map();

/**
 * Extract email addresses from text
 */
function extractEmailAddresses(text) {
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    return text.match(emailRegex) || [];
}

/**
 * Extract name from email address or display name
 */
function extractNameFromEmail(email) {
    // Try to extract name from "Name <email>" format
    const match = email.match(/^"?([^"<]+)"?\s*<(.+)>$/);
    if (match) {
        return match[1].trim().replace(/^"|"$/g, '');
    }
    return null;
}

/**
 * Extract email from various formats
 */
function extractEmailAddress(emailStr) {
    // Handle "Name <email>" format
    const match = emailStr.match(/<(.+)>/);
    if (match) {
        return match[1].toLowerCase().trim();
    }
    return emailStr.toLowerCase().trim();
}

/**
 * Parse vCard content
 */
function parseVCard(vCardContent) {
    if (!vCardContent || typeof vCardContent !== 'string') {
        throw new Error('Invalid vCard content');
    }

    const contacts = [];
    const vcardRegex = /BEGIN:VCARD[\s\S]*?END:VCARD/gi;
    const matches = vCardContent.match(vcardRegex);

    if (!matches) {
        throw new Error('No valid vCard entries found');
    }

    for (const vcard of matches) {
        const contact = {
            id: uuidv4(),
            uid: null,
            displayName: '',
            firstName: '',
            lastName: '',
            email: [],
            phone: [],
            organisation: '',
            title: '',
            address: {
                street: '',
                city: '',
                region: '',
                postalCode: '',
                country: ''
            },
            website: '',
            note: '',
            photo: null,
            categories: [],
            createdAt: new Date(),
            updatedAt: new Date()
        };

        const lines = vcard.split(/\r?\n/);

        for (const line of lines) {
            // Version
            if (line.startsWith('VERSION:')) {
                contact.version = line.substring(8);
            }

            // UID
            if (line.startsWith('UID:')) {
                contact.uid = line.substring(4);
            }

            // FN (Formatted Name)
            if (line.startsWith('FN:')) {
                contact.displayName = line.substring(3);
            }

            // N (Name components)
            if (line.startsWith('N:')) {
                const nameParts = line.substring(2).split(';');
                contact.lastName = nameParts[0] || '';
                contact.firstName = nameParts[1] || '';
            }

            // Email
            if (line.startsWith('EMAIL')) {
                const emailMatch = line.match(/EMAIL[^:]*:(.+)/);
                if (emailMatch) {
                    contact.email.push({
                        address: emailMatch[1],
                        type: line.match(/EMAIL;TYPE=([^:]+)/)?.[1] || 'other'
                    });
                }
            }

            // Phone
            if (line.startsWith('TEL')) {
                const phoneMatch = line.match(/TEL[^:]*:(.+)/);
                if (phoneMatch) {
                    contact.phone.push({
                        number: phoneMatch[1],
                        type: line.match(/TEL;TYPE=([^:]+)/)?.[1] || 'other'
                    });
                }
            }

            // Organisation
            if (line.startsWith('ORG:')) {
                contact.organisation = line.substring(4).split(';')[0];
            }

            // Title
            if (line.startsWith('TITLE:')) {
                contact.title = line.substring(6);
            }

            // Address
            if (line.startsWith('ADR')) {
                const addrMatch = line.match(/ADR[^:]*:(.+)/);
                if (addrMatch) {
                    const parts = addrMatch[1].split(';');
                    contact.address = {
                        street: parts[2] || '',
                        city: parts[3] || '',
                        region: parts[4] || '',
                        postalCode: parts[5] || '',
                        country: parts[6] || ''
                    };
                }
            }

            // Website
            if (line.startsWith('URL:')) {
                contact.website = line.substring(4);
            }

            // Note
            if (line.startsWith('NOTE:')) {
                contact.note = line.substring(5).replace(/\\n/g, '\n');
            }

            // Categories
            if (line.startsWith('CATEGORIES:')) {
                contact.categories = line.substring(11).split(',');
            }
        }

        // Set displayName from first/last if not set
        if (!contact.displayName && (contact.firstName || contact.lastName)) {
            contact.displayName = `${contact.firstName} ${contact.lastName}`.trim();
        }

        contacts.push(contact);
    }

    return contacts;
}

/**
 * Generate vCard content from contacts
 */
function generateVCard(contacts) {
    if (!Array.isArray(contacts)) {
        contacts = [contacts];
    }

    const lines = [];

    for (const contact of contacts) {
        lines.push('BEGIN:VCARD');
        lines.push('VERSION:3.0');
        
        if (contact.uid) {
            lines.push(`UID:${contact.uid}`);
        } else {
            lines.push(`UID:${uuidv4()}`);
        }

        if (contact.firstName || contact.lastName) {
            lines.push(`N:${contact.lastName || ''};${contact.firstName || ''};;;`);
        }

        if (contact.displayName) {
            lines.push(`FN:${contact.displayName}`);
        }

        // Primary email
        const primaryEmail = contact.email?.[0]?.address || '';
        if (primaryEmail) {
            lines.push(`EMAIL:${primaryEmail}`);
        }

        // All emails
        for (let i = 1; i < (contact.email?.length || 0); i++) {
            lines.push(`EMAIL;TYPE=OTHER:${contact.email[i].address}`);
        }

        // Primary phone
        const primaryPhone = contact.phone?.[0]?.number || '';
        if (primaryPhone) {
            lines.push(`TEL:${primaryPhone}`);
        }

        // All phones
        for (let i = 1; i < (contact.phone?.length || 0); i++) {
            lines.push(`TEL;TYPE=OTHER:${contact.phone[i].number}`);
        }

        if (contact.organisation) {
            lines.push(`ORG:${contact.organisation}`);
        }

        if (contact.title) {
            lines.push(`TITLE:${contact.title}`);
        }

        if (contact.address?.street || contact.address?.city) {
            lines.push(`ADR:;;${contact.address.street || ''};${contact.address.city || ''};${contact.address.region || ''};${contact.address.postalCode || ''};${contact.address.country || ''}`);
        }

        if (contact.website) {
            lines.push(`URL:${contact.website}`);
        }

        if (contact.note) {
            lines.push(`NOTE:${contact.note.replace(/\n/g, '\\n')}`);
        }

        if (contact.categories?.length > 0) {
            lines.push(`CATEGORIES:${contact.categories.join(',')}`);
        }

        lines.push('END:VCARD');
    }

    return lines.join('\r\n');
}

/**
 * Add a new contact
 */
function addContact(userId, contactData) {
    if (!userContacts.has(userId)) {
        userContacts.set(userId, []);
    }

    const contact = {
        id: uuidv4(),
        uid: contactData.uid || uuidv4(),
        displayName: contactData.displayName || '',
        firstName: contactData.firstName || '',
        lastName: contactData.lastName || '',
        email: contactData.email || [],
        phone: contactData.phone || [],
        organisation: contactData.organisation || '',
        title: contactData.title || '',
        address: contactData.address || {
            street: '',
            city: '',
            region: '',
            postalCode: '',
            country: ''
        },
        website: contactData.website || '',
        note: contactData.note || '',
        photo: contactData.photo || null,
        categories: contactData.categories || [],
        tags: contactData.tags || [],
        isFavourite: contactData.isFavourite || false,
        createdAt: new Date(),
        updatedAt: new Date()
    };

    // Generate displayName from first/last if not set
    if (!contact.displayName && (contact.firstName || contact.lastName)) {
        contact.displayName = `${contact.firstName} ${contact.lastName}`.trim();
    }

    const userContactList = userContacts.get(userId);
    userContactList.push(contact);

    return contact;
}

/**
 * Get contacts for a user
 */
function getContacts(userId, options = {}) {
    const userContactList = userContacts.get(userId) || [];
    let contacts = [...userContactList];

    // Filter by search query
    if (options.search) {
        const searchLower = options.search.toLowerCase();
        contacts = contacts.filter(c => {
            const searchableText = [
                c.displayName,
                c.firstName,
                c.lastName,
                c.email?.map(e => e.address).join(' '),
                c.organisation,
                c.note
            ].join(' ').toLowerCase();
            
            return searchableText.includes(searchLower);
        });
    }

    // Filter by category
    if (options.category) {
        contacts = contacts.filter(c => 
            c.categories?.includes(options.category) || 
            c.tags?.includes(options.category)
        );
    }

    // Filter favourites only
    if (options.favourites) {
        contacts = contacts.filter(c => c.isFavourite);
    }

    // Sort contacts
    const sortBy = options.sortBy || 'displayName';
    contacts.sort((a, b) => {
        let valA = a[sortBy] || '';
        let valB = b[sortBy] || '';
        
        if (typeof valA === 'string') {
            valA = valA.toLowerCase();
            valB = valB.toLowerCase();
        }
        
        if (valA < valB) return -1;
        if (valA > valB) return 1;
        return 0;
    });

    // Pagination
    const page = options.page || 1;
    const limit = options.limit || 50;
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;

    return {
        contacts: contacts.slice(startIndex, endIndex),
        total: contacts.length,
        page,
        limit,
        totalPages: Math.ceil(contacts.length / limit)
    };
}

/**
 * Get a contact by ID
 */
function getContact(userId, contactId) {
    const userContactList = userContacts.get(userId) || [];
    return userContactList.find(c => c.id === contactId || c.uid === contactId);
}

/**
 * Update a contact
 */
function updateContact(userId, contactId, updates) {
    const userContactList = userContacts.get(userId) || [];
    const index = userContactList.findIndex(c => c.id === contactId || c.uid === contactId);

    if (index < 0) {
        return null;
    }

    const contact = userContactList[index];
    const updated = {
        ...contact,
        ...updates,
        id: contact.id,
        uid: contact.uid,
        updatedAt: new Date()
    };

    // Regenerate displayName if name changed
    if (updates.firstName !== undefined || updates.lastName !== undefined) {
        updated.displayName = `${updated.firstName} ${updated.lastName}`.trim();
    }

    userContactList[index] = updated;
    return updated;
}

/**
 * Delete a contact
 */
function deleteContact(userId, contactId) {
    const userContactList = userContacts.get(userId) || [];
    const index = userContactList.findIndex(c => c.id === contactId || c.uid === contactId);

    if (index < 0) {
        return false;
    }

    userContactList.splice(index, 1);
    return true;
}

/**
 * Sync contacts from email (extract from sent emails)
 */
function syncFromEmail(userId, emails) {
    const extractedContacts = [];
    const seenEmails = new Set();

    for (const email of emails) {
        // Extract from "To" field
        if (email.to) {
            const toEmails = Array.isArray(email.to) ? email.to : [email.to];
            
            for (const to of toEmails) {
                const emailAddress = extractEmailAddress(to);
                
                if (emailAddress && !seenEmails.has(emailAddress)) {
                    seenEmails.add(emailAddress);
                    
                    extractedContacts.push({
                        displayName: extractNameFromEmail(to) || '',
                        email: [{ address: emailAddress, type: 'work' }],
                        note: `Synced from email on ${new Date(email.date || Date.now()).toLocaleDateString()}`,
                        source: 'email'
                    });
                }
            }
        }

        // Extract from CC field
        if (email.cc) {
            const ccEmails = Array.isArray(email.cc) ? email.cc : [email.cc];
            
            for (const cc of ccEmails) {
                const emailAddress = extractEmailAddress(cc);
                
                if (emailAddress && !seenEmails.has(emailAddress)) {
                    seenEmails.add(emailAddress);
                    
                    extractedContacts.push({
                        displayName: extractNameFromEmail(cc) || '',
                        email: [{ address: emailAddress, type: 'cc' }],
                        note: `Synced from email CC on ${new Date(email.date || Date.now()).toLocaleDateString()}`,
                        source: 'email'
                    });
                }
            }
        }

        // Extract from "From" field (for replies)
        if (email.from) {
            const fromEmail = extractEmailAddress(email.from);
            
            if (fromEmail && !seenEmails.has(fromEmail)) {
                seenEmails.add(fromEmail);
                
                extractedContacts.push({
                    displayName: extractNameFromEmail(email.from) || '',
                    email: [{ address: fromEmail, type: 'received' }],
                    note: `Synced from received email on ${new Date(email.date || Date.now()).toLocaleDateString()}`,
                    source: 'email'
                });
            }
        }
    }

    // Add new contacts to storage
    let added = 0;
    for (const contactData of extractedContacts) {
        // Check if contact already exists
        const existingContactList = userContacts.get(userId) || [];
        const existingEmail = existingContactList.find(c => 
            c.email?.some(e => e.address === contactData.email[0].address)
        );

        if (!existingEmail) {
            addContact(userId, contactData);
            added++;
        }
    }

    return {
        extracted: extractedContacts.length,
        added,
        duplicates: extractedContacts.length - added
    };
}

/**
 * Import contacts from vCard
 */
function importVCard(userId, vCardContent) {
    const contacts = parseVCard(vCardContent);
    let imported = 0;

    for (const contact of contacts) {
        // Check if contact with same email exists
        const userContactList = userContacts.get(userId) || [];
        const existingContact = userContactList.find(c =>
            c.email?.some(e => contact.email?.some(ce => ce.address.toLowerCase() === e.address.toLowerCase()))
        );

        if (!existingContact) {
            addContact(userId, contact);
            imported++;
        }
    }

    return {
        total: contacts.length,
        imported,
        duplicates: contacts.length - imported
    };
}

/**
 * Toggle favourite status
 */
function toggleFavourite(userId, contactId) {
    const userContactList = userContacts.get(userId) || [];
    const contact = userContactList.find(c => c.id === contactId || c.uid === contactId);

    if (!contact) {
        return null;
    }

    contact.isFavourite = !contact.isFavourite;
    contact.updatedAt = new Date();

    return contact;
}

module.exports = {
    addContact,
    getContacts,
    getContact,
    updateContact,
    deleteContact,
    syncFromEmail,
    parseVCard,
    generateVCard,
    importVCard,
    toggleFavourite,
    extractEmailAddresses
};
