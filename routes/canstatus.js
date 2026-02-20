const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const jwt = require('jsonwebtoken');

// Authentication middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(
    token, 
    process.env.JWT_SECRET || 'watercan-secret-key-2026', 
    (err, user) => {
      if (err) {
        return res.status(403).json({ error: 'Invalid or expired token' });
      }
      req.user = user;
      next();
    }
  );
}

// GET /api/can-status - Get user's can status
router.get('/', authenticateToken, async (req, res) => {
  try {
    console.log(`📤 Getting can status for user ${req.user.userId}`);
    
    const result = await pool.query(
      'SELECT * FROM can_status WHERE user_id = $1',
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      // Create default status if doesn't exist (all cans full by default)
      console.log(`🆕 Creating default can status for user ${req.user.userId}`);
      
      const newStatus = await pool.query(
        `INSERT INTO can_status (user_id, can_1_full, can_2_full, can_3_full, updated_at) 
         VALUES ($1, true, true, true, CURRENT_TIMESTAMP) 
         RETURNING *`,
        [req.user.userId]
      );
      
      console.log(`✅ Default can status created: ${JSON.stringify(newStatus.rows[0])}`);
      return res.json({ 
        canStatus: newStatus.rows[0] 
      });
    }

    console.log(`✅ Can status found: ${JSON.stringify(result.rows[0])}`);
    res.json({ 
      canStatus: result.rows[0] 
    });

  } catch (error) {
    console.error('❌ Error getting can status:', error);
    res.status(500).json({ error: 'Failed to get can status' });
  }
});

// PUT /api/can-status - Update can status
router.put('/', authenticateToken, async (req, res) => {
  try {
    const { can_1_full, can_2_full, can_3_full } = req.body;
    
    console.log(`📤 Updating can status for user ${req.user.userId}:`, {
      can_1_full,
      can_2_full,
      can_3_full
    });

    // Validate input
    if (
      typeof can_1_full !== 'boolean' || 
      typeof can_2_full !== 'boolean' || 
      typeof can_3_full !== 'boolean'
    ) {
      return res.status(400).json({ 
        error: 'All can status values must be boolean (true/false)' 
      });
    }

    // Insert or update using UPSERT (ON CONFLICT)
    const result = await pool.query(
      `INSERT INTO can_status (user_id, can_1_full, can_2_full, can_3_full, updated_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) 
       DO UPDATE SET 
         can_1_full = $2, 
         can_2_full = $3, 
         can_3_full = $4, 
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [req.user.userId, can_1_full, can_2_full, can_3_full]
    );

    console.log(`✅ Can status updated successfully: ${JSON.stringify(result.rows[0])}`);

    res.json({ 
      message: 'Can status updated successfully',
      canStatus: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Error updating can status:', error);
    res.status(500).json({ error: 'Failed to update can status' });
  }
});

// DELETE /api/can-status - Reset can status (optional)
router.delete('/', authenticateToken, async (req, res) => {
  try {
    console.log(`📤 Resetting can status for user ${req.user.userId}`);
    
    const result = await pool.query(
      `UPDATE can_status 
       SET can_1_full = true, can_2_full = true, can_3_full = true, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1
       RETURNING *`,
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Can status not found' });
    }

    console.log(`✅ Can status reset to all full`);

    res.json({ 
      message: 'Can status reset successfully',
      canStatus: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Error resetting can status:', error);
    res.status(500).json({ error: 'Failed to reset can status' });
  }
});

module.exports = router;