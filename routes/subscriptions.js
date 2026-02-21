const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const jwt = require('jsonwebtoken');

// ✅ AUTHENTICATION MIDDLEWARE (SAME AS users.js and orders.js)
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
      req.user = user; // ✅ Sets req.user (not req.userId)
      next();
    }
  );
}

// ========================================
// SUBSCRIPTION ENDPOINTS
// ========================================

// POST /api/subscriptions - Create new subscription
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId; // ✅ FIXED
    const { is_active, started_at, ended_at } = req.body;

    console.log(`📤 Creating subscription for user ${userId}`);

    const result = await pool.query(
      `INSERT INTO subscriptions (user_id, is_active, started_at, ended_at) 
       VALUES ($1, $2, $3, $4) 
       RETURNING *`,
      [userId, is_active !== undefined ? is_active : false, started_at, ended_at]
    );

    console.log(`✅ Subscription created: ID ${result.rows[0].id}`);

    res.status(201).json({
      message: 'Subscription created successfully',
      subscription: result.rows[0]
    });
  } catch (error) {
    console.error('❌ Create subscription error:', error);
    res.status(500).json({ error: 'Failed to create subscription' });
  }
});

// GET /api/subscriptions - Get all subscriptions for user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId; // ✅ FIXED

    console.log(`📤 Getting subscriptions for user ${userId}`);

    const result = await pool.query(
      `SELECT * FROM subscriptions 
       WHERE user_id = $1 
       ORDER BY started_at DESC`,
      [userId]
    );

    console.log(`✅ Found ${result.rows.length} subscriptions`);

    res.json({ subscriptions: result.rows });
  } catch (error) {
    console.error('❌ Get subscriptions error:', error);
    res.status(500).json({ error: 'Failed to get subscriptions' });
  }
});

// GET /api/subscriptions/active - Get active subscription
router.get('/active', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId; // ✅ FIXED

    console.log(`📤 Getting active subscription for user ${userId}`);

    const result = await pool.query(
      `SELECT * FROM subscriptions 
       WHERE user_id = $1 AND is_active = true 
       ORDER BY started_at DESC 
       LIMIT 1`,
      [userId]
    );

    if (result.rows.length === 0) {
      console.log(`ℹ️ No active subscription found`);
      return res.status(404).json({ error: 'No active subscription found' });
    }

    console.log(`✅ Active subscription found: ID ${result.rows[0].id}`);

    res.json({ subscription: result.rows[0] });
  } catch (error) {
    console.error('❌ Get active subscription error:', error);
    res.status(500).json({ error: 'Failed to get active subscription' });
  }
});

// GET /api/subscriptions/:id - Get specific subscription
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId; // ✅ FIXED
    const subscriptionId = req.params.id;

    console.log(`📤 Getting subscription ${subscriptionId} for user ${userId}`);

    const result = await pool.query(
      `SELECT * FROM subscriptions 
       WHERE id = $1 AND user_id = $2`,
      [subscriptionId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    console.log(`✅ Subscription found`);

    res.json({ subscription: result.rows[0] });
  } catch (error) {
    console.error('❌ Get subscription error:', error);
    res.status(500).json({ error: 'Failed to get subscription' });
  }
});

// PUT /api/subscriptions/:id - Update subscription
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId; // ✅ FIXED
    const subscriptionId = req.params.id;
    const { is_active, started_at, ended_at } = req.body;

    console.log(`📤 Updating subscription ${subscriptionId}`);

    const result = await pool.query(
      `UPDATE subscriptions 
       SET is_active = $1, started_at = $2, ended_at = $3 
       WHERE id = $4 AND user_id = $5 
       RETURNING *`,
      [is_active, started_at, ended_at, subscriptionId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    console.log(`✅ Subscription updated`);

    res.json({
      message: 'Subscription updated successfully',
      subscription: result.rows[0]
    });
  } catch (error) {
    console.error('❌ Update subscription error:', error);
    res.status(500).json({ error: 'Failed to update subscription' });
  }
});

// POST /api/subscriptions/:id/activate - Activate subscription
router.post('/:id/activate', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId; // ✅ FIXED
    const subscriptionId = req.params.id;

    console.log(`📤 Activating subscription ${subscriptionId} for user ${userId}`);

    // Deactivate all other subscriptions first
    await pool.query(
      `UPDATE subscriptions 
       SET is_active = false 
       WHERE user_id = $1`,
      [userId]
    );

    // Activate this one
    const result = await pool.query(
      `UPDATE subscriptions 
       SET is_active = true 
       WHERE id = $1 AND user_id = $2 
       RETURNING *`,
      [subscriptionId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    console.log(`✅ Subscription activated`);

    res.json({
      message: 'Subscription activated successfully',
      subscription: result.rows[0]
    });
  } catch (error) {
    console.error('❌ Activate subscription error:', error);
    res.status(500).json({ error: 'Failed to activate subscription' });
  }
});

// POST /api/subscriptions/:id/deactivate - Deactivate subscription
router.post('/:id/deactivate', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId; // ✅ FIXED
    const subscriptionId = req.params.id;

    console.log(`📤 Deactivating subscription ${subscriptionId}`);

    const result = await pool.query(
      `UPDATE subscriptions 
       SET is_active = false, ended_at = CURRENT_TIMESTAMP 
       WHERE id = $1 AND user_id = $2 
       RETURNING *`,
      [subscriptionId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    console.log(`✅ Subscription deactivated`);

    res.json({
      message: 'Subscription deactivated successfully',
      subscription: result.rows[0]
    });
  } catch (error) {
    console.error('❌ Deactivate subscription error:', error);
    res.status(500).json({ error: 'Failed to deactivate subscription' });
  }
});

// DELETE /api/subscriptions/:id - Delete subscription
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId; // ✅ FIXED
    const subscriptionId = req.params.id;

    console.log(`📤 Deleting subscription ${subscriptionId}`);

    const result = await pool.query(
      `DELETE FROM subscriptions 
       WHERE id = $1 AND user_id = $2 
       RETURNING *`,
      [subscriptionId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    console.log(`✅ Subscription deleted`);

    res.json({ message: 'Subscription deleted successfully' });
  } catch (error) {
    console.error('❌ Delete subscription error:', error);
    res.status(500).json({ error: 'Failed to delete subscription' });
  }
});

module.exports = router;