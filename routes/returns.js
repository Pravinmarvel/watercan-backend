const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// ==================== RETURNS ENDPOINTS ====================

// Create return request
router.post('/users/:userId/returns', async (req, res) => {
  const { userId } = req.params;
  const { cans_to_return, reason } = req.body;

  if (!cans_to_return || cans_to_return < 1) {
    return res.status(400).json({ error: 'Invalid number of cans to return' });
  }

  try {
    // Get user's current cans
    const userResult = await pool.query(
      'SELECT cans_remaining FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const currentCans = userResult.rows[0].cans_remaining || 0;

    if (cans_to_return > currentCans) {
      return res.status(400).json({ 
        error: `Cannot return ${cans_to_return} cans. User only has ${currentCans} cans.` 
      });
    }

    // Create return request
    const result = await pool.query(
      `INSERT INTO returns (user_id, cans_to_return, reason, status) 
       VALUES ($1, $2, $3, 'pending') 
       RETURNING *`,
      [userId, cans_to_return, reason || null]
    );

    res.status(201).json({
      message: 'Return request created successfully',
      return: result.rows[0]
    });
  } catch (error) {
    console.error('❌ Create return error:', error);
    res.status(500).json({ error: 'Failed to create return request', message: error.message });
  }
});

// Get all return requests for a user
router.get('/users/:userId/returns', async (req, res) => {
  const { userId } = req.params;
  const { status } = req.query;

  try {
    let query = 'SELECT * FROM returns WHERE user_id = $1';
    const params = [userId];

    if (status) {
      query += ' AND status = $2';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);

    res.json({ returns: result.rows });
  } catch (error) {
    console.error('❌ Get returns error:', error);
    res.status(500).json({ error: 'Failed to get returns', message: error.message });
  }
});

// Get single return request
router.get('/users/:userId/returns/:returnId', async (req, res) => {
  const { userId, returnId } = req.params;

  try {
    const result = await pool.query(
      'SELECT * FROM returns WHERE id = $1 AND user_id = $2',
      [returnId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Return request not found' });
    }

    res.json({ return: result.rows[0] });
  } catch (error) {
    console.error('❌ Get return error:', error);
    res.status(500).json({ error: 'Failed to get return request', message: error.message });
  }
});

// Cancel return request (user can cancel if still pending)
router.delete('/users/:userId/returns/:returnId', async (req, res) => {
  const { userId, returnId } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM returns 
       WHERE id = $1 AND user_id = $2 AND status = 'pending' 
       RETURNING *`,
      [returnId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ 
        error: 'Return request not found or cannot be cancelled' 
      });
    }

    res.json({
      message: 'Return request cancelled successfully',
      return: result.rows[0]
    });
  } catch (error) {
    console.error('❌ Cancel return error:', error);
    res.status(500).json({ error: 'Failed to cancel return request', message: error.message });
  }
});

module.exports = router;