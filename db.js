const { Pool } = require('pg');

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Log successful connection
pool.on('connect', () => {
  console.log('✅ Connected to PostgreSQL database');
});

// Handle connection errors
pool.on('error', (err) => {
  console.error('❌ Database error:', err);
  process.exit(-1);
});

module.exports = { pool };
