const { Sequelize } = require('sequelize');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:password@localhost:5432/users_db';

const sequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    logging: false,
    pool: {
        max: 5,
        min: 0,
        acquire: 30000,
        idle: 10000
    }
});

async function connectDatabase() {
    try {
        await sequelize.authenticate();
        console.log('Database connection established successfully.');
        
        // Sync models (for simplicity, in production use migrations)
        await sequelize.sync({ alter: true });
        console.log('Database models synchronized.');
    } catch (error) {
        console.error('Unable to connect to the database:', error);
        throw error;
    }
}

module.exports = { sequelize, connectDatabase };
