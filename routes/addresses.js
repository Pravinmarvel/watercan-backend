const express = require('express');
const router = express.Router();
const { query } = require('../config/database');

// Create new address
router.post('/', async (req, res) => {
  try {
    const userId = req.userId;
    const { address_line, latitude, longitude } = req.body;

    const result = await query(
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
router.get('/', async (req, res) => {
  try {
    const userId = req.userId;

    const result = await query(
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
router.get('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    const addressId = req.params.id;

    const result = await query(
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
router.put('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    const addressId = req.params.id;
    const { address_line, latitude, longitude } = req.body;

    const result = await query(
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
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    const addressId = req.params.id;

    const result = await query(
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