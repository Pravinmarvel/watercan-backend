require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();

// ✅ CRITICAL: Trust proxy for Render.com deployment
app.set('trust proxy', 1);

// ============================================
// FIREBASE ADMIN SDK INITIALIZATION
// ============================================
try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
  console.log('✅ Firebase Admin SDK initialized');
} catch (error) {
  console.error('❌ Firebase initialization error:', error.message);
  process.exit(1);
}

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

app.use(express.json());

// ✅ Request logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  
  // Only log actual requests, not just method
  if (req.method !== 'HEAD') {
    console.log(`${timestamp} - ${req.method} ${req.path}`);
  }
  
  next();
});

// ============================================
// HEALTH CHECK ENDPOINTS
// ============================================
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    database: 'connected',
    firebase: 'connected',
    timestamp: new Date().toISOString()
  });
});

app.head('/health', (req, res) => {
  res.status(200).end();
});

// ============================================
// ROUTES
// ============================================
const usersRoutes = require('./routes/users');
const distributorsRoutes = require('./routes/distributors');
const apartmentsRoutes = require('./routes/apartments');
const subscriptionsRoutes = require('./routes/subscriptions');
const ordersRoutes = require('./routes/orders');
const returnsRoutes = require('./routes/returns');
const canStatusRoutes = require('./routes/canstatus'); // ✅ ADDED
const paymentsRoutes = require('./routes/payments');   // ✅ ADDED

app.use('/api/users', usersRoutes);
app.use('/api/distributors', distributorsRoutes);
app.use('/api/apartments', apartmentsRoutes);
app.use('/api/subscriptions', subscriptionsRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/returns', returnsRoutes);
app.use('/api/can-status', canStatusRoutes); // ✅ ADDED
app.use('/api/payments', paymentsRoutes);   // ✅ ADDED

// ============================================
// ERROR HANDLING
// ============================================
app.use((err, req, res, next) => {
  // Don't log jwt expired errors (too noisy)
  if (err.name !== 'TokenExpiredError' && err.message !== 'jwt expired') {
    console.error('❌ Server error:', err.message);
  }
  
  // Handle specific error types
  if (err.name === 'TokenExpiredError' || err.message === 'jwt expired') {
    return res.status(401).json({ 
      error: 'Token expired',
      message: 'Please log in again'
    });
  }
  
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ 
      error: 'Invalid token',
      message: 'Authentication failed'
    });
  }
  
  res.status(500).json({ 
    error: 'Server error',
    message: err.message || 'Something went wrong'
  });
});

// ============================================
// 404 HANDLER
// ============================================
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Not found',
    message: `Route ${req.method} ${req.path} not found`
  });
});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log('======================================================================');
  console.log('🚀 WaterCan Server v3.2 - PRODUCTION');
  console.log('======================================================================');
  console.log(`📍 Port: ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'production'}`);
  console.log('🔐 Security: ✅ Enabled');
  console.log('🔔 Firebase: ✅');
  console.log('📋 Routes: 11 mounted');
  console.log('🔄 JWT: Auto-refresh enabled');
  console.log('======================================================================');
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
process.on('SIGTERM', () => {
  console.log('⚠️ SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('⚠️ SIGINT received, shutting down gracefully...');
  process.exit(0);
});

module.exports = app;