require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion } = require('mongodb');

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
        const orgData = req.body;

        console.log('Received organization data:', orgData);

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


// Start local server if not on Vercel
if (process.env.NODE_ENV !== 'production') {
    app.listen(port, () => {
        console.log(`Server listening on port ${port}`);
    });
}

// Export app for Vercel Serverless Function
module.exports = app;
