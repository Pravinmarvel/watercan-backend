// =====================================================
// WATERCAN BACKEND - WITH FIREBASE ADMIN SDK
// =====================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { pool, initializeDatabase } = require('./db');
const app = express();
const PORT = process.env.PORT || 3000;

// =====================================================
// FIREBASE ADMIN SDK INITIALIZATION
// =====================================================
const admin = require('firebase-admin');

try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID || 'watercan-a1499',
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL || 'firebase-adminsdk-fbsvc@watercan-a1499.iam.gserviceaccount.com',
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n') || 
        process.env.FIREBASE_PRIVATE_KEY_RAW
    })
  });
  console.log('✅ Firebase Admin SDK initialized successfully');
} catch (error) {
  console.error('❌ Firebase Admin init failed:', error.message);
  console.error('⚠️ Notifications will not work without Firebase Admin SDK');
  console.error('Check environment variables: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY');
}

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
    version: '2.3.0',
    firebase: admin.apps.length > 0 ? 'initialized' : 'not initialized',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    database: pool ? 'connected' : 'disconnected',
    firebase: admin.apps.length > 0 ? 'ready' : 'not initialized'
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
// ✅ MOUNT ALL ROUTES
// =====================================================

app.use('/api/users', userRoutes);
app.use('/api/distributors', distributorRoutes);
app.use('/api/returns', returnRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/can-status', canStatusRoutes);
app.use('/api/users/:userId/can-status', canStatusRoutes);  // ✅ User-specific route
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/apartments', apartmentRoutes);

// =====================================================
// ERROR HANDLING
// =====================================================

app.use((req, res) => {
  console.log(`❌ 404 - Route not found: ${req.method} ${req.path}`);
  res.status(404).json({ 
    error: 'Route not found',
    path: req.path,
    method: req.method
  });
});

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
      console.log(`\n${'='.repeat(70)}`);
      console.log(`🚀 WaterCan Server Running - v2.3.0 (Firebase Notifications!)`);
      console.log(`${'='.repeat(70)}`);
      console.log(`📍 Port: ${PORT}`);
      console.log(`📍 Health: http://localhost:${PORT}/health`);
      console.log(`📍 API Base: http://localhost:${PORT}/api`);
      console.log(`\n📋 Mounted Routes:`);
      console.log(`   ✅ /api/users                     - User authentication & profile`);
      console.log(`   ✅ /api/orders                    - Order management`);
      console.log(`   ✅ /api/can-status                - Can status (distributor)`);
      console.log(`   ✅ /api/users/:userId/can-status  - Can status (user-specific)`);
      console.log(`   ✅ /api/subscriptions             - Subscription management`);
      console.log(`   ✅ /api/distributors              - Distributor management`);
      console.log(`   ✅ /api/returns                   - Return management`);
      console.log(`   ✅ /api/apartments                - Apartment residents & orders`);
      console.log(`\n🔔 Firebase Status:`);
      console.log(`   ${admin.apps.length > 0 ? '✅' : '❌'} Firebase Admin SDK: ${admin.apps.length > 0 ? 'Ready' : 'Not initialized'}`);
      console.log(`   ${admin.apps.length > 0 ? '✅' : '❌'} Push Notifications: ${admin.apps.length > 0 ? 'Enabled' : 'Disabled'}`);
      console.log(`\n⚙️  Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`${'='.repeat(70)}\n`);
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