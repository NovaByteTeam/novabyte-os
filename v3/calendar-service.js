/**
 * Calendar Service - Calendar Integration
 * Handles ICS parsing, event detection, and calendar file generation
 */

const { v4: uuidv4 } = require('uuid');

// In-memory storage for calendar events (production would use database)
const userEvents = new Map();

// ICS parsing patterns
const ICS_PATTERNS = {
    // Event properties
    DTSTART: /^DTSTART(?:;[^:]*)?:(.+)$/m,
    DTEND: /^DTEND(?:;[^:]*)?:(.+)$/m,
    SUMMARY: /^SUMMARY:(.*)$/m,
    DESCRIPTION: /^DESCRIPTION:(.*)$/m,
    LOCATION: /^LOCATION:(.*)$/m,
    ORGANIZER: /^ORGANIZER(?:;[^:]*)?:(.+)$/m,
    ATTENDEE: /^ATTENDEE(?:;[^:]*)?:(.+)$/m,
    UID: /^UID:(.+)$/m,
    RECURRENCE_ID: /^RECURRENCE-ID(?:;[^:]*)?:(.+)$/m,
    RRULE: /^RRULE:(.+)$/m,
    VALARM: /^BEGIN:VALARM[\s\S]*?END:VALARM$/m,
    
    // Timezone patterns
    TZID: /^TZID=(.+)$/m,
    TZOFFSETFROM: /^TZOFFSETFROM:(.+)$/m,
    TZOFFSETTO: /^TZOFFSETTO:(.+)$/m,
    
    // Date/time formats
    DATETIME_UTC: /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
    DATETIME_LOCAL: /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/,
    DATE_ONLY: /^(\d{4})(\d{2})(\d{2})$/
};

/**
 * Parse ICS date string to Date object
 */
function parseICSDate(dateStr) {
    if (!dateStr) return null;

    // Try UTC format: YYYYMMDDTHHMMSSZ
    let match = dateStr.match(ICS_PATTERNS.DATETIME_UTC);
    if (match) {
        return new Date(Date.UTC(
            parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]),
            parseInt(match[4]), parseInt(match[5]), parseInt(match[6])
        ));
    }

    // Try local format: YYYYMMDDTHHMMSS
    match = dateStr.match(ICS_PATTERNS.DATETIME_LOCAL);
    if (match) {
        return new Date(
            parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]),
            parseInt(match[4]), parseInt(match[5]), parseInt(match[6])
        );
    }

    // Try date-only format: YYYYMMDD
    match = dateStr.match(ICS_PATTERNS.DATE_ONLY);
    if (match) {
        return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]));
    }

    // Try native Date parsing as fallback
    const parsed = new Date(dateStr);
    return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Unfold continued lines in ICS (lines starting with space/tab)
 */
function unfoldICS(input) {
    return input.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

/**
 * Unescape ICS text
 */
function unescapeICSText(text) {
    if (!text) return '';
    return text
        .replace(/\\n/g, '\n')
        .replace(/\\,/g, ',')
        .replace(/\\;/g, ';')
        .replace(/\\\\/g, '\\');
}

/**
 * Parse a single VEVENT from ICS content
 */
function parseEvent(eventContent) {
    const event = {
        id: '',
        uid: '',
        summary: '',
        description: '',
        location: '',
        start: null,
        end: null,
        organizer: null,
        attendees: [],
        recurrence: null,
        timezone: null,
        raw: eventContent
    };

    // Extract UID
    const uidMatch = eventContent.match(ICS_PATTERNS.UID);
    event.uid = uidMatch ? uidMatch[1] : uuidv4();
    event.id = event.uid;

    // Extract summary
    const summaryMatch = eventContent.match(ICS_PATTERNS.SUMMARY);
    event.summary = summaryMatch ? unescapeICSText(summaryMatch[1]) : 'Untitled Event';

    // Extract description
    const descMatch = eventContent.match(ICS_PATTERNS.DESCRIPTION);
    event.description = descMatch ? unescapeICSText(descMatch[1]) : '';

    // Extract location
    const locMatch = eventContent.match(ICS_PATTERNS.LOCATION);
    event.location = locMatch ? unescapeICSText(locMatch[1]) : '';

    // Extract start time
    const startMatch = eventContent.match(ICS_PATTERNS.DTSTART);
    if (startMatch) {
        event.start = parseICSDate(startMatch[1]);
        
        // Check for timezone in DTSTART params
        const tzidMatch = startMatch[0].match(/TZID=([^:]+)/);
        if (tzidMatch) {
            event.timezone = tzidMatch[1];
        }
    }

    // Extract end time
    const endMatch = eventContent.match(ICS_PATTERNS.DTEND);
    if (endMatch) {
        event.end = parseICSDate(endMatch[1]);
    }

    // Extract organizer
    const orgMatch = eventContent.match(ICS_PATTERNS.ORGANIZER);
    if (orgMatch) {
        const orgStr = orgMatch[1];
        const nameMatch = orgStr.match(/CN=([^;:]+)/);
        const emailMatch = orgStr.match(/mailto:(.+)/);
        event.organizer = {
            name: nameMatch ? nameMatch[1] : null,
            email: emailMatch ? emailMatch[1] : orgStr.replace('mailto:', '')
        };
    }

    // Extract attendees
    const attendeeMatches = eventContent.matchAll(ICS_PATTERNS.ATTENDEE);
    for (const match of attendeeMatches) {
        const attStr = match[1];
        const nameMatch = attStr.match(/CN=([^;:]+)/);
        const emailMatch = attStr.match(/mailto:(.+)/);
        event.attendees.push({
            name: nameMatch ? nameMatch[1] : null,
            email: emailMatch ? emailMatch[1] : attStr.replace('mailto:', ''),
            role: attStr.match(/ROLE=([^;:]+)/)?.[1] || 'REQ-PARTICIPANT',
            status: attStr.match(/PARTSTAT=([^;:]+)/)?.[1] || 'NEEDS-ACTION'
        });
    }

    // Extract recurrence rule
    const rruleMatch = eventContent.match(ICS_PATTERNS.RRULE);
    if (rruleMatch) {
        event.recurrence = parseRecurrenceRule(rruleMatch[1]);
    }

    return event;
}

/**
 * Parse RRULE string to object
 */
function parseRecurrenceRule(rruleStr) {
    const parts = rruleStr.split(';');
    const rule = {};

    for (const part of parts) {
        const [key, value] = part.split('=');
        switch (key) {
            case 'FREQ':
                rule.frequency = value;
                break;
            case 'COUNT':
                rule.count = parseInt(value);
                break;
            case 'INTERVAL':
                rule.interval = parseInt(value);
                break;
            case 'UNTIL':
                rule.until = parseICSDate(value);
                break;
            case 'BYDAY':
                rule.byDay = value.split(',');
                break;
            case 'BYMONTHDAY':
                rule.byMonthDay = value.split(',').map(d => parseInt(d));
                break;
            case 'BYMONTH':
                rule.byMonth = value.split(',').map(m => parseInt(m));
                break;
        }
    }

    return rule;
}

/**
 * Parse ICS content and extract events
 */
function parseICS(icsContent) {
    if (!icsContent || typeof icsContent !== 'string') {
        throw new Error('Invalid ICS content');
    }

    // Unfold continued lines
    const unfolded = unfoldICS(icsContent);

    // Extract VCALENDAR wrapper
    const calendarMatch = unfolded.match(/BEGIN:VCALENDAR[\s\S]*?END:VCALENDAR/);
    if (!calendarMatch) {
        throw new Error('Invalid ICS format: no VCALENDAR found');
    }

    const calendarContent = calendarMatch[0];

    // Extract calendar properties
    const calendar = {
        version: null,
        productId: null,
        events: []
    };

    const versionMatch = calendarContent.match(/VERSION:([\d.]+)/);
    calendar.version = versionMatch ? versionMatch[1] : '2.0';

    const prodIdMatch = calendarContent.match(/PRODID:(.+)$/m);
    calendar.productId = prodIdMatch ? prodIdMatch[1] : null;

    // Extract all VEVENT blocks
    const eventRegex = /BEGIN:VEVENT[\s\S]*?END:VEVENT/g;
    const eventMatches = calendarContent.match(eventRegex);

    if (eventMatches) {
        for (const eventContent of eventMatches) {
            try {
                const event = parseEvent(eventContent);
                calendar.events.push(event);
            } catch (error) {
                console.error('[Calendar Service] Error parsing event:', error);
            }
        }
    }

    return calendar;
}

/**
 * Generate ICS content from event object
 */
function generateICS(events) {
    if (!Array.isArray(events)) {
        events = [events];
    }

    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//NovaByte Bridge//Calendar//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH'
    ];

    for (const event of events) {
        lines.push('BEGIN:VEVENT');
        
        if (event.uid) {
            lines.push(`UID:${event.uid}`);
        } else {
            lines.push(`UID:${uuidv4()}`);
        }

        if (event.summary) {
            lines.push(`SUMMARY:${escapeICSText(event.summary)}`);
        }

        if (event.description) {
            lines.push(`DESCRIPTION:${escapeICSText(event.description)}`);
        }

        if (event.location) {
            lines.push(`LOCATION:${escapeICSText(event.location)}`);
        }

        if (event.start) {
            lines.push(`DTSTART:${formatICSDate(event.start, event.allDay)}`);
        }

        if (event.end) {
            lines.push(`DTEND:${formatICSDate(event.end, event.allDay)}`);
        }

        if (event.organizer) {
            const orgStr = event.organizer.email 
                ? `mailto:${event.organizer.email}`
                : event.organizer.name || '';
            lines.push(`ORGANIZER;CN=${event.organizer.name || 'Organizer'}:${orgStr}`);
        }

        if (event.attendees && event.attendees.length > 0) {
            for (const att of event.attendees) {
                const attStr = att.email ? `mailto:${att.email}` : att.name || '';
                lines.push(`ATTENDEE;CN=${att.name || 'Attendee'};PARTSTAT=NEEDS-ACTION:${attStr}`);
            }
        }

        if (event.recurrence) {
            lines.push(`RRULE:${generateRecurrenceRule(event.recurrence)}`);
        }

        lines.push(`DTSTAMP:${formatICSDate(new Date(), false)}`);
        lines.push('END:VEVENT');
    }

    lines.push('END:VCALENDAR');

    return lines.join('\r\n');
}

/**
 * Escape text for ICS
 */
function escapeICSText(text) {
    if (!text) return '';
    return text
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\n/g, '\\n');
}

/**
 * Format date for ICS
 */
function formatICSDate(date, allDay = false) {
    if (!date) return '';
    
    const d = new Date(date);
    
    if (allDay) {
        return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    }
    
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}Z`;
}

/**
 * Generate RRULE string from object
 */
function generateRecurrenceRule(rule) {
    const parts = [];
    
    if (rule.frequency) {
        parts.push(`FREQ=${rule.frequency}`);
    }
    if (rule.count) {
        parts.push(`COUNT=${rule.count}`);
    }
    if (rule.interval && rule.interval > 1) {
        parts.push(`INTERVAL=${rule.interval}`);
    }
    if (rule.until) {
        parts.push(`UNTIL=${formatICSDate(rule.until)}`);
    }
    if (rule.byDay) {
        parts.push(`BYDAY=${rule.byDay.join(',')}`);
    }
    if (rule.byMonthDay) {
        parts.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`);
    }
    if (rule.byMonth) {
        parts.push(`BYMONTH=${rule.byMonth.join(',')}`);
    }
    
    return parts.join(';');
}

/**
 * Detect calendar data in email content
 */
function detectCalendarInEmail(emailContent, attachments = []) {
    const detected = {
        hasCalendarData: false,
        events: [],
        method: null,
        source: null
    };

    // Check attachments for ICS files
    for (const attachment of attachments) {
        if (attachment.filename && (
            attachment.filename.endsWith('.ics') || 
            attachment.filename.endsWith('.ical') ||
            attachment.contentType === 'text/calendar'
        )) {
            detected.hasCalendarData = true;
            detected.source = `attachment:${attachment.filename}`;
            detected.method = attachment.method || 'REQUEST';
            
            try {
                const calendar = parseICS(attachment.content);
                detected.events = calendar.events;
            } catch (error) {
                console.error('[Calendar Service] Error parsing attachment:', error);
            }
        }
    }

    // Detect iCal in email body
    if (!detected.hasCalendarData && emailContent) {
        // Look for inline iCal content
        const icalMatch = emailContent.match(/BEGIN:VCALENDAR[\s\S]*?END:VCALENDAR/);
        
        if (icalMatch) {
            detected.hasCalendarData = true;
            detected.source = 'body:inline';
            
            try {
                const calendar = parseICS(icalMatch[0]);
                detected.events = calendar.events;
                
                // Detect method from content
                const methodMatch = icalMatch[0].match(/METHOD:(\w+)/);
                detected.method = methodMatch ? methodMatch[1] : 'PUBLISH';
            } catch (error) {
                console.error('[Calendar Service] Error parsing inline calendar:', error);
            }
        }
    }

    // Try to detect meeting requests from body text patterns
    if (!detected.hasCalendarData && emailContent) {
        const meetingPatterns = [
            /meeting\s+(request|invitation|scheduled)/i,
            /would\s+you\s+like\s+to\s+meet/i,
            /calendar\s+invite/i,
            /proposed\s+meeting/i,
            /let\'s\s+schedule/i,
            /meeting\s+at\s+\d{1,2}:\d{2}/i,
            /zoom\s+meeting|teams\s+meeting|google\s+meet/i
        ];

        for (const pattern of meetingPatterns) {
            if (pattern.test(emailContent)) {
                detected.hasCalendarData = true;
                detected.source = 'body:pattern';
                detected.method = 'REQUEST';
                break;
            }
        }
    }

    return detected;
}

/**
 * Store events for a user
 */
function storeEvents(userId, events) {
    if (!userEvents.has(userId)) {
        userEvents.set(userId, []);
    }

    const userEventList = userEvents.get(userId);
    
    for (const event of events) {
        // Check if event already exists
        const existingIndex = userEventList.findIndex(e => e.uid === event.uid);
        
        if (existingIndex >= 0) {
            userEventList[existingIndex] = { ...event, updatedAt: new Date() };
        } else {
            userEventList.push({
                ...event,
                id: event.id || event.uid,
                createdAt: new Date(),
                updatedAt: new Date()
            });
        }
    }

    return userEventList;
}

/**
 * Get events for a user
 */
function getEvents(userId, options = {}) {
    const userEventList = userEvents.get(userId) || [];
    let events = [...userEventList];

    // Filter by date range
    if (options.startDate) {
        const start = new Date(options.startDate);
        events = events.filter(e => e.start && new Date(e.start) >= start);
    }

    if (options.endDate) {
        const end = new Date(options.endDate);
        events = events.filter(e => !e.end || new Date(e.end) <= end);
    }

    // Sort by start date
    events.sort((a, b) => {
        const dateA = a.start ? new Date(a.start) : new Date(0);
        const dateB = b.start ? new Date(b.start) : new Date(0);
        return dateA - dateB;
    });

    return events;
}

/**
 * Delete an event
 */
function deleteEvent(userId, eventId) {
    const userEventList = userEvents.get(userId) || [];
    const index = userEventList.findIndex(e => e.id === eventId || e.uid === eventId);
    
    if (index >= 0) {
        userEventList.splice(index, 1);
        return true;
    }
    
    return false;
}

/**
 * Create a new calendar event
 */
function createEvent(userId, eventData) {
    const event = {
        id: uuidv4(),
        uid: eventData.uid || uuidv4(),
        summary: eventData.summary || 'Untitled Event',
        description: eventData.description || '',
        location: eventData.location || '',
        start: eventData.start ? new Date(eventData.start) : null,
        end: eventData.end ? new Date(eventData.end) : null,
        allDay: eventData.allDay || false,
        timezone: eventData.timezone || null,
        organizer: eventData.organizer || null,
        attendees: eventData.attendees || [],
        recurrence: eventData.recurrence || null,
        createdAt: new Date(),
        updatedAt: new Date()
    };

    return storeEvents(userId, [event]);
}

module.exports = {
    parseICS,
    generateICS,
    detectCalendarInEmail,
    storeEvents,
    getEvents,
    deleteEvent,
    createEvent,
    formatICSDate
};
