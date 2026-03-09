// =====================================================
// WATERCAN BACKEND - PRODUCTION v3.0
// =====================================================
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { pool, initializeDatabase } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// =====================================================
// ENVIRONMENT VALIDATION
// =====================================================
const requiredEnvVars = ['JWT_SECRET', 'DATABASE_URL'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);

if (missingVars.length > 0) {
  console.error(`❌ FATAL: Missing required environment variables: ${missingVars.join(', ')}`);
  console.error('Set these in your .env file before starting the server.');
  process.exit(1);
}

// =====================================================
// FIREBASE ADMIN SDK INITIALIZATION
// =====================================================
const admin = require('firebase-admin');

try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID || 'watercan-a1499',
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL || 'firebase-adminsdk-fbsvc@watercan-a1499.iam.gserviceaccount.com',
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n') || process.env.FIREBASE_PRIVATE_KEY_RAW
    })
  });
  console.log('✅ Firebase Admin SDK initialized');
} catch (error) {
  console.error('❌ Firebase Admin init failed:', error.message);
  console.error('⚠️ Notifications will not work. Check FIREBASE_* env vars');
}

// =====================================================
// SECURITY MIDDLEWARE
// =====================================================

// ✅ Helmet - Security headers
app.use(helmet());

// ✅ CORS - Controlled origins
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// ✅ Body parser with size limits
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ✅ Rate limiting - Global
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per 15min
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(globalLimiter);

// ✅ Strict rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // 5 OTP requests per 15min
  message: { error: 'Too many authentication attempts, please try again later' },
});

// =====================================================
// REQUEST LOGGING
// =====================================================
app.use((req, res, next) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  }
  next();
});

// =====================================================
// HEALTH CHECK
// =====================================================
app.get('/', (req, res) => {
  res.json({
    message: 'WaterCan Backend API',
    status: 'running',
    version: '3.0.0',
    environment: process.env.NODE_ENV || 'development',
    firebase: admin.apps.length > 0 ? 'ready' : 'not initialized',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ 
      status: 'ok', 
      database: 'connected',
      firebase: admin.apps.length > 0 ? 'ready' : 'not initialized',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      database: 'disconnected',
      error: 'Database connection failed'
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
const apartmentRoutes = require('./routes/apartments');
const addressRoutes = require('./routes/addresses');
const paymentRoutes = require('./routes/payments');

// Apply auth rate limiter to specific routes
app.use('/api/users/send-otp', authLimiter);
app.use('/api/users/verify-otp', authLimiter);
app.use('/api/distributors/send-otp', authLimiter);
app.use('/api/distributors/verify-otp', authLimiter);

// Mount routes
app.use('/api/users', userRoutes);
app.use('/api/distributors', distributorRoutes);
app.use('/api/returns', returnRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/can-status', canStatusRoutes);
app.use('/api/users/:userId/can-status', canStatusRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/apartments', apartmentRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/payments', paymentRoutes);

// =====================================================
// ERROR HANDLING
// =====================================================
app.use((req, res) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`❌ 404 - Route not found: ${req.method} ${req.path}`);
  }
  res.status(404).json({ 
    error: 'Route not found',
    path: req.path
  });
});

app.use((err, req, res, next) => {
  console.error('❌ Server error:', err.message);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : err.message
  });
});

// =====================================================
// SERVER START
// =====================================================
async function startServer() {
  try {
    await initializeDatabase();
    
    app.listen(PORT, () => {
      console.log(`\n${'='.repeat(70)}`);
      console.log(`🚀 WaterCan Server v3.0 - PRODUCTION READY`);
      console.log(`${'='.repeat(70)}`);
      console.log(`📍 Port: ${PORT}`);
      console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`📍 Health: http://localhost:${PORT}/health`);
      console.log(`\n🔐 Security:`);
      console.log(`   ✅ Helmet enabled`);
      console.log(`   ✅ Rate limiting active`);
      console.log(`   ✅ CORS configured`);
      console.log(`   ✅ Input validation enabled`);
      console.log(`\n🔔 Firebase: ${admin.apps.length > 0 ? '✅ Ready' : '❌ Not initialized'}`);
      console.log(`\n📋 Routes: 9 mounted`);
      console.log(`${'='.repeat(70)}\n`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('\n👋 SIGTERM received. Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n👋 SIGINT received. Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

startServer();

module.exports = app;