const express = require('express');
const cors = require('cors');
const axios = require('axios');
const CircuitBreaker = require('opossum');

const app = express();
const PORT = process.env.PORT || 8000;

// middleware
app.use(cors());
app.use(express.json());

// адреса сервисов (в docker)
const USERS_SERVICE_URL = 'http://service_users:8000';
const ORDERS_SERVICE_URL = 'http://service_orders:8000';

// конфигурация circuit breaker
const circuitOptions = {
    timeout: 3000, // время ожидания запроса (3 секунды)
    errorThresholdPercentage: 50, // открываем breaker после 50% неудачных запросов
    resetTimeout: 3000, // ожидаем 3 секунды перед попыткой закрыть breaker
};

// создаем breaker для каждой службы
const usersCircuit = new CircuitBreaker(async (url, options = {}) => {
    try {
        const response = await axios({
            url, ...options,
            validateStatus: status => (status >= 200 && status < 300) || status === 404
        });
        return response.data;
    } catch (error) {
        if (error.response && error.response.status === 404) {
            return error.response.data;
        }
        throw error;
    }
}, circuitOptions);

const ordersCircuit = new CircuitBreaker(async (url, options = {}) => {
    try {
        const response = await axios({
            url, ...options,
            validateStatus: status => (status >= 200 && status < 300) || status === 404
        });
        return response.data;
    } catch (error) {
        if (error.response && error.response.status === 404) {
            return error.response.data;
        }
        throw error;
    }
}, circuitOptions);

// функции резервирования (fallback functions)
usersCircuit.fallback(() => ({error: 'Users service temporarily unavailable'}));
ordersCircuit.fallback(() => ({error: 'Orders service temporarily unavailable'}));

// роутинги с circuit breaker
app.get('/users/:userId', async (req, res) => {
    try {
        const user = await usersCircuit.fire(`${USERS_SERVICE_URL}/users/${req.params.userId}`);
        if (user.error === 'User not found') {
            res.status(404).json(user);
        } else {
            res.json(user);
        }
    } catch (error) {
        res.status(500).json({error: 'Internal server error'});
    }
});

app.post('/users', async (req, res) => {
    try {
        const user = await usersCircuit.fire(`${USERS_SERVICE_URL}/users`, {
            method: 'POST',
            data: req.body
        });
        res.status(201).json(user);
    } catch (error) {
        res.status(500).json({error: 'Internal server error'});
    }
});

app.get('/users', async (req, res) => {
    try {
        const users = await usersCircuit.fire(`${USERS_SERVICE_URL}/users`);
        res.json(users);
    } catch (error) {
        res.status(500).json({error: 'Internal server error'});
    }
});

app.delete('/users/:userId', async (req, res) => {
    try {
        const result = await usersCircuit.fire(`${USERS_SERVICE_URL}/users/${req.params.userId}`, {
            method: 'DELETE'
        });
        res.json(result);
    } catch (error) {
        res.status(500).json({error: 'Internal server error'});
    }
});

app.put('/users/:userId', async (req, res) => {
    try {
        const user = await usersCircuit.fire(`${USERS_SERVICE_URL}/users/${req.params.userId}`, {
            method: 'PUT',
            data: req.body
        });
        res.json(user);
    } catch (error) {
        res.status(500).json({error: 'Internal server error'});
    }
});

app.get('/orders/:orderId', async (req, res) => {
    try {
        const order = await ordersCircuit.fire(`${ORDERS_SERVICE_URL}/orders/${req.params.orderId}`);
        if (order.error === 'Order not found') {
            res.status(404).json(order);
        } else {
            res.json(order);
        }
    } catch (error) {
        res.status(500).json({error: 'Internal server error'});
    }
});

app.post('/orders', async (req, res) => {
    try {
        const order = await ordersCircuit.fire(`${ORDERS_SERVICE_URL}/orders`, {
            method: 'POST',
            data: req.body
        });
        res.status(201).json(order);
    } catch (error) {
        res.status(500).json({error: 'Internal server error'});
    }
});

app.get('/orders', async (req, res) => {
    try {
        const orders = await ordersCircuit.fire(`${ORDERS_SERVICE_URL}/orders`);
        res.json(orders);
    } catch (error) {
        res.status(500).json({error: 'Internal server error'});
    }
});

app.delete('/orders/:orderId', async (req, res) => {
    try {
        const result = await ordersCircuit.fire(`${ORDERS_SERVICE_URL}/orders/${req.params.orderId}`, {
            method: 'DELETE'
        });
        res.json(result);
    } catch (error) {
        res.status(500).json({error: 'Internal server error'});
    }
});

app.put('/orders/:orderId', async (req, res) => {
    try {
        const order = await ordersCircuit.fire(`${ORDERS_SERVICE_URL}/orders/${req.params.orderId}`, {
            method: 'PUT',
            data: req.body
        });
        res.json(order);
    } catch (error) {
        res.status(500).json({error: 'Internal server error'});
    }
});

app.get('/orders/status', async (req, res) => {
    try {
        const status = await ordersCircuit.fire(`${ORDERS_SERVICE_URL}/orders/status`);
        res.json(status);
    } catch (error) {
        res.status(500).json({error: 'Internal server error'});
    }
});

app.get('/orders/health', async (req, res) => {
    try {
        const health = await ordersCircuit.fire(`${ORDERS_SERVICE_URL}/orders/health`);
        res.json(health);
    } catch (error) {
        res.status(500).json({error: 'Internal server error'});
    }
});

// gateway aggregation: получение сведений о пользователе с его заказами
app.get('/users/:userId/details', async (req, res) => {
    try {
        const userId = req.params.userId;

        // получение сведений о пользователе
        const userPromise = usersCircuit.fire(`${USERS_SERVICE_URL}/users/${userId}`);

        // получение заказов пользователя (предполагается, что заказы содержат поле userId)
        const ordersPromise = ordersCircuit.fire(`${ORDERS_SERVICE_URL}/orders`)
            .then(orders => orders.filter(order => order.userId == userId));

        // ожидание завершения обоих запросов
        const [user, userOrders] = await Promise.all([userPromise, ordersPromise]);

        // если пользователь не найден, возвращаем 404
        if (user.error === 'User not found') {
            return res.status(404).json(user);
        }

        // возвращаем агрегированный ответ
        res.json({
            user,
            orders: userOrders
        });
    } catch (error) {
        res.status(500).json({error: 'Internal server error'});
    }
});

// эндпоинт проверки состояния, показывающий статус circuit breaker
app.get('/health', (req, res) => {
    res.json({
        status: 'API Gateway is running',
        circuits: {
            users: {
                status: usersCircuit.status,
                stats: usersCircuit.stats
            },
            orders: {
                status: ordersCircuit.status,
                stats: ordersCircuit.stats
            }
        }
    });
});

app.get('/status', (req, res) => {
    res.json({status: 'API Gateway is running'});
});

// запуск сервера
app.listen(PORT, () => {
    console.log(`API Gateway running on port ${PORT}`);

    // логируем события circuit breaker для мониторинга
    usersCircuit.on('open', () => console.log('Users circuit breaker opened'));
    usersCircuit.on('close', () => console.log('Users circuit breaker closed'));
    usersCircuit.on('halfOpen', () => console.log('Users circuit breaker half-open'));

    ordersCircuit.on('open', () => console.log('Orders circuit breaker opened'));
    ordersCircuit.on('close', () => console.log('Orders circuit breaker closed'));
    ordersCircuit.on('halfOpen', () => console.log('Orders circuit breaker half-open'));
});