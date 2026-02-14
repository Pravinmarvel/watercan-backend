require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { pool } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Import routers
const usersRouter = require('./routes/users');
const distributorsRouter = require('./routes/distributors');
const returnsRouter = require('./routes/returns');

// ✅ FIXED: Mount routers correctly
app.use('/api/users', usersRouter);
app.use('/api/distributors', distributorsRouter);
app.use('/api', returnsRouter); // ← Changed from '/api/users' to '/api'

// Health check
app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      status: 'healthy',
      database: 'connected',
      timestamp: result.rows[0].now
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      database: 'disconnected',
      error: error.message
    });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'WaterCan API Server',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      users: '/api/users',
      distributors: '/api/distributors',
      returns: '/api/users/:userId/returns',
      health: '/health'
    }
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`👥 Users API: /api/users`);
  console.log(`🚚 Distributors API: /api/distributors`);
  console.log(`📦 Returns API: /api/users/:userId/returns`);
});