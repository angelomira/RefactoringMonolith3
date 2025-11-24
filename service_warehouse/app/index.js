const express = require('express');
const cors = require('cors');
const { connectDatabase } = require('./database');
const { connectRedis, redisClient } = require('./redis_client');
const { StockItem } = require('./models');

const app = express();
const PORT = process.env.PORT || 3003;

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
function getCacheKey(itemId) {
    return `stock:${itemId}`;
}

// GET all stock items with optional filter by SKU
app.get('/stock', async (req, res) => {
    try {
        const sku = req.query.sku;
        
        let items;
        if (sku) {
            items = await StockItem.findAll({
                where: { sku: sku }
            });
        } else {
            items = await StockItem.findAll();
        }
        
        res.json(items);
    } catch (error) {
        console.error('Error fetching stock items:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST create stock item
app.post('/stock', async (req, res) => {
    try {
        const { sku, name, quantity, min_quantity } = req.body;

        if (!sku || !name) {
            return res.status(400).json({ error: 'SKU and name are required' });
        }

        const newItem = await StockItem.create({
            sku,
            name,
            quantity: quantity || 0,
            min_quantity: min_quantity || 0
        });

        // Invalidate cache for this item (if it exists)
        const cacheKey = getCacheKey(newItem.id);
        await redisClient.del(cacheKey);

        res.status(201).json(newItem);
    } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError') {
            return res.status(400).json({ error: 'SKU already exists' });
        }
        console.error('Error creating stock item:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET stock item by ID (with caching)
app.get('/stock/:id', async (req, res) => {
    try {
        const itemId = parseInt(req.params.id);
        const cacheKey = getCacheKey(itemId);

        // Try to get from cache first
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            console.log(`Cache hit for stock item ${itemId}`);
            return res.json(JSON.parse(cachedData));
        }

        console.log(`Cache miss for stock item ${itemId}`);
        
        // If not in cache, get from database
        const item = await StockItem.findByPk(itemId);

        if (!item) {
            return res.status(404).json({ error: 'Stock item not found' });
        }

        // Store in cache with TTL
        await redisClient.setEx(cacheKey, CACHE_TTL, JSON.stringify(item));

        res.json(item);
    } catch (error) {
        console.error('Error fetching stock item:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT update stock item (mainly for updating quantity)
app.put('/stock/:id', async (req, res) => {
    try {
        const itemId = parseInt(req.params.id);
        const { sku, name, quantity, min_quantity } = req.body;

        const item = await StockItem.findByPk(itemId);

        if (!item) {
            return res.status(404).json({ error: 'Stock item not found' });
        }

        // Update item
        if (sku) item.sku = sku;
        if (name) item.name = name;
        if (quantity !== undefined) item.quantity = quantity;
        if (min_quantity !== undefined) item.min_quantity = min_quantity;

        await item.save();

        // Invalidate cache
        const cacheKey = getCacheKey(itemId);
        await redisClient.del(cacheKey);

        // Check if quantity is below minimum
        if (item.quantity < item.min_quantity) {
            console.warn(`Warning: Stock item ${item.sku} (${item.name}) is below minimum quantity. Current: ${item.quantity}, Min: ${item.min_quantity}`);
        }

        res.json(item);
    } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError') {
            return res.status(400).json({ error: 'SKU already exists' });
        }
        console.error('Error updating stock item:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE stock item
app.delete('/stock/:id', async (req, res) => {
    try {
        const itemId = parseInt(req.params.id);

        const item = await StockItem.findByPk(itemId);

        if (!item) {
            return res.status(404).json({ error: 'Stock item not found' });
        }

        const deletedItem = item.toJSON();
        await item.destroy();

        // Invalidate cache
        const cacheKey = getCacheKey(itemId);
        await redisClient.del(cacheKey);

        res.json({ message: 'Stock item deleted', deletedItem });
    } catch (error) {
        console.error('Error deleting stock item:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Status endpoint
app.get('/stock/status', (req, res) => {
    res.json({ status: 'Warehouse service is running' });
});

// Health check endpoint
app.get('/stock/health', (req, res) => {
    res.json({
        status: 'OK',
        service: 'Warehouse Service',
        timestamp: new Date().toISOString()
    });
});

// Start server
initialize().then(() => {
    app.listen(PORT, () => {
        console.log(`Warehouse service running on port ${PORT}`);
    });
});
