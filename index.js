require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion } = require('mongodb');

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        await client.connect();
        const db = client.db(process.env.DB_NAME);
        // database collection
        const userCollection = db.collection('user')


        // get specfic user information
        app.get('/api/user/:id', async (req, res) => {
            const id = req.params.id;
            const query = { email: id };
            const result = await userCollection.findOne(query);
            res.send(result);
        })
        // update user information
        app.patch('/api/user/:email', async (req, res) => {
            try {
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
                res.status(500).json({
                    success: false,
                    message: 'Error updating user',
                    error: error.message
                });
            }
        });

        await db.command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } catch (error) {
        console.error("MongoDB connection error:", error);
    }
}
run().catch(console.dir);

app.get('/', (req, res) => {
    res.send('Hello World!');
});

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});
