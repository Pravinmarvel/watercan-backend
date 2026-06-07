const { Pool } = require('pg');
require('dotenv').config();

// Check if DATABASE_URL exists (Render/Heroku provides this)
// If it exists, use it. Otherwise, use individual DB_* environment variables
const connectionString = process.env.DATABASE_URL;

const pool = new Pool(
  connectionString
    ? {
        // Cloud database (Render, Heroku, etc.)
        connectionString: connectionString,
        ssl: {
          rejectUnauthorized: false // Required for Render PostgreSQL
        }
      }
    : {
        // Local database
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 5432,
        database: process.env.DB_NAME || 'watercan_db',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
      }
);

pool.on('connect', () => {
  console.log('✅ Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('❌ Unexpected database error:', err);
  process.exit(-1);
});

module.exports = { pool };
