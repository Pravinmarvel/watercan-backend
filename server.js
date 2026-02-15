// =====================================================
// WATERCAN BACKEND - COMPLETE SERVER
// =====================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initializeDatabase } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// =====================================================
// MIDDLEWARE
// =====================================================

app.use(cors({
  origin: '*', // In production, specify your frontend domain
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
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
    version: '2.0.0',
    timestamp: new Date().toISOString()
  });
});

// Import route modules
const userRoutes = require('./routes/users');
const distributorRoutes = require('./routes/distributors');
const returnRoutes = require('./routes/returns');

// Mount routes
app.use('/api/users', userRoutes);
app.use('/api/distributors', distributorRoutes);
app.use('/api/returns', returnRoutes);

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
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📍 Health check: http://localhost:${PORT}/`);
      console.log(`📍 API base: http://localhost:${PORT}/api`);
      console.log(`\n📋 Available endpoints:`);
      console.log(`   Users: /api/users/*`);
      console.log(`   Distributors: /api/distributors/*`);
      console.log(`   Returns: /api/returns/*`);
      console.log(`\n⚙️  Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 SIGTERM received. Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('👋 SIGINT received. Shutting down gracefully...');
  process.exit(0);
});

// Start the server
startServer();

module.exports = app;