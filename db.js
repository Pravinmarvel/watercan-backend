const { Pool } = require('pg');
require('dotenv').config();

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Error connecting to PostgreSQL:', err);
    return;
  }
  console.log('✅ Connected to PostgreSQL database');
  release();
});

// Optional: Initialize database tables (if needed)
async function initializeDatabase() {
  try {
    console.log('🔄 Checking database tables...');
    
    // You can add table creation queries here if needed
    // For now, we assume tables already exist in Supabase
    
    console.log('✅ Database ready');
    return true;
  } catch (error) {
    console.error('❌ Database initialization error:', error);
    throw error;
  }
}

module.exports = { pool, initializeDatabase };