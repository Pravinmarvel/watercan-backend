const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

// Get user's can status
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM can_status WHERE user_id = $1',
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      // Create default status if doesn't exist
      const newStatus = await pool.query(
        'INSERT INTO can_status (user_id) VALUES ($1) RETURNING *',
        [req.user.userId]
      );
      return res.json({ canStatus: newStatus.rows[0] });
    }

    res.json({ canStatus: result.rows[0] });
  } catch (error) {
    console.error('Error getting can status:', error);
    res.status(500).json({ error: 'Failed to get can status' });
  }
});

// Update can status
router.put('/', async (req, res) => {
  try {
    const { can_1_full, can_2_full, can_3_full } = req.body;

    const result = await pool.query(
      `INSERT INTO can_status (user_id, can_1_full, can_2_full, can_3_full, updated_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) DO UPDATE 
       SET can_1_full = $2, can_2_full = $3, can_3_full = $4, updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [req.user.userId, can_1_full, can_2_full, can_3_full]
    );

    res.json({ 
      message: 'Can status updated successfully',
      canStatus: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating can status:', error);
    res.status(500).json({ error: 'Failed to update can status' });
  }
});

module.exports = router;
