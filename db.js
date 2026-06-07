const { Pool } = require('pg');
require('dotenv').config();

// ✅ SECURITY: Exit if DATABASE_URL missing
if (!process.env.DATABASE_URL) {
  console.error('❌ FATAL: DATABASE_URL environment variable is required');
  process.exit(1);
}

// ✅ PRODUCTION-GRADE: Connection pooling with SSL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { 
    rejectUnauthorized: false 
  } : false,
  max: 20, // ✅ Max 20 connections
  idleTimeoutMillis: 30000, // ✅ 30s timeout
  connectionTimeoutMillis: 10000, // ✅ 10s connection timeout
});

pool.on('connect', () => {
  if (process.env.NODE_ENV !== 'production') {
    console.log('✅ PostgreSQL connection established');
  }
});

pool.on('error', (err) => {
  console.error('❌ Unexpected database error:', err);
  process.exit(-1);
});

async function initializeDatabase() {
  try {
    if (process.env.NODE_ENV !== 'production') {
      console.log('🔄 Checking database connection...');
    }
    const client = await pool.connect();
    client.release();
    if (process.env.NODE_ENV !== 'production') {
      console.log('✅ Database ready');
    }
    return true;
  } catch (error) {
    console.error('❌ Database initialization error:', error.message);
    throw error;
  }
}

module.exports = { pool, initializeDatabase };