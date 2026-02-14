const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const jwt = require('jsonwebtoken');

// Middleware to verify JWT token
function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'watercan-secret-key-2026', (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// CREATE RETURN REQUEST
router.post('/users/:userId/returns', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const {
      quantity,
      pickup_address,
      pickup_date,
      instructions,
      status,
      cans_selected
    } = req.body;

    console.log('📦 Creating return request for user:', userId);
    console.log('📦 Data:', req.body);

    // Validate user
    if (req.user.userId !== parseInt(userId)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Validate required fields
    if (!quantity || !pickup_address || !pickup_date) {
      return res.status(400).json({
        error: 'Missing required fields: quantity, pickup_address, pickup_date'
      });
    }

    // Insert return request
    const query = `
      INSERT INTO can_returns 
      (user_id, quantity, pickup_address, pickup_date, instructions, status, cans_selected, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      RETURNING *
    `;

    const values = [
      userId,
      quantity,
      pickup_address,
      pickup_date,
      instructions || null,
      status || 'pending',
      JSON.stringify(cans_selected)
    ];

    const result = await pool.query(query, values);

    console.log('✅ Return request created:', result.rows[0].id);

    res.status(201).json({
      message: 'Return request created successfully',
      return: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Error creating return request:', error);
    res.status(500).json({
      error: 'Failed to create return request',
      details: error.message
    });
  }
});

// GET USER'S RETURN REQUESTS
router.get('/users/:userId/returns', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;

    console.log('📦 Fetching return requests for user:', userId);

    // Validate user
    if (req.user.userId !== parseInt(userId)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const query = `
      SELECT * FROM can_returns
      WHERE user_id = $1
      ORDER BY created_at DESC
    `;

    const result = await pool.query(query, [userId]);

    console.log(`✅ Found ${result.rows.length} return requests`);

    res.json({
      returns: result.rows
    });

  } catch (error) {
    console.error('❌ Error fetching return requests:', error);
    res.status(500).json({
      error: 'Failed to fetch return requests',
      details: error.message
    });
  }
});

// UPDATE RETURN REQUEST STATUS
router.put('/users/:userId/returns/:returnId', authenticateToken, async (req, res) => {
  try {
    const { userId, returnId } = req.params;
    const { status } = req.body;

    console.log(`📦 Updating return request ${returnId} status to:`, status);

    // Validate user
    if (req.user.userId !== parseInt(userId)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Validate status
    const validStatuses = ['pending', 'collected', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        error: 'Invalid status',
        validStatuses
      });
    }

    const query = `
      UPDATE can_returns
      SET status = $1, updated_at = NOW()
      WHERE id = $2 AND user_id = $3
      RETURNING *
    `;

    const result = await pool.query(query, [status, returnId, userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Return request not found' });
    }

    console.log('✅ Return request updated');

    res.json({
      message: 'Return request updated successfully',
      return: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Error updating return request:', error);
    res.status(500).json({
      error: 'Failed to update return request',
      details: error.message
    });
  }
});

module.exports = router;