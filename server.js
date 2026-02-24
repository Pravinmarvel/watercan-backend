// =====================================================
// WATERCAN BACKEND - PRODUCTION READY v2.2.0
// =====================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { pool, initializeDatabase } = require('./db');
const app = express();
const PORT = process.env.PORT || 3000;

// =====================================================
// MIDDLEWARE
// =====================================================
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// =====================================================
// HEALTH & ROOT ENDPOINTS
// =====================================================

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'WaterCan Backend API',
    status: 'running',
    version: '2.2.0',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/health',
      users: '/api/users',
      orders: '/api/orders',
      apartments: '/api/apartments',
      distributors: '/api/distributors',
      canStatus: '/api/can-status',
      subscriptions: '/api/subscriptions',
      returns: '/api/returns'
    }
  });
});

// Health check endpoint (proper implementation)
app.get('/health', async (req, res) => {
  try {
    // Test database connection
    const dbCheck = await pool.query('SELECT NOW()');
    
    res.json({ 
      status: 'ok',
      service: 'watercan-backend',
      version: '2.2.0',
      timestamp: new Date().toISOString(),
      database: 'connected',
      uptime: process.uptime(),
      dbTime: dbCheck.rows[0].now
    });
  } catch (error) {
    res.status(503).json({
      status: 'error',
      service: 'watercan-backend',
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: error.message
    });
  }
});

// =====================================================
// API ROUTES
// =====================================================

// Import ALL route modules
const userRoutes = require('./routes/users');
const distributorRoutes = require('./routes/distributors');
const returnRoutes = require('./routes/returns');
const orderRoutes = require('./routes/orders');
const canStatusRoutes = require('./routes/canstatus');
const subscriptionRoutes = require('./routes/subscriptions');
const apartmentRoutes = require('./routes/apartments');

// Mount ALL routes
app.use('/api/users', userRoutes);
app.use('/api/distributors', distributorRoutes);
app.use('/api/returns', returnRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/can-status', canStatusRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/apartments', apartmentRoutes);

// =====================================================
// ERROR HANDLING
// =====================================================

// 404 handler
app.use((req, res) => {
  console.log(`❌ 404 - Route not found: ${req.method} ${req.path}`);
  res.status(404).json({ 
    error: 'Route not found',
    path: req.path,
    method: req.method,
    message: `The endpoint ${req.method} ${req.path} does not exist`
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('❌ Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// =====================================================
// DATABASE INITIALIZATION & SERVER START
// =====================================================

async function startServer() {
  try {
    console.log('🔄 Initializing database...');
    await initializeDatabase();
    console.log('✅ Database initialized');
    
    app.listen(PORT, () => {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`🚀 WaterCan Server Running - v2.2.0`);
      console.log(`${'='.repeat(60)}`);
      console.log(`📍 Port: ${PORT}`);
      console.log(`📍 URL: https://watercan-backend-gdkp.onrender.com`);
      console.log(`📍 Health: https://watercan-backend-gdkp.onrender.com/health`);
      console.log(`📍 API Base: https://watercan-backend-gdkp.onrender.com/api`);
      console.log(`\n📋 Mounted Routes:`);
      console.log(`   ✅ GET  /              - API info`);
      console.log(`   ✅ GET  /health        - Health check`);
      console.log(`   ✅ POST /api/users     - User routes`);
      console.log(`   ✅ POST /api/orders    - Order routes (CRITICAL!)`);
      console.log(`   ✅ GET  /api/apartments/:id/residents - Get residents with orders`);
      console.log(`   ✅ PUT  /api/can-status - Can status routes`);
      console.log(`   ✅ POST /api/subscriptions - Subscription routes`);
      console.log(`   ✅ POST /api/distributors - Distributor routes`);
      console.log(`   ✅ POST /api/returns   - Return routes`);
      console.log(`\n⚙️  Environment: ${process.env.NODE_ENV || 'production'}`);
      console.log(`⚙️  Database: ${pool ? 'Connected' : 'Disconnected'}`);
      console.log(`${'='.repeat(60)}\n`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n👋 SIGTERM received. Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n👋 SIGINT received. Shutting down gracefully...');
  process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the server
startServer();

module.exports = app;