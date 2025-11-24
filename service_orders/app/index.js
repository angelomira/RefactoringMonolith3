const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { connectDatabase } = require('./database');
const { connectRedis, redisClient } = require('./redis_client');
const { Order } = require('./models');

const app = express();
const PORT = process.env.PORT || 3002;
const WAREHOUSE_SERVICE_URL = process.env.WAREHOUSE_SERVICE_URL || 'http://service_warehouse:3003';

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
function getCacheKey(orderId) {
    return `order:${orderId}`;
}

// GET all orders with optional filter by user_id
app.get('/orders', async (req, res) => {
    try {
        const userId = req.query.user_id ? parseInt(req.query.user_id) : null;
        
        let orders;
        if (userId) {
            orders = await Order.findAll({
                where: { user_id: userId }
            });
        } else {
            orders = await Order.findAll();
        }
        
        res.json(orders);
    } catch (error) {
        console.error('Error fetching orders:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST create order
app.post('/orders', async (req, res) => {
    try {
        const { user_id, product, amount, status } = req.body;

        if (!user_id || !product) {
            return res.status(400).json({ error: 'user_id and product are required' });
        }

        // Create order
        const newOrder = await Order.create({
            user_id,
            product,
            amount: amount || 0.00,
            status: status || 'pending'
        });

        // Простая интеграция со складом: попытка уменьшить количество товара
        // В реальном проекте здесь должна быть более сложная логика с транзакциями
        try {
            // Попытка найти товар на складе по имени продукта (SKU)
            const stockResponse = await axios.get(`${WAREHOUSE_SERVICE_URL}/stock?sku=${encodeURIComponent(product)}`);
            
            if (stockResponse.data && stockResponse.data.length > 0) {
                const stockItem = stockResponse.data[0];
                
                // Проверяем доступность товара
                if (stockItem.quantity > 0) {
                    // Уменьшаем количество на 1 (или можно добавить поле quantity в Order)
                    await axios.put(`${WAREHOUSE_SERVICE_URL}/stock/${stockItem.id}`, {
                        quantity: stockItem.quantity - 1
                    });
                    console.log(`Stock decreased for product ${product}`);
                } else {
                    console.warn(`Product ${product} is out of stock, but order created anyway`);
                }
            }
        } catch (warehouseError) {
            // Если склад недоступен, логируем ошибку, но заказ всё равно создаём
            console.error('Failed to update warehouse:', warehouseError.message);
        }

        // Invalidate cache for this order (if it exists)
        const cacheKey = getCacheKey(newOrder.id);
        await redisClient.del(cacheKey);

        res.status(201).json(newOrder);
    } catch (error) {
        console.error('Error creating order:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// GET order by ID (with caching)
app.get('/orders/:orderId', async (req, res) => {
    try {
        const orderId = parseInt(req.params.orderId);
        const cacheKey = getCacheKey(orderId);

        // Try to get from cache first
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            console.log(`Cache hit for order ${orderId}`);
            return res.json(JSON.parse(cachedData));
        }

        console.log(`Cache miss for order ${orderId}`);
        
        // If not in cache, get from database
        const order = await Order.findByPk(orderId);

        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }

        // Store in cache with TTL
        await redisClient.setEx(cacheKey, CACHE_TTL, JSON.stringify(order));

        res.json(order);
    } catch (error) {
        console.error('Error fetching order:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PUT update order
app.put('/orders/:orderId', async (req, res) => {
    try {
        const orderId = parseInt(req.params.orderId);
        const { user_id, product, amount, status } = req.body;

        const order = await Order.findByPk(orderId);

        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }

        // Update order
        if (user_id !== undefined) order.user_id = user_id;
        if (product) order.product = product;
        if (amount !== undefined) order.amount = amount;
        if (status) order.status = status;

        await order.save();

        // Invalidate cache
        const cacheKey = getCacheKey(orderId);
        await redisClient.del(cacheKey);

        res.json(order);
    } catch (error) {
        console.error('Error updating order:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// DELETE order
app.delete('/orders/:orderId', async (req, res) => {
    try {
        const orderId = parseInt(req.params.orderId);

        const order = await Order.findByPk(orderId);

        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }

        const deletedOrder = order.toJSON();
        await order.destroy();

        // Invalidate cache
        const cacheKey = getCacheKey(orderId);
        await redisClient.del(cacheKey);

        res.json({ message: 'Order deleted', deletedOrder });
    } catch (error) {
        console.error('Error deleting order:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Status endpoint
app.get('/orders/status', (req, res) => {
    res.json({ status: 'Orders service is running' });
});

// Health check endpoint
app.get('/orders/health', (req, res) => {
    res.json({
        status: 'OK',
        service: 'Orders Service',
        timestamp: new Date().toISOString()
    });
});

// Start server
initialize().then(() => {
    app.listen(PORT, () => {
        console.log(`Orders service running on port ${PORT}`);
    });
});
