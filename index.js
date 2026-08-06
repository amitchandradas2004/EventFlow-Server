require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection Client & Database Cache for Serverless
const uri = process.env.MONGODB_URI;
let client;
let db;

async function connectDB() {
    if (db) return db;
    if (!client) {
        client = new MongoClient(uri, {
            serverApi: {
                version: ServerApiVersion.v1,
                strict: true,
                deprecationErrors: true,
            }
        });
    }
    await client.connect();
    db = client.db(process.env.DB_NAME);
    return db;
}

// Helper function to check if a user is blocked
async function checkBlockedUser(database, email) {
    if (!email) return false;
    const userCollection = database.collection('user');
    const userDoc = await userCollection.findOne({ email: { $regex: new RegExp(`^${email.trim()}$`, 'i') } });
    return userDoc?.isBlocked === true || userDoc?.status === 'blocked';
}

// Routes
app.get('/', (req, res) => {
    res.send('EventFlow Server is running!');
});

// Get specific user information
app.get('/api/user/:id', async (req, res) => {
    try {
        const database = await connectDB();
        const userCollection = database.collection('user');
        const id = req.params.id;
        const query = { email: id };
        const result = await userCollection.findOne(query);
        res.send(result);
    } catch (error) {
        console.error('Database query error:', error);
        res.status(500).json({ success: false, message: 'Database connection error', error: error.message });
    }
});

// Update user information
app.patch('/api/user/:email', async (req, res) => {
    try {
        const database = await connectDB();
        const email = req.params.email;

        // Check if user is blocked
        const isBlocked = await checkBlockedUser(database, email);
        if (isBlocked) {
            return res.status(403).json({
                success: false,
                isBlocked: true,
                message: 'Your account is currently blocked by an administrator. Profile update is restricted.'
            });
        }

        const userCollection = database.collection('user');
        const query = { email: email };
        const { name, image } = req.body;

        // Validate inputs
        if (!name || !image) {
            return res.status(400).json({
                success: false,
                message: 'Name and image are required'
            });
        }
        const result = await userCollection.updateOne(
            query,
            {
                $set: {
                    name,
                    image,
                    updatedAt: new Date()
                }
            }
        );
        if (result.matchedCount === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }
        res.json({
            success: true,
            message: 'User updated successfully',
            result
        });
    } catch (error) {
        console.error('Error updating user:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating user',
            error: error.message
        });
    }
});

// Get all users for admin with pagination, search, role & status filter, and summary stats
app.get('/api/admin/users', async (req, res) => {
    try {
        const database = await connectDB();
        const userCollection = database.collection('user');

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const search = (req.query.search || '').trim();
        const role = (req.query.role || '').trim().toLowerCase();
        const status = (req.query.status || '').trim().toLowerCase();

        const conditions = [];

        if (search) {
            const searchRegex = { $regex: search, $options: 'i' };
            conditions.push({
                $or: [
                    { name: searchRegex },
                    { email: searchRegex }
                ]
            });
        }

        if (role && role !== 'all') {
            conditions.push({ role: { $regex: new RegExp(`^${role}$`, 'i') } });
        }

        if (status === 'blocked') {
            conditions.push({ isBlocked: true });
        } else if (status === 'active') {
            conditions.push({ $or: [{ isBlocked: false }, { isBlocked: { $exists: false } }] });
        }

        const query = conditions.length === 0 ? {} : conditions.length === 1 ? conditions[0] : { $and: conditions };

        const total = await userCollection.countDocuments(query);
        const result = await userCollection.find(query).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).toArray();

        // Calculate overview stats across all users
        const allUsersDocs = await userCollection.find({}, { projection: { isBlocked: 1, role: 1 } }).toArray();
        const stats = {
            totalUsers: allUsersDocs.length,
            activeUsers: allUsersDocs.filter(u => !u.isBlocked).length,
            blockedUsers: allUsersDocs.filter(u => u.isBlocked === true).length,
            admins: allUsersDocs.filter(u => (u.role || '').toLowerCase() === 'admin').length,
            organizers: allUsersDocs.filter(u => (u.role || '').toLowerCase() === 'organizer').length,
            attendees: allUsersDocs.filter(u => (u.role || '').toLowerCase() === 'attendee' || !u.role).length,
        };

        res.json({
            success: true,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit) || 1,
            stats,
            result
        });
    } catch (error) {
        console.error('Error fetching admin users:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching users',
            error: error.message
        });
    }
});

// Update user block status (Block or Unblock)
app.patch('/api/admin/user/:id/status', async (req, res) => {
    try {
        const database = await connectDB();
        const userCollection = database.collection('user');
        const id = req.params.id;
        const { isBlocked } = req.body;

        if (typeof isBlocked !== 'boolean') {
            return res.status(400).json({
                success: false,
                message: 'isBlocked must be a boolean (true or false)'
            });
        }

        const query = ObjectId.isValid(id)
            ? { _id: new ObjectId(id) }
            : { $or: [{ email: id }, { id: id }] };

        // Prevent blocking administrators
        if (isBlocked) {
            const targetUser = await userCollection.findOne(query);
            if (!targetUser) {
                return res.status(404).json({
                    success: false,
                    message: 'User not found'
                });
            }
            if ((targetUser.role || '').toLowerCase() === 'admin') {
                return res.status(403).json({
                    success: false,
                    message: 'Administrators cannot be blocked.'
                });
            }
        }

        const updateDoc = {
            $set: {
                isBlocked,
                status: isBlocked ? 'blocked' : 'active',
                updatedAt: new Date()
            }
        };

        const result = await userCollection.updateOne(query, updateDoc);

        if (result.matchedCount === 0) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        res.json({
            success: true,
            message: `User successfully ${isBlocked ? 'blocked' : 'unblocked'}`,
            result
        });
    } catch (error) {
        console.error('Error updating user block status:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating user block status',
            error: error.message
        });
    }
});


// Create a new Organization
app.post('/api/organization', async (req, res) => {
    try {
        const database = await connectDB();
        const orgCollection = database.collection('organization');
        const userCollection = database.collection('user');
        const orgData = req.body;

        const { organizerEmail } = orgData;

        if (organizerEmail) {
            const isBlocked = await checkBlockedUser(database, organizerEmail);
            if (isBlocked) {
                return res.status(403).json({
                    success: false,
                    isBlocked: true,
                    message: 'Your account is currently blocked by an administrator. Action restricted.'
                });
            }

            // Check if user is premium
            const user = await userCollection.findOne({ email: organizerEmail });
            const isPremium = user?.isPremium || false;

            if (!isPremium) {
                const count = await orgCollection.countDocuments({ organizerEmail: organizerEmail });
                if (count >= 10) {
                    return res.status(403).json({
                        success: false,
                        message: 'Free limit reached! You can publish up to 10 organizations for free. Please upgrade to Premium to publish unlimited organizations.'
                    });
                }
            }
        }

        // Insert the new organization
        const result = await orgCollection.insertOne(orgData);
        res.json({
            success: true,
            message: 'Organization created successfully',
            result
        });
    } catch (error) {
        console.error('Error creating organization:', error);
        res.status(500).json({
            success: false,
            message: 'Error creating organization',
            error: error.message
        });
    }
});

// Get approved organizations (approved by admin, max 6 by default)
app.get('/api/organization/approved', async (req, res) => {
    try {
        const database = await connectDB();
        const orgCollection = database.collection('organization');
        const limit = parseInt(req.query.limit) || 6;

        const query = {
            status: { $regex: /^approved$/i }
        };

        const result = await orgCollection.find(query).sort({ createdAt: -1 }).limit(limit).toArray();

        res.json({
            success: true,
            total: result.length,
            result
        });
    } catch (error) {
        console.error('Error fetching approved organizations:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching approved organizations',
            error: error.message
        });
    }
});

// show specific organization with pagination
app.get('/api/organization/:organizerEmail', async (req, res) => {
    try {
        const database = await connectDB();
        const orgCollection = database.collection('organization');
        const organizerEmail = req.params.organizerEmail;
        const query = { organizerEmail: organizerEmail };

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const total = await orgCollection.countDocuments(query);
        const result = await orgCollection.find(query).skip(skip).limit(limit).toArray();

        res.json({
            success: true,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit) || 1,
            result
        });
    } catch (error) {
        console.error('Database query error:', error);
        res.status(500).json({ success: false, message: 'Database connection error', error: error.message });
    }
});

app.delete('/api/organization/:id', async (req, res) => {
    try {
        const database = await connectDB();
        const orgCollection = database.collection('organization');
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await orgCollection.deleteOne(query);
        res.json({
            success: true,
            message: 'Organization deleted successfully',
            result
        });
    } catch (error) {
        console.error('Error deleting organization:', error);
        res.status(500).json({
            success: false,
            message: 'Error deleting organization',
            error: error.message
        });
    }
});

// Update an Organization by ID
app.put('/api/organization/:id', async (req, res) => {
    try {
        const database = await connectDB();
        const orgCollection = database.collection('organization');
        const id = req.params.id;
        const updateData = req.body;

        delete updateData._id;

        const query = { _id: new ObjectId(id) };
        const updateDoc = {
            $set: updateData
        };

        const result = await orgCollection.updateOne(query, updateDoc);
        res.json({
            success: true,
            message: 'Organization updated successfully',
            result
        });
    } catch (error) {
        console.error('Error updating organization:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating organization',
            error: error.message
        });
    }
});

// Create a new Event
app.post('/api/event', async (req, res) => {
    try {
        const database = await connectDB();
        const eventCollection = database.collection('events');
        const eventData = req.body;

        // Validation
        const { title, banner, category, location, date, ticketPrice, availableSeats, description, organizationId, organizerEmail } = eventData;
        if (!title || !banner || !category || !location || !date || ticketPrice === undefined || availableSeats === undefined || !description || !organizationId || !organizerEmail) {
            return res.status(400).json({
                success: false,
                message: 'All fields are required including organizationId and organizerEmail'
            });
        }

        const isBlocked = await checkBlockedUser(database, organizerEmail);
        if (isBlocked) {
            return res.status(403).json({
                success: false,
                isBlocked: true,
                message: 'Your account is currently blocked by an administrator. Action restricted.'
            });
        }

        const newEvent = {
            title,
            banner,
            category,
            location,
            date,
            ticketPrice: Number(ticketPrice),
            availableSeats: Number(availableSeats),
            description,
            organizationId,
            organizerEmail,
            status: 'pending',
            createdAt: new Date()
        };

        const result = await eventCollection.insertOne(newEvent);
        res.status(201).json({
            success: true,
            message: 'Event created successfully',
            result
        });
    } catch (error) {
        console.error('Error creating event:', error);
        res.status(500).json({
            success: false,
            message: 'Error creating event',
            error: error.message
        });
    }
});

// Get all public events (approved by admin only) with pagination (default 12/page), search, category filter & sorting
app.get('/api/events/all', async (req, res) => {
    try {
        const database = await connectDB();
        const eventCollection = database.collection('events');

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 12;
        const skip = (page - 1) * limit;

        const search = (req.query.search || '').trim();
        const category = (req.query.category || '').trim();
        const sortBy = req.query.sortBy || 'newest';

        // Base query: strictly approved events
        const conditions = [
            { status: { $regex: /^approved$/i } }
        ];

        // Apply search query (title, description, or location)
        if (search) {
            const searchRegex = { $regex: search, $options: 'i' };
            conditions.push({
                $or: [
                    { title: searchRegex },
                    { description: searchRegex },
                    { location: searchRegex }
                ]
            });
        }

        // Apply category filter
        if (category && category.toLowerCase() !== 'all') {
            conditions.push({
                category: { $regex: new RegExp(`^${category}$`, 'i') }
            });
        }

        const query = conditions.length === 1 ? conditions[0] : { $and: conditions };

        // Define sort criteria
        let sortCriteria = { _id: -1 };
        if (sortBy === 'date-asc') {
            sortCriteria = { date: 1, _id: -1 };
        } else if (sortBy === 'date-desc') {
            sortCriteria = { date: -1, _id: -1 };
        } else if (sortBy === 'price-asc') {
            sortCriteria = { ticketPrice: 1, _id: -1 };
        } else if (sortBy === 'price-desc') {
            sortCriteria = { ticketPrice: -1, _id: -1 };
        } else if (sortBy === 'newest') {
            sortCriteria = { createdAt: -1, _id: -1 };
        }

        const total = await eventCollection.countDocuments(query);
        const result = await eventCollection.find(query).sort(sortCriteria).skip(skip).limit(limit).toArray();

        // Fetch distinct categories from approved events in a Strict API v1 compliant way
        const categoryDocs = await eventCollection.find({ status: { $regex: /^approved$/i } }, { projection: { category: 1 } }).toArray();
        const categories = Array.from(new Set(categoryDocs.map(c => c.category).filter(Boolean)));

        res.json({
            success: true,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit) || 1,
            categories: categories || [],
            result
        });
    } catch (error) {
        console.error('Error fetching all public events:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching events',
            error: error.message
        });
    }
});

// Get approved events (approved by admin, max 6 by default)
app.get('/api/event/approved', async (req, res) => {
    try {
        const database = await connectDB();
        const eventCollection = database.collection('events');
        const limit = parseInt(req.query.limit) || 6;

        const query = { status: { $regex: /^approved$/i } };
        const result = await eventCollection.find(query).sort({ _id: -1 }).limit(limit).toArray();

        res.json({
            success: true,
            total: result.length,
            result
        });
    } catch (error) {
        console.error('Error fetching approved events:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching approved events',
            error: error.message
        });
    }
});

// Get events for specific organizer with pagination & optional search
app.get('/api/event/organizer/:organizerEmail', async (req, res) => {
    try {
        const database = await connectDB();
        const eventCollection = database.collection('events');
        const organizerEmail = req.params.organizerEmail;
        const search = req.query.search || '';

        const query = { organizerEmail: organizerEmail };
        if (search) {
            query.title = { $regex: search, $options: 'i' };
        }

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const total = await eventCollection.countDocuments(query);
        const result = await eventCollection.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray();

        res.json({
            success: true,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit) || 1,
            result
        });
    } catch (error) {
        console.error('Database query error:', error);
        res.status(500).json({ success: false, message: 'Database connection error', error: error.message });
    }
});

// Get all events for admin with pagination, search, status filter & summary stats
app.get('/api/admin/events', async (req, res) => {
    try {
        const database = await connectDB();
        const eventCollection = database.collection('events');

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const search = (req.query.search || '').trim();
        const status = (req.query.status || '').trim().toLowerCase();

        const conditions = [];

        if (search) {
            const searchRegex = { $regex: search, $options: 'i' };
            conditions.push({
                $or: [
                    { title: searchRegex },
                    { organizerEmail: searchRegex },
                    { location: searchRegex },
                    { category: searchRegex }
                ]
            });
        }

        if (status && status !== 'all') {
            conditions.push({ status: { $regex: new RegExp(`^${status}$`, 'i') } });
        }

        const query = conditions.length === 0 ? {} : conditions.length === 1 ? conditions[0] : { $and: conditions };

        const total = await eventCollection.countDocuments(query);
        const result = await eventCollection.find(query).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).toArray();

        // Stats across all events
        const allEvents = await eventCollection.find({}, { projection: { status: 1 } }).toArray();
        const stats = {
            totalEvents: allEvents.length,
            pendingEvents: allEvents.filter(e => (e.status || 'pending').toLowerCase() === 'pending').length,
            approvedEvents: allEvents.filter(e => (e.status || 'pending').toLowerCase() === 'approved').length,
            rejectedEvents: allEvents.filter(e => (e.status || 'pending').toLowerCase() === 'rejected').length,
        };

        res.json({
            success: true,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit) || 1,
            stats,
            result
        });
    } catch (error) {
        console.error('Error fetching admin events:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching admin events',
            error: error.message
        });
    }
});

// Update event status (Approve or Reject)
app.patch('/api/admin/event/:id/status', async (req, res) => {
    try {
        const database = await connectDB();
        const eventCollection = database.collection('events');
        const id = req.params.id;
        const { status } = req.body;

        if (!status || !['approved', 'rejected', 'pending'].includes(status.toLowerCase())) {
            return res.status(400).json({
                success: false,
                message: 'Invalid status. Must be approved, rejected, or pending.'
            });
        }

        const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id };
        const updateDoc = {
            $set: {
                status: status.toLowerCase(),
                updatedAt: new Date()
            }
        };

        const result = await eventCollection.updateOne(query, updateDoc);

        if (result.matchedCount === 0) {
            return res.status(404).json({
                success: false,
                message: 'Event not found'
            });
        }

        res.json({
            success: true,
            message: `Event status set to ${status}`,
            result
        });
    } catch (error) {
        console.error('Error updating event status:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating event status',
            error: error.message
        });
    }
});

// Delete an Event by ID
app.delete('/api/event/:id', async (req, res) => {
    try {
        const database = await connectDB();
        const eventCollection = database.collection('events');
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await eventCollection.deleteOne(query);
        res.json({
            success: true,
            message: 'Event deleted successfully',
            result
        });
    } catch (error) {
        console.error('Error deleting event:', error);
        res.status(500).json({
            success: false,
            message: 'Error deleting event',
            error: error.message
        });
    }
});

// Update an Event by ID
app.put('/api/event/:id', async (req, res) => {
    try {
        const database = await connectDB();
        const eventCollection = database.collection('events');
        const id = req.params.id;
        const updateData = req.body;

        delete updateData._id;

        if (updateData.ticketPrice !== undefined) updateData.ticketPrice = Number(updateData.ticketPrice);
        if (updateData.availableSeats !== undefined) updateData.availableSeats = Number(updateData.availableSeats);

        const query = { _id: new ObjectId(id) };
        const updateDoc = {
            $set: {
                ...updateData,
                updatedAt: new Date()
            }
        };

        const result = await eventCollection.updateOne(query, updateDoc);
        res.json({
            success: true,
            message: 'Event updated successfully',
            result
        });
    } catch (error) {
        console.error('Error updating event:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating event',
            error: error.message
        });
    }
});

// Get aggregated overview stats for an organizer
app.get('/api/organizer/stats/:organizerEmail', async (req, res) => {
    try {
        const database = await connectDB();
        const orgCollection = database.collection('organization');
        const eventCollection = database.collection('events');
        const organizerEmail = req.params.organizerEmail;

        const orgs = await orgCollection.find({ organizerEmail }).toArray();
        const events = await eventCollection.find({ organizerEmail }).toArray();

        const orgStats = {
            total: orgs.length,
            approved: orgs.filter(o => (o.status || 'pending').toLowerCase() === 'approved').length,
            pending: orgs.filter(o => (o.status || 'pending').toLowerCase() === 'pending').length,
            rejected: orgs.filter(o => (o.status || 'pending').toLowerCase() === 'rejected').length
        };

        const eventStats = {
            total: events.length,
            approved: events.filter(e => (e.status || 'pending').toLowerCase() === 'approved').length,
            pending: events.filter(e => (e.status || 'pending').toLowerCase() === 'pending').length,
            rejected: events.filter(e => (e.status || 'pending').toLowerCase() === 'rejected').length
        };

        res.json({
            success: true,
            orgStats,
            eventStats,
            recentEvents: events.slice(-5).reverse(),
            recentOrgs: orgs.slice(-5).reverse()
        });
    } catch (error) {
        console.error('Error fetching organizer stats:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching stats',
            error: error.message
        });
    }
});


// Ticket Bookings Collection & Management
app.post('/api/bookings', async (req, res) => {
    try {
        const database = await connectDB();
        const bookingCollection = database.collection('bookings');
        const eventCollection = database.collection('events');
        const paymentCollection = database.collection('payments');

        const {
            eventId,
            eventTitle,
            eventBanner,
            eventDate,
            location,
            userEmail,
            userName,
            quantity = 1,
            unitPrice = 0,
            totalPrice = 0,
            paymentStatus = 'paid',
            stripeSessionId = null,
            organizerEmail = null
        } = req.body;

        if (!eventId || !userEmail) {
            return res.status(400).json({
                success: false,
                message: 'Event ID and user email are required'
            });
        }

        const isBlocked = await checkBlockedUser(database, userEmail);
        if (isBlocked) {
            return res.status(403).json({
                success: false,
                isBlocked: true,
                message: 'Your account is currently blocked by an administrator. Ticket booking is restricted.'
            });
        }

        const qty = Math.max(1, Number(quantity));

        // Prevent duplicate processing if stripeSessionId is provided
        if (stripeSessionId) {
            const existingBooking = await bookingCollection.findOne({ stripeSessionId });
            if (existingBooking) {
                return res.json({
                    success: true,
                    message: 'Booking already exists for this session',
                    booking: existingBooking,
                    alreadyProcessed: true
                });
            }
        }

        // Fetch event to verify available seats
        const eventQuery = ObjectId.isValid(eventId) ? { _id: new ObjectId(eventId) } : { _id: eventId };
        const eventDoc = await eventCollection.findOne(eventQuery);

        if (!eventDoc) {
            return res.status(404).json({ success: false, message: 'Event not found' });
        }

        if (eventDoc.availableSeats !== undefined && eventDoc.availableSeats < qty) {
            return res.status(400).json({
                success: false,
                message: `Only ${eventDoc.availableSeats} seats remaining.`
            });
        }

        const ticketCode = `TKT-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

        const newBooking = {
            eventId,
            eventTitle: eventTitle || eventDoc.title,
            eventBanner: eventBanner || eventDoc.banner,
            eventDate: eventDate || eventDoc.date,
            location: location || eventDoc.location,
            category: eventDoc.category || 'General',
            organizerEmail: organizerEmail || eventDoc.organizerEmail,
            userEmail,
            userName: userName || userEmail,
            quantity: qty,
            unitPrice: Number(unitPrice),
            totalPrice: Number(totalPrice),
            paymentStatus: paymentStatus || (unitPrice > 0 ? 'paid' : 'free'),
            stripeSessionId,
            ticketCode,
            status: 'confirmed',
            bookedAt: new Date()
        };

        const bookingResult = await bookingCollection.insertOne(newBooking);

        // Decrement available seats on the event
        await eventCollection.updateOne(
            eventQuery,
            { $inc: { availableSeats: -qty } }
        );

        // Insert payment record if paid
        if (stripeSessionId || totalPrice > 0) {
            await paymentCollection.updateOne(
                { sessionId: stripeSessionId || `free-${bookingResult.insertedId}` },
                {
                    $setOnInsert: {
                        sessionId: stripeSessionId || `free-${bookingResult.insertedId}`,
                        customerEmail: userEmail,
                        customerName: userName || userEmail,
                        eventId,
                        eventTitle: eventTitle || eventDoc.title,
                        amount: Number(totalPrice),
                        quantity: qty,
                        type: 'event_booking',
                        paymentStatus: paymentStatus || 'paid',
                        createdAt: new Date()
                    }
                },
                { upsert: true }
            );
        }

        res.json({
            success: true,
            message: 'Event ticket booked successfully',
            ticketCode,
            bookingId: bookingResult.insertedId,
            booking: { ...newBooking, _id: bookingResult.insertedId }
        });
    } catch (error) {
        console.error('Error creating booking:', error);
        res.status(500).json({
            success: false,
            message: 'Error creating booking',
            error: error.message
        });
    }
});

// Get single Event by ID
app.get('/api/event/:id', async (req, res) => {
    try {
        const database = await connectDB();
        const eventCollection = database.collection('events');
        const id = req.params.id;
        const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id };
        const result = await eventCollection.findOne(query);
        if (!result) {
            return res.status(404).json({ success: false, message: 'Event not found' });
        }
        res.json({ success: true, result });
    } catch (error) {
        console.error('Error fetching event by ID:', error);
        res.status(500).json({ success: false, message: 'Error fetching event', error: error.message });
    }
});

// Get all bookings for a user (Attendee)
app.get('/api/bookings/user/:email', async (req, res) => {
    try {
        const database = await connectDB();
        const bookingCollection = database.collection('bookings');
        const email = req.params.email;

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        const query = { userEmail: email };
        const total = await bookingCollection.countDocuments(query);
        const result = await bookingCollection.find(query).sort({ bookedAt: -1 }).skip(skip).limit(limit).toArray();

        res.json({
            success: true,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit) || 1,
            result
        });
    } catch (error) {
        console.error('Error fetching user bookings:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching user bookings',
            error: error.message
        });
    }
});

// Verify session booking status
app.get('/api/bookings/verify-session/:sessionId', async (req, res) => {
    try {
        const database = await connectDB();
        const bookingCollection = database.collection('bookings');
        const sessionId = req.params.sessionId;

        const booking = await bookingCollection.findOne({
            $or: [
                { stripeSessionId: sessionId },
                { sessionId: sessionId }
            ]
        });

        if (!booking) {
            return res.status(404).json({ success: false, message: 'Booking session not found' });
        }

        res.json({ success: true, booking });
    } catch (error) {
        console.error('Error verifying booking session:', error);
        res.status(500).json({
            success: false,
            message: 'Error verifying booking session',
            error: error.message
        });
    }
});

// payment collections
app.post('/api/payments', async (req, res) => {
    try {
        const database = await connectDB();
        const paymentCollection = database.collection('payments');
        const userCollection = database.collection('user');
        const payment = req.body;

        const userEmail = payment.customerEmail || payment.email || payment.userEmail;

        const paymentData = {
            ...payment,
            customerEmail: userEmail,
            createdAt: payment.createdAt || new Date()
        };

        const result = payment.sessionId
            ? await paymentCollection.updateOne(
                { sessionId: payment.sessionId },
                { $setOnInsert: paymentData },
                { upsert: true }
            )
            : await paymentCollection.insertOne(paymentData);

        let userUpdateResult = null;
        if (userEmail && payment.type !== 'event_booking') {
            userUpdateResult = await userCollection.updateOne(
                { email: userEmail },
                { $set: { isPremium: true, updatedAt: new Date() } }
            );
        }

        res.json({
            success: true,
            message: 'Payment recorded successfully',
            result,
            userUpdateResult
        });
    } catch (error) {
        console.error('Error creating payment session:', error);
        res.status(500).json({
            success: false,
            message: 'Error creating payment session',
            error: error.message
        });
    }
});

// Get payment history for a user (Attendee)
app.get('/api/payments/user/:email', async (req, res) => {
    try {
        const database = await connectDB();
        const paymentCollection = database.collection('payments');
        const bookingCollection = database.collection('bookings');
        const email = req.params.email;

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        const paymentQuery = {
            $or: [
                { customerEmail: email },
                { userEmail: email },
                { email: email }
            ]
        };

        const bookingQuery = { userEmail: email };

        const [paymentDocs, bookingDocs] = await Promise.all([
            paymentCollection.find(paymentQuery).toArray(),
            bookingCollection.find(bookingQuery).toArray()
        ]);

        const sessionMap = new Map();

        // Add payment docs (strictly filtering for event ticket payments only)
        paymentDocs.forEach(p => {
            const isEventTicket = p.type === 'event_booking' || Boolean(p.eventId) || Boolean(p.eventTitle);
            if (!isEventTicket) return;

            const key = p.sessionId || String(p._id);
            sessionMap.set(key, {
                id: String(p._id),
                sessionId: p.sessionId || `PAY-${p._id}`,
                title: p.eventTitle || `Event Ticket Booking (${p.quantity || 1} seats)`,
                amount: Number(p.amount || p.amountTotal || 0),
                quantity: p.quantity || 1,
                type: 'event_booking',
                paymentStatus: p.paymentStatus || 'paid',
                createdAt: p.createdAt ? new Date(p.createdAt) : new Date(),
                customerEmail: p.customerEmail || email
            });
        });

        // Add booking docs if not already present
        bookingDocs.forEach(b => {
            const key = b.stripeSessionId || String(b._id);
            if (!sessionMap.has(key)) {
                sessionMap.set(key, {
                    id: String(b._id),
                    sessionId: b.stripeSessionId || `TKT-${b._id}`,
                    title: b.eventTitle || 'Event Ticket Booking',
                    amount: Number(b.totalPrice || 0),
                    quantity: b.quantity || 1,
                    type: 'event_booking',
                    paymentStatus: b.paymentStatus || 'paid',
                    createdAt: b.bookedAt ? new Date(b.bookedAt) : new Date(),
                    customerEmail: b.userEmail || email,
                    ticketCode: b.ticketCode
                });
            }
        });

        const allPayments = Array.from(sessionMap.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        const total = allPayments.length;
        const paginatedResult = allPayments.slice(skip, skip + limit);

        res.json({
            success: true,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit) || 1,
            result: paginatedResult
        });
    } catch (error) {
        console.error('Error fetching user payment history:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching payment history',
            error: error.message
        });
    }
});

// Get all transactions for admin with stats, pagination, search & type filtering
app.get('/api/admin/transactions', async (req, res) => {
    try {
        const database = await connectDB();
        const paymentCollection = database.collection('payments');
        const paymentCollectionAlt = database.collection('payment');
        const bookingCollection = database.collection('bookings');

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const search = (req.query.search || '').trim().toLowerCase();
        const typeFilter = (req.query.type || 'all').trim().toLowerCase();
        const statusFilter = (req.query.status || 'all').trim().toLowerCase();

        const [paymentDocs1, paymentDocs2, bookingDocs] = await Promise.all([
            paymentCollection.find({}).sort({ createdAt: -1 }).toArray(),
            paymentCollectionAlt.find({}).sort({ createdAt: -1 }).toArray(),
            bookingCollection.find({}).sort({ bookedAt: -1 }).toArray()
        ]);

        const paymentDocs = [...paymentDocs1, ...paymentDocs2];

        const transactionMap = new Map();
        const seenBookingIds = new Set();
        const seenSessionIds = new Set();

        // 1. Process payment collection documents
        paymentDocs.forEach(p => {
            const rawType = (p.type || '').toLowerCase();
            const isEventBooking = rawType === 'event_booking' || Boolean(p.eventId) || (Boolean(p.eventTitle) && !rawType.includes('premium'));
            const isPremium = !isEventBooking || rawType.includes('premium') || rawType.includes('membership') || (!p.eventId && !p.eventTitle);
            const txnType = isPremium ? 'premium_membership' : 'event_booking';

            const sessionId = p.sessionId || p.stripeSessionId;
            const key = sessionId || String(p._id);

            if (sessionId) seenSessionIds.add(sessionId);
            if (p.bookingId) seenBookingIds.add(String(p.bookingId));
            if (p.ticketCode) seenBookingIds.add(p.ticketCode);

            const email = p.customerEmail || p.userEmail || p.email || 'N/A';
            const name = p.customerName || p.userName || p.name || email;
            const rawAmount = p.amount !== undefined ? p.amount : (p.amountTotal !== undefined ? p.amountTotal : 0);
            const amount = Number(rawAmount) > 500 ? Number(rawAmount) / 100 : Number(rawAmount || (isPremium ? 49 : 0));
            const status = (p.paymentStatus || p.status || 'completed').toLowerCase();
            const date = p.createdAt ? new Date(p.createdAt) : (p.updatedAt ? new Date(p.updatedAt) : new Date());

            let item = isPremium
                ? 'Pro Organizer Premium Lifetime Plan'
                : (p.eventTitle ? `Ticket: ${p.eventTitle}` : 'Event Ticket Booking');

            if (!isPremium && p.quantity && p.quantity > 1) {
                item += ` (${p.quantity} tickets)`;
            }

            transactionMap.set(key, {
                id: String(p._id),
                transactionId: sessionId || p.ticketCode || `TXN-${String(p._id).slice(-8).toUpperCase()}`,
                type: txnType,
                item,
                userEmail: email,
                userName: name,
                amount,
                quantity: p.quantity || 1,
                paymentStatus: status,
                date,
                source: 'payments'
            });
        });

        // 2. Process booking collection documents (if not already recorded)
        bookingDocs.forEach(b => {
            const bSessionId = b.stripeSessionId || b.sessionId;
            const bIdStr = String(b._id);
            const bTicketCode = b.ticketCode;

            const isAlreadyMatched =
                (bSessionId && seenSessionIds.has(bSessionId)) ||
                (bSessionId && transactionMap.has(bSessionId)) ||
                seenBookingIds.has(bIdStr) ||
                (bTicketCode && seenBookingIds.has(bTicketCode)) ||
                transactionMap.has(bIdStr);

            if (!isAlreadyMatched) {
                const amount = Number(b.totalPrice !== undefined ? b.totalPrice : (b.unitPrice ? b.unitPrice * (b.quantity || 1) : 0));
                const email = b.userEmail || b.customerEmail || 'N/A';
                const name = b.userName || b.customerName || email;
                const status = (b.paymentStatus || 'completed').toLowerCase();
                const date = b.bookedAt ? new Date(b.bookedAt) : (b.createdAt ? new Date(b.createdAt) : new Date());
                const item = `Ticket: ${b.eventTitle || 'Event Ticket Booking'}${b.quantity > 1 ? ` (${b.quantity} tickets)` : ''}`;
                const key = bSessionId || bIdStr;

                transactionMap.set(key, {
                    id: bIdStr,
                    transactionId: bSessionId || bTicketCode || `TKT-${bIdStr.slice(-8).toUpperCase()}`,
                    type: 'event_booking',
                    item,
                    userEmail: email,
                    userName: name,
                    amount,
                    quantity: b.quantity || 1,
                    paymentStatus: status,
                    date,
                    source: 'bookings'
                });
            }
        });

        let allTransactions = Array.from(transactionMap.values());

        // Overall statistics across all transactions
        const stats = {
            totalRevenue: allTransactions.reduce((acc, t) => acc + (t.paymentStatus === 'completed' || t.paymentStatus === 'paid' ? t.amount : 0), 0),
            totalTransactions: allTransactions.length,
            premiumPurchasesCount: allTransactions.filter(t => t.type === 'premium_membership').length,
            eventBookingsCount: allTransactions.filter(t => t.type === 'event_booking').length
        };

        // Apply filters
        if (typeFilter !== 'all') {
            allTransactions = allTransactions.filter(t => t.type.toLowerCase() === typeFilter);
        }

        if (statusFilter !== 'all') {
            allTransactions = allTransactions.filter(t => t.paymentStatus.toLowerCase() === statusFilter);
        }

        if (search) {
            allTransactions = allTransactions.filter(t =>
                t.transactionId.toLowerCase().includes(search) ||
                t.userEmail.toLowerCase().includes(search) ||
                t.userName.toLowerCase().includes(search) ||
                t.item.toLowerCase().includes(search)
            );
        }

        // Sort by date descending
        allTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));

        const total = allTransactions.length;
        const paginatedResult = allTransactions.slice(skip, skip + limit);

        res.json({
            success: true,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit) || 1,
            stats,
            result: paginatedResult
        });
    } catch (error) {
        console.error('Error fetching admin transactions:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching transactions',
            error: error.message
        });
    }
});

// Get comprehensive system analytics for Admin Dashboard
app.get('/api/admin/analytics', async (req, res) => {
    try {
        const database = await connectDB();
        const userCollection = database.collection('user');
        const orgCollection = database.collection('organization');
        const eventCollection = database.collection('events');
        const bookingCollection = database.collection('bookings');
        const paymentCollection = database.collection('payments');
        const paymentCollectionAlt = database.collection('payment');

        const [
            users,
            orgs,
            events,
            bookings,
            payments1,
            payments2
        ] = await Promise.all([
            userCollection.find({}).toArray(),
            orgCollection.find({}).toArray(),
            eventCollection.find({}).toArray(),
            bookingCollection.find({}).toArray(),
            paymentCollection.find({}).toArray(),
            paymentCollectionAlt.find({}).toArray()
        ]);

        const allPayments = [...payments1, ...payments2];

        // 1. Overall Metrics
        const totalUsers = users.length;
        const totalOrgs = orgs.length;
        const totalEvents = events.length;
        const totalBookings = bookings.length;

        // Calculate Revenue from payments & bookings
        const transactionMap = new Map();
        allPayments.forEach(p => {
            const isPremium = p.type === 'premium_membership' || p.type === 'premium' || (!p.eventId && !p.eventTitle);
            const key = p.sessionId || p.stripeSessionId || String(p._id);
            const rawAmount = p.amount !== undefined ? p.amount : (p.amountTotal !== undefined ? p.amountTotal : 0);
            const amount = Number(rawAmount) > 500 ? Number(rawAmount) / 100 : Number(rawAmount || (isPremium ? 49 : 0));
            const status = (p.paymentStatus || p.status || 'completed').toLowerCase();
            const date = p.createdAt ? new Date(p.createdAt) : new Date();

            transactionMap.set(key, { amount, status, date, type: isPremium ? 'premium' : 'ticket' });
        });

        bookings.forEach(b => {
            const key = b.stripeSessionId || String(b._id);
            if (!transactionMap.has(key)) {
                const amount = Number(b.totalPrice !== undefined ? b.totalPrice : (b.unitPrice ? b.unitPrice * (b.quantity || 1) : 0));
                const status = (b.paymentStatus || 'completed').toLowerCase();
                const date = b.bookedAt ? new Date(b.bookedAt) : (b.createdAt ? new Date(b.createdAt) : new Date());

                transactionMap.set(key, { amount, status, date, type: 'ticket' });
            }
        });

        const allTxns = Array.from(transactionMap.values());
        const totalRevenue = allTxns.reduce((acc, t) => acc + (t.status === 'completed' || t.status === 'paid' ? t.amount : 0), 0);
        const premiumRevenue = allTxns.filter(t => t.type === 'premium' && (t.status === 'completed' || t.status === 'paid')).reduce((acc, t) => acc + t.amount, 0);
        const ticketRevenue = allTxns.filter(t => t.type === 'ticket' && (t.status === 'completed' || t.status === 'paid')).reduce((acc, t) => acc + t.amount, 0);

        // 2. User Role Distribution
        const userRoles = {
            attendees: users.filter(u => (u.role || 'attendee').toLowerCase() === 'attendee').length,
            organizers: users.filter(u => (u.role || '').toLowerCase() === 'organizer').length,
            admins: users.filter(u => (u.role || '').toLowerCase() === 'admin').length,
            active: users.filter(u => !u.isBlocked).length,
            blocked: users.filter(u => u.isBlocked === true).length
        };

        // 3. Event & Organization Status Breakdown
        const eventStatusStats = {
            approved: events.filter(e => (e.status || 'pending').toLowerCase() === 'approved').length,
            pending: events.filter(e => (e.status || 'pending').toLowerCase() === 'pending').length,
            rejected: events.filter(e => (e.status || 'pending').toLowerCase() === 'rejected').length
        };

        const orgStatusStats = {
            approved: orgs.filter(o => (o.status || 'pending').toLowerCase() === 'approved').length,
            pending: orgs.filter(o => (o.status || 'pending').toLowerCase() === 'pending').length,
            rejected: orgs.filter(o => (o.status || 'pending').toLowerCase() === 'rejected').length
        };

        // 4. Event Category Breakdown
        const categoryMap = {};
        events.forEach(e => {
            const cat = e.category || 'General';
            categoryMap[cat] = (categoryMap[cat] || 0) + 1;
        });

        const eventCategories = Object.entries(categoryMap).map(([category, count]) => ({
            category,
            count
        })).sort((a, b) => b.count - a.count);

        // 5. Monthly Revenue & Booking Growth Trend (Last 6 Months)
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const now = new Date();
        const monthlyTrend = [];

        for (let i = 5; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const monthLabel = `${monthNames[d.getMonth()]} ${d.getFullYear() === now.getFullYear() ? '' : d.getFullYear()}`.trim();
            const year = d.getFullYear();
            const month = d.getMonth();

            const monthTxns = allTxns.filter(t => {
                const td = new Date(t.date);
                return td.getFullYear() === year && td.getMonth() === month && (t.status === 'completed' || t.status === 'paid');
            });

            const monthBookings = bookings.filter(b => {
                const bd = new Date(b.bookedAt || b.createdAt || Date.now());
                return bd.getFullYear() === year && bd.getMonth() === month;
            });

            const revenue = monthTxns.reduce((sum, t) => sum + t.amount, 0);
            const tickets = monthBookings.reduce((sum, b) => sum + Number(b.quantity || 1), 0);

            monthlyTrend.push({
                month: monthLabel,
                revenue,
                tickets,
                transactions: monthTxns.length
            });
        }

        // 6. Top Organizations by Event Count
        const orgEventCounts = {};
        events.forEach(e => {
            if (e.organizerEmail) {
                orgEventCounts[e.organizerEmail] = (orgEventCounts[e.organizerEmail] || 0) + 1;
            }
        });

        const topOrganizers = orgs.map(org => ({
            _id: org._id,
            organizationName: org.organizationName,
            logo: org.logo,
            organizerEmail: org.organizerEmail,
            status: org.status || 'pending',
            eventCount: orgEventCounts[org.organizerEmail] || 0
        })).sort((a, b) => b.eventCount - a.eventCount).slice(0, 5);

        res.json({
            success: true,
            summary: {
                totalRevenue,
                premiumRevenue,
                ticketRevenue,
                totalUsers,
                totalOrgs,
                totalEvents,
                totalBookings
            },
            userRoles,
            eventStatusStats,
            orgStatusStats,
            eventCategories,
            monthlyTrend,
            topOrganizers
        });
    } catch (error) {
        console.error('Error generating admin analytics:', error);
        res.status(500).json({
            success: false,
            message: 'Error generating analytics',
            error: error.message
        });
    }
});
// Get Admin Overview Dashboard summary and pending actions
app.get('/api/admin/overview', async (req, res) => {
    try {
        const database = await connectDB();
        const userCollection = database.collection('user');
        const orgCollection = database.collection('organization');
        const eventCollection = database.collection('events');
        const bookingCollection = database.collection('bookings');
        const paymentCollection = database.collection('payments');
        const paymentCollectionAlt = database.collection('payment');

        const [
            users,
            orgs,
            events,
            bookings,
            payments1,
            payments2,
            pendingEvents,
            pendingOrgs
        ] = await Promise.all([
            userCollection.find({}).toArray(),
            orgCollection.find({}).toArray(),
            eventCollection.find({}).toArray(),
            bookingCollection.find({}).toArray(),
            paymentCollection.find({}).toArray(),
            paymentCollectionAlt.find({}).toArray(),
            eventCollection.find({ status: 'pending' }).sort({ createdAt: -1 }).limit(5).toArray(),
            orgCollection.find({ status: 'pending' }).sort({ createdAt: -1 }).limit(5).toArray()
        ]);

        const allPayments = [...payments1, ...payments2];

        // Revenue calculations
        const transactionMap = new Map();
        allPayments.forEach(p => {
            const isPremium = p.type === 'premium_membership' || p.type === 'premium' || (!p.eventId && !p.eventTitle);
            const key = p.sessionId || p.stripeSessionId || String(p._id);
            const rawAmount = p.amount !== undefined ? p.amount : (p.amountTotal !== undefined ? p.amountTotal : 0);
            const amount = Number(rawAmount) > 500 ? Number(rawAmount) / 100 : Number(rawAmount || (isPremium ? 49 : 0));
            const status = (p.paymentStatus || p.status || 'completed').toLowerCase();
            const date = p.createdAt ? new Date(p.createdAt) : new Date();

            const email = p.customerEmail || p.userEmail || p.email || 'N/A';
            const name = p.customerName || p.userName || p.name || email;
            let item = isPremium ? 'Pro Organizer Premium Lifetime Plan' : (p.eventTitle ? `Ticket: ${p.eventTitle}` : 'Event Ticket Booking');

            transactionMap.set(key, {
                id: String(p._id),
                transactionId: key,
                userEmail: email,
                userName: name,
                amount,
                paymentStatus: status,
                date,
                item,
                type: isPremium ? 'premium_membership' : 'event_booking'
            });
        });

        bookings.forEach(b => {
            const key = b.stripeSessionId || String(b._id);
            if (!transactionMap.has(key)) {
                const amount = Number(b.totalPrice !== undefined ? b.totalPrice : (b.unitPrice ? b.unitPrice * (b.quantity || 1) : 0));
                const status = (b.paymentStatus || 'completed').toLowerCase();
                const date = b.bookedAt ? new Date(b.bookedAt) : (b.createdAt ? new Date(b.createdAt) : new Date());
                const email = b.userEmail || b.customerEmail || 'N/A';
                const name = b.userName || b.customerName || email;
                const item = `Ticket: ${b.eventTitle || 'Event Ticket Booking'}`;

                transactionMap.set(key, {
                    id: String(b._id),
                    transactionId: key,
                    userEmail: email,
                    userName: name,
                    amount,
                    paymentStatus: status,
                    date,
                    item,
                    type: 'event_booking'
                });
            }
        });

        const allTxns = Array.from(transactionMap.values());
        allTxns.sort((a, b) => new Date(b.date) - new Date(a.date));

        const totalRevenue = allTxns.reduce((acc, t) => acc + (t.paymentStatus === 'completed' || t.paymentStatus === 'paid' ? t.amount : 0), 0);
        const recentTransactions = allTxns.slice(0, 5);

        const summary = {
            totalRevenue,
            totalUsers: users.length,
            totalOrgs: orgs.length,
            totalEvents: events.length,
            pendingEventsCount: events.filter(e => (e.status || 'pending').toLowerCase() === 'pending').length,
            pendingOrgsCount: orgs.filter(o => (o.status || 'pending').toLowerCase() === 'pending').length,
            approvedEventsCount: events.filter(e => (e.status || '').toLowerCase() === 'approved').length,
            approvedOrgsCount: orgs.filter(o => (o.status || '').toLowerCase() === 'approved').length
        };

        res.json({
            success: true,
            summary,
            pendingEvents,
            pendingOrgs,
            recentTransactions
        });
    } catch (error) {
        console.error('Error generating admin overview:', error);
        res.status(500).json({
            success: false,
            message: 'Error generating overview',
            error: error.message
        });
    }
});

// Start local server if not on Vercel
if (process.env.NODE_ENV !== 'production') {
    app.listen(port);
}

// Export app for Vercel Serverless Function
module.exports = app;
