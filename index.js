require('dotenv').config();
const { Client } = require('pg');

const client = new Client({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

client.connect()
  .then(() => {
    console.log('✅ Database connected');
    return client.query('SELECT NOW()');
  })
  .then(res => {
    console.log('🕒 Server time:', res.rows[0]);
  })
  .catch(err => {
    console.error('❌ Database connection error:', err.message);
  })
  .finally(() => {
    client.end();
  });