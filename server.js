// =====================================================
// WATERCAN BACKEND - PRODUCTION SERVER v3.1
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

// ✅ FIXED RATE LIMITER
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: 'Too many requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === '/health' || req.path === '/';
  }
});

app.use('/api/', limiter);

// =====================================================
// CORS CONFIGURATION
// =====================================================
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// =====================================================
// BODY PARSING
// =====================================================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// =====================================================
// REQUEST LOGGING (Simplified for production)
// =====================================================
app.use((req, res, next) => {
  // Only log API requests, not health checks
  if (!req.path.includes('health')) {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  }
  next();
});

// =====================================================
// HEALTH CHECK ROUTES
// =====================================================
app.get('/', (req, res) => {
  res.json({
    name: 'WaterCan Backend API',
    version: '3.1.0',
    status: 'running',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ 
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: 'connected',
      firebase: admin.apps.length > 0 ? 'connected' : 'disconnected'
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      database: 'disconnected'
    });
  }
});

// ✅ FIX: Handle HEAD requests for health checks
app.head('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).end();
  } catch (error) {
    res.status(503).end();
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
  res.status(404).json({ 
    error: 'Route not found',
    path: req.path
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message);
  
  // Silently handle rate limiter proxy errors
  if (err.code === 'ERR_ERL_UNEXPECTED_X_FORWARDED_FOR') {
    return next();
  }
  
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
});

// =====================================================
// DATABASE INITIALIZATION & SERVER START
// =====================================================
async function startServer() {
  try {
    console.log('\n======================================================================');
    console.log('🚀 WaterCan Server v3.1 - PRODUCTION');
    console.log('======================================================================');
    
    await initializeDatabase();
    
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`📍 Port: ${PORT}`);
      console.log(`📍 Environment: ${process.env.NODE_ENV || 'production'}`);
      console.log(`🔐 Security: ✅ Enabled`);
      console.log(`🔔 Firebase: ${admin.apps.length > 0 ? '✅' : '❌'}`);
      console.log(`📋 Routes: 9 mounted`);
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
const shutdown = async (signal) => {
  console.log(`\n👋 ${signal} - Shutting down...`);
  try {
    await pool.end();
    process.exit(0);
  } catch (error) {
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start the server
startServer();

module.exports = app;