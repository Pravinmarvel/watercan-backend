const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} - ${req.method} ${req.path}`);
  next();
});

// Initialize database connection
let dbInitialized = false;

async function initializeDatabase() {
  try {
    const { pool } = require('./config/database');
    const result = await pool.query('SELECT NOW()');
    console.log('✅ Database connected at', result.rows[0].now);
    dbInitialized = true;
    return pool;
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    console.error('Please check your .env file and ensure PostgreSQL is running');
    process.exit(1);
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Server is running',
    database: dbInitialized ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  });
});

// Database test endpoint
app.get('/db-test', async (req, res) => {
  try {
    const { pool } = require('./config/database');
    const result = await pool.query('SELECT NOW()');
    res.json({ 
      status: 'ok', 
      message: 'Database connection successful',
      timestamp: result.rows[0].now
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      message: 'Database connection failed',
      error: error.message
    });
  }
});

// Import middleware
const { authenticateToken } = require('./middleware/auth');

// Import routes
const usersRoutes = require('./routes/users');
const ordersRoutes = require('./routes/orders');
const addressesRoutes = require('./routes/addresses');
const paymentsRoutes = require('./routes/payments');
const subscriptionsRoutes = require('./routes/subscriptions');
const canStatusRoutes = require('./routes/canstatus');

// Apply routes
app.use('/api/users', usersRoutes);
app.use('/api/orders', authenticateToken, ordersRoutes);
app.use('/api/addresses', authenticateToken, addressesRoutes);
app.use('/api/payments', authenticateToken, paymentsRoutes);
app.use('/api/subscriptions', authenticateToken, subscriptionsRoutes);
app.use('/api/can-status', authenticateToken, canStatusRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('❌ Global error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Start server after database initialization
async function startServer() {
  await initializeDatabase();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔═══════════════════════════════════════════╗
║   🚀 Server is running on port ${PORT}     ║
║   📱 Ready for connections                 ║
║   🔗 http://localhost:${PORT}              ║
╚═══════════════════════════════════════════╝
    `);
    console.log('✅ All systems ready!');
    console.log('');
    console.log('API Endpoints:');
    console.log(`  → GET  /health`);
    console.log(`  → GET  /db-test`);
    console.log(`  → POST /api/users/register`);
    console.log(`  → POST /api/users/login`);
    console.log(`  → GET  /api/users/profile`);
    console.log(`  → PUT  /api/users/profile`);
    console.log(`  → GET  /api/addresses`);
    console.log(`  → POST /api/addresses`);
    console.log(`  → GET  /api/orders`);
    console.log(`  → POST /api/orders`);
    console.log(`  → POST /api/payments`);
    console.log(`  → GET  /api/subscriptions`);
    console.log(`  → POST /api/subscriptions`);
    console.log(`  → GET  /api/can-status`);
    console.log(`  → PUT  /api/can-status`);
    console.log('');
  });
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  const { pool } = require('./config/database');
  pool.end(() => {
    console.log('Database pool closed');
    process.exit(0);
  });
});

// Start the server
startServer().catch(err => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});
