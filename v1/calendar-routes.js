/**
 * Calendar Routes - API endpoints for Calendar features
 */

const express = require('express');
const router = express.Router();
const calendarService = require('./calendar-service');
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
 * POST /api/calendar/parse-ics
 * Parse ICS content and extract events
 */
router.post('/parse-ics', requireAuth, (req, res) => {
    try {
        const { icsContent } = req.body;

        if (!icsContent) {
            return res.status(400).json({ error: 'ICS content is required' });
        }

        const calendar = calendarService.parseICS(icsContent);

        res.json({
            success: true,
            calendar: {
                version: calendar.version,
                productId: calendar.productId,
                eventCount: calendar.events.length,
                events: calendar.events.map(e => ({
                    id: e.id,
                    uid: e.uid,
                    summary: e.summary,
                    description: e.description,
                    location: e.location,
                    start: e.start,
                    end: e.end,
                    organizer: e.organizer,
                    attendees: e.attendees,
                    recurrence: e.recurrence
                }))
            }
        });
    } catch (error) {
        console.error('[Calendar Routes] Parse ICS error:', error);
        res.status(400).json({ error: error.message });
    }
});

/**
 * POST /api/calendar/create-event
 * Create a new calendar event
 */
router.post('/create-event', requireAuth, (req, res) => {
    try {
        const { summary, description, location, start, end, allDay, timezone, organizer, attendees, recurrence } = req.body;

        if (!start) {
            return res.status(400).json({ error: 'Event start time is required' });
        }

        const event = calendarService.createEvent(req.userId, {
            summary,
            description,
            location,
            start,
            end,
            allDay,
            timezone,
            organizer,
            attendees,
            recurrence
        });

        const createdEvent = event[event.length - 1];

        res.json({
            success: true,
            event: {
                id: createdEvent.id,
                uid: createdEvent.uid,
                summary: createdEvent.summary,
                description: createdEvent.description,
                location: createdEvent.location,
                start: createdEvent.start,
                end: createdEvent.end,
                allDay: createdEvent.allDay,
                createdAt: createdEvent.createdAt
            }
        });
    } catch (error) {
        console.error('[Calendar Routes] Create event error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/calendar/events
 * Get calendar events for the user
 */
router.get('/events', requireAuth, (req, res) => {
    try {
        const { startDate, endDate } = req.query;

        const events = calendarService.getEvents(req.userId, {
            startDate,
            endDate
        });

        res.json({
            success: true,
            events: events.map(e => ({
                id: e.id,
                uid: e.uid,
                summary: e.summary,
                description: e.description,
                location: e.location,
                start: e.start,
                end: e.end,
                allDay: e.allDay,
                timezone: e.timezone,
                organizer: e.organizer,
                attendees: e.attendees,
                recurrence: e.recurrence,
                createdAt: e.createdAt,
                updatedAt: e.updatedAt
            }))
        });
    } catch (error) {
        console.error('[Calendar Routes] Get events error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/calendar/events/:id
 * Get a specific event by ID
 */
router.get('/events/:id', requireAuth, (req, res) => {
    try {
        const { id } = req.params;
        const events = calendarService.getEvents(req.userId);
        
        const event = events.find(e => e.id === id || e.uid === id);
        
        if (!event) {
            return res.status(404).json({ error: 'Event not found' });
        }

        res.json({
            success: true,
            event
        });
    } catch (error) {
        console.error('[Calendar Routes] Get event error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/calendar/events/:id
 * Update an existing event
 */
router.put('/events/:id', requireAuth, (req, res) => {
    try {
        const { id } = req.params;
        const { summary, description, location, start, end, allDay, timezone, attendees, recurrence } = req.body;
        
        const events = calendarService.getEvents(req.userId);
        const existingIndex = events.findIndex(e => e.id === id || e.uid === id);
        
        if (existingIndex < 0) {
            return res.status(404).json({ error: 'Event not found' });
        }

        // Update event
        const existingEvent = events[existingIndex];
        const updatedEvent = {
            ...existingEvent,
            summary: summary ?? existingEvent.summary,
            description: description ?? existingEvent.description,
            location: location ?? existingEvent.location,
            start: start ? new Date(start) : existingEvent.start,
            end: end ? new Date(end) : existingEvent.end,
            allDay: allDay ?? existingEvent.allDay,
            timezone: timezone ?? existingEvent.timezone,
            attendees: attendees ?? existingEvent.attendees,
            recurrence: recurrence ?? existingEvent.recurrence,
            updatedAt: new Date()
        };

        // Store updated events
        events[existingIndex] = updatedEvent;

        res.json({
            success: true,
            event: updatedEvent
        });
    } catch (error) {
        console.error('[Calendar Routes] Update event error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /api/calendar/events/:id
 * Delete an event
 */
router.delete('/events/:id', requireAuth, (req, res) => {
    try {
        const { id } = req.params;
        
        const deleted = calendarService.deleteEvent(req.userId, id);
        
        if (!deleted) {
            return res.status(404).json({ error: 'Event not found' });
        }

        res.json({
            success: true,
            message: 'Event deleted'
        });
    } catch (error) {
        console.error('[Calendar Routes] Delete event error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/calendar/detect
 * Detect calendar data in email
 */
router.post('/detect', requireAuth, (req, res) => {
    try {
        const { emailContent, attachments } = req.body;

        if (!emailContent && (!attachments || attachments.length === 0)) {
            return res.status(400).json({ error: 'Email content or attachments required' });
        }

        const detection = calendarService.detectCalendarInEmail(
            emailContent || '',
            attachments || []
        );

        res.json({
            success: true,
            detection: {
                hasCalendarData: detection.hasCalendarData,
                source: detection.source,
                method: detection.method,
                events: detection.events.map(e => ({
                    id: e.id,
                    uid: e.uid,
                    summary: e.summary,
                    description: e.description,
                    location: e.location,
                    start: e.start,
                    end: e.end,
                    organizer: e.organizer,
                    attendees: e.attendees
                }))
            }
        });
    } catch (error) {
        console.error('[Calendar Routes] Detect calendar error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/calendar/import-ics
 * Import calendar events from ICS content
 */
router.post('/import-ics', requireAuth, (req, res) => {
    try {
        const { icsContent } = req.body;

        if (!icsContent) {
            return res.status(400).json({ error: 'ICS content is required' });
        }

        const calendar = calendarService.parseICS(icsContent);

        if (calendar.events.length === 0) {
            return res.status(400).json({ error: 'No events found in ICS content' });
        }

        // Store events for user
        calendarService.storeEvents(req.userId, calendar.events);

        res.json({
            success: true,
            imported: calendar.events.length,
            events: calendar.events.map(e => ({
                id: e.id,
                summary: e.summary,
                start: e.start
            }))
        });
    } catch (error) {
        console.error('[Calendar Routes] Import ICS error:', error);
        res.status(400).json({ error: error.message });
    }
});

/**
 * GET /api/calendar/export-ics
 * Export calendar events as ICS
 */
router.get('/export-ics', requireAuth, (req, res) => {
    try {
        const { startDate, endDate } = req.query;

        const events = calendarService.getEvents(req.userId, {
            startDate,
            endDate
        });

        const icsContent = calendarService.generateICS(events);

        res.setHeader('Content-Type', 'text/calendar');
        res.setHeader('Content-Disposition', 'attachment; filename="calendar.ics"');
        res.send(icsContent);
    } catch (error) {
        console.error('[Calendar Routes] Export ICS error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
