const express = require('express');
const cors = require('cors');
const { connectDatabase } = require('./database');
const { connectRedis, redisClient } = require('./redis_client');
const { User } = require('./models');

const app = express();
const PORT = process.env.PORT || 3001;

// middleware
app.use(cors());
app.use(express.json());

// Cache TTL in seconds (5 minutes)
const CACHE_TTL = 300;

// Initialize database and Redis
async function initialize() {
    try {
        await connectDatabase();
        await connectRedis();
        console.log('All connections initialized successfully');
    } catch (error) {
        console.error('Failed to initialize connections:', error);
        process.exit(1);
    }
}

// Helper function to get cache key
function getCacheKey(userId) {
    return `user:${userId}`;
}

// GET all users
app.get('/users', async (req, res) => {
    try {
        const users = await User.findAll();
        res.json(users);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST create user
app.post('/users', async (req, res) => {
    try {
        const { email, full_name } = req.body;

        if (!email || !full_name) {
            return res.status(400).json({ error: 'Email and full_name are required' });
        }

        const newUser = await User.create({ email, full_name });

        // Invalidate cache for this user (if it exists)
        const cacheKey = getCacheKey(newUser.id);
        await redisClient.del(cacheKey);

        res.status(201).json(newUser);
    } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError') {
            return res.status(400).json({ error: 'Email already exists' });
        }
        console.error('Error creating user:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET user by ID (with caching)
app.get('/users/:userId', async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const cacheKey = getCacheKey(userId);

        // Try to get from cache first
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            console.log(`Cache hit for user ${userId}`);
            return res.json(JSON.parse(cachedData));
        }

        console.log(`Cache miss for user ${userId}`);
        
        // If not in cache, get from database
        const user = await User.findByPk(userId);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Store in cache with TTL
        await redisClient.setEx(cacheKey, CACHE_TTL, JSON.stringify(user));

        res.json(user);
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT update user
app.put('/users/:userId', async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const { email, full_name } = req.body;

        const user = await User.findByPk(userId);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Update user
        if (email) user.email = email;
        if (full_name) user.full_name = full_name;

        await user.save();

        // Invalidate cache
        const cacheKey = getCacheKey(userId);
        await redisClient.del(cacheKey);

        res.json(user);
    } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError') {
            return res.status(400).json({ error: 'Email already exists' });
        }
        console.error('Error updating user:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE user
app.delete('/users/:userId', async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);

        const user = await User.findByPk(userId);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const deletedUser = user.toJSON();
        await user.destroy();

        // Invalidate cache
        const cacheKey = getCacheKey(userId);
        await redisClient.del(cacheKey);

        res.json({ message: 'User deleted', deletedUser });
    } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Health check endpoint
app.get('/users/health', (req, res) => {
    res.json({
        status: 'OK',
        service: 'Users Service',
        timestamp: new Date().toISOString()
    });
});

// Status endpoint
app.get('/users/status', (req, res) => {
    res.json({ status: 'Users service is running' });
});

// Start server
initialize().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Users service running on port ${PORT}`);
    });
});
