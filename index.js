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
        const userCollection = database.collection('user');
        const email = req.params.email;
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

// Create a new Organization
app.post('/api/organization', async (req, res) => {
    try {
        const database = await connectDB();
        const orgCollection = database.collection('organization');
        const userCollection = database.collection('user');
        const orgData = req.body;

        const { organizerEmail } = orgData;

        if (organizerEmail) {
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

        const booking = await bookingCollection.findOne({ stripeSessionId: sessionId });
        if (booking) {
            return res.json({ success: true, processed: true, booking });
        }
        res.json({ success: true, processed: false });
    } catch (error) {
        console.error('Error verifying booking session:', error);
        res.status(500).json({ success: false, message: 'Error verifying session', error: error.message });
    }
});



// Start local server if not on Vercel
if (process.env.NODE_ENV !== 'production') {
    app.listen(port);
}

// Export app for Vercel Serverless Function
module.exports = app;
