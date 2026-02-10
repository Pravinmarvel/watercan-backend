require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { pool } = require('./db');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const usersRouter = require('./routes/users');
const distributorsRouter = require('./routes/distributors');

app.use('/api/users', usersRouter);
app.use('/api/distributors', distributorsRouter);

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

app.get('/', (req, res) => {
  res.json({
    message: 'WaterCan API Server',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      users: '/api/users',
      distributors: '/api/distributors',
      health: '/health'
    }
  });
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
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
});
