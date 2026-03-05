// =====================================================
// WATERCAN BACKEND - COMPLETE FIXED SERVER
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
// ROUTES
// =====================================================

// Health check
app.get('/', (req, res) => {
  res.json({
    message: 'WaterCan Backend API',
    status: 'running',
    version: '2.2.0',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    database: pool ? 'connected' : 'disconnected'
  });
});

// ✅ Import ALL route modules
const userRoutes = require('./routes/users');
const distributorRoutes = require('./routes/distributors');
const returnRoutes = require('./routes/returns');
const orderRoutes = require('./routes/orders');
const canStatusRoutes = require('./routes/canstatus');
const subscriptionRoutes = require('./routes/subscriptions');
const apartmentRoutes = require('./routes/apartments');

// =====================================================
// ✅ MOUNT ALL ROUTES - FIXED ORDER!
// =====================================================

// User routes
app.use('/api/users', userRoutes);

// Distributor routes
app.use('/api/distributors', distributorRoutes);

// Return routes
app.use('/api/returns', returnRoutes);

// Order routes
app.use('/api/orders', orderRoutes);

// ✅ Can Status routes - BOTH FORMATS!
app.use('/api/can-status', canStatusRoutes);  // For: /api/can-status
app.use('/api/users/:userId/can-status', canStatusRoutes);  // For: /api/users/1/can-status ✅ CRITICAL FIX!

// Subscription routes
app.use('/api/subscriptions', subscriptionRoutes);

// Apartment routes
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
    method: req.method
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
      console.log(`🚀 WaterCan Server Running - v2.2.0 (Can Status Fixed!)`);
      console.log(`${'='.repeat(60)}`);
      console.log(`📍 Port: ${PORT}`);
      console.log(`📍 Health: http://localhost:${PORT}/health`);
      console.log(`📍 API Base: http://localhost:${PORT}/api`);
      console.log(`\n📋 Mounted Routes:`);
      console.log(`   ✅ /api/users                     - User authentication & profile`);
      console.log(`   ✅ /api/orders                    - Order management`);
      console.log(`   ✅ /api/can-status                - Can status (distributor)`);
      console.log(`   ✅ /api/users/:userId/can-status  - Can status (user-specific) 🆕`);
      console.log(`   ✅ /api/subscriptions             - Subscription management`);
      console.log(`   ✅ /api/distributors              - Distributor management`);
      console.log(`   ✅ /api/returns                   - Return management`);
      console.log(`   ✅ /api/apartments                - Apartment residents & orders`);
      console.log(`\n⚙️  Environment: ${process.env.NODE_ENV || 'development'}`);
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

// Start the server
startServer();

module.exports = app;