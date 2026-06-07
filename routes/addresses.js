const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const jwt = require('jsonwebtoken');

// ✅ Authentication middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

// Create new address
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { address_line, latitude, longitude } = req.body;

    const result = await pool.query(
      'INSERT INTO addresses (user_id, address_line, latitude, longitude, created_at) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP) RETURNING *',
      [userId, address_line, latitude, longitude]
    );

    res.status(201).json({
      message: 'Address created successfully',
      address: result.rows[0]
    });
  } catch (error) {
    console.error('Create address error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all addresses
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const result = await pool.query(
      'SELECT * FROM addresses WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );

    res.json({ addresses: result.rows });
  } catch (error) {
    console.error('Get addresses error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get specific address
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const addressId = req.params.id;

    const result = await pool.query(
      'SELECT * FROM addresses WHERE id = $1 AND user_id = $2',
      [addressId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Address not found' });
    }

    res.json({ address: result.rows[0] });
  } catch (error) {
    console.error('Get address error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update address
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const addressId = req.params.id;
    const { address_line, latitude, longitude } = req.body;

    const result = await pool.query(
      'UPDATE addresses SET address_line = $1, latitude = $2, longitude = $3 WHERE id = $4 AND user_id = $5 RETURNING *',
      [address_line, latitude, longitude, addressId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Address not found' });
    }

    res.json({
      message: 'Address updated successfully',
      address: result.rows[0]
    });
  } catch (error) {
    console.error('Update address error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete address
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const addressId = req.params.id;

    const result = await pool.query(
      'DELETE FROM addresses WHERE id = $1 AND user_id = $2 RETURNING *',
      [addressId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Address not found' });
    }

    res.json({ message: 'Address deleted successfully' });
  } catch (error) {
    console.error('Delete address error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;