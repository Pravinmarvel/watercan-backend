// =====================================================
// WATERCAN BACKEND - PRODUCTION SERVER v3.0
// =====================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const admin = require('firebase-admin');
const { pool, initializeDatabase } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// =====================================================
// ✅ CRITICAL FIX: TRUST PROXY FOR RENDER.COM
// =====================================================
// This fixes the "X-Forwarded-For" error
app.set('trust proxy', 1);

// =====================================================
// FIREBASE ADMIN SDK INITIALIZATION
// =====================================================
try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
    console.log('✅ Firebase Admin SDK initialized');
  }
} catch (error) {
  console.error('❌ Firebase initialization error:', error);
}

// =====================================================
// SECURITY MIDDLEWARE
// =====================================================
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// ✅ FIXED RATE LIMITER - Works with trust proxy
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  // ✅ This is the key fix for the proxy issue
  validate: { xForwardedForHeader: false }
});

app.use('/api/', limiter);

// =====================================================
// CORS CONFIGURATION
// =====================================================
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// =====================================================
// BODY PARSING
// =====================================================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// =====================================================
// REQUEST LOGGING
// =====================================================
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} - ${req.method} ${req.path}`);
  next();
});

// =====================================================
// HEALTH CHECK ROUTES
// =====================================================
app.get('/', (req, res) => {
  res.json({
    name: 'WaterCan Backend API',
    version: '3.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/health',
      users: '/api/users',
      orders: '/api/orders',
      canStatus: '/api/can-status',
      distributors: '/api/distributors',
      returns: '/api/returns',
      subscriptions: '/api/subscriptions',
      payments: '/api/payments',
      addresses: '/api/addresses',
      apartments: '/api/apartments'
    }
  });
});

app.get('/health', async (req, res) => {
  try {
    // Check database connection
    await pool.query('SELECT 1');
    
    res.json({ 
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: 'connected',
      firebase: admin.apps.length > 0 ? 'connected' : 'disconnected',
      uptime: process.uptime()
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      database: 'disconnected',
      error: error.message
    });
  }
});

// =====================================================
// API ROUTES
// =====================================================
const userRoutes = require('./routes/users');
const distributorRoutes = require('./routes/distributors');
const returnRoutes = require('./routes/returns');
const orderRoutes = require('./routes/orders');
const canStatusRoutes = require('./routes/canstatus');
const subscriptionRoutes = require('./routes/subscriptions');
const paymentRoutes = require('./routes/payments');
const addressRoutes = require('./routes/addresses');
const apartmentRoutes = require('./routes/apartments');

app.use('/api/users', userRoutes);
app.use('/api/distributors', distributorRoutes);
app.use('/api/returns', returnRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/can-status', canStatusRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/addresses', addressRoutes);
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
    availableEndpoints: [
      '/api/users',
      '/api/orders',
      '/api/can-status',
      '/api/distributors',
      '/api/returns',
      '/api/subscriptions',
      '/api/payments',
      '/api/addresses',
      '/api/apartments'
    ]
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('❌ Error:', err);
  
  // Handle rate limit errors
  if (err.code === 'ERR_ERL_UNEXPECTED_X_FORWARDED_FOR') {
    console.error('⚠️ Rate limiter proxy issue detected but handled');
    return next();
  }
  
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
    console.log('\n======================================================================');
    console.log('🚀 WaterCan Server v3.0 - PRODUCTION READY');
    console.log('======================================================================');
    
    console.log('🔄 Initializing database...');
    await initializeDatabase();
    console.log('✅ Database initialized');
    
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`📍 Port: ${PORT}`);
      console.log(`📍 Environment: ${process.env.NODE_ENV || 'production'}`);
      console.log(`📍 Health: http://localhost:${PORT}/health`);
      console.log('🔐 Security:');
      console.log('   ✅ Helmet enabled');
      console.log('   ✅ Rate limiting active');
      console.log('   ✅ CORS configured');
      console.log('   ✅ Input validation enabled');
      console.log(`🔔 Firebase: ${admin.apps.length > 0 ? '✅ Ready' : '❌ Not configured'}`);
      console.log('📋 Routes: 9 mounted');
      console.log('======================================================================\n');
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// =====================================================
// GRACEFUL SHUTDOWN
// =====================================================
const gracefulShutdown = async (signal) => {
  console.log(`\n👋 ${signal} received. Shutting down gracefully...`);
  
  try {
    // Close database connections
    await pool.end();
    console.log('✅ Database connections closed');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Start the server
startServer();

module.exports = app;