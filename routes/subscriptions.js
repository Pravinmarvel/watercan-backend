const express = require('express');
const router = express.Router();
const { query } = require('../config/database');

// Create new subscription
router.post('/', async (req, res) => {
  try {
    const userId = req.userId;
    const { is_active, started_at, ended_at } = req.body;

    const result = await query(
      'INSERT INTO subscriptions (user_id, is_active, started_at, ended_at) VALUES ($1, $2, $3, $4) RETURNING *',
      [userId, is_active !== undefined ? is_active : false, started_at, ended_at]
    );

    res.status(201).json({
      message: 'Subscription created successfully',
      subscription: result.rows[0]
    });
  } catch (error) {
    console.error('Create subscription error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all subscriptions
router.get('/', async (req, res) => {
  try {
    const userId = req.userId;

    const result = await query(
      'SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY started_at DESC',
      [userId]
    );

    res.json({ subscriptions: result.rows });
  } catch (error) {
    console.error('Get subscriptions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get active subscription
router.get('/active', async (req, res) => {
  try {
    const userId = req.userId;

    const result = await query(
      'SELECT * FROM subscriptions WHERE user_id = $1 AND is_active = true ORDER BY started_at DESC LIMIT 1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    res.json({ subscription: result.rows[0] });
  } catch (error) {
    console.error('Get active subscription error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get specific subscription
router.get('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    const subscriptionId = req.params.id;

    const result = await query(
      'SELECT * FROM subscriptions WHERE id = $1 AND user_id = $2',
      [subscriptionId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    res.json({ subscription: result.rows[0] });
  } catch (error) {
    console.error('Get subscription error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update subscription
router.put('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    const subscriptionId = req.params.id;
    const { is_active, started_at, ended_at } = req.body;

    const result = await query(
      'UPDATE subscriptions SET is_active = $1, started_at = $2, ended_at = $3 WHERE id = $4 AND user_id = $5 RETURNING *',
      [is_active, started_at, ended_at, subscriptionId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    res.json({
      message: 'Subscription updated successfully',
      subscription: result.rows[0]
    });
  } catch (error) {
    console.error('Update subscription error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Activate subscription
router.post('/:id/activate', async (req, res) => {
  try {
    const userId = req.userId;
    const subscriptionId = req.params.id;

    await query(
      'UPDATE subscriptions SET is_active = false WHERE user_id = $1',
      [userId]
    );

    const result = await query(
      'UPDATE subscriptions SET is_active = true WHERE id = $1 AND user_id = $2 RETURNING *',
      [subscriptionId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    res.json({
      message: 'Subscription activated successfully',
      subscription: result.rows[0]
    });
  } catch (error) {
    console.error('Activate subscription error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Deactivate subscription
router.post('/:id/deactivate', async (req, res) => {
  try {
    const userId = req.userId;
    const subscriptionId = req.params.id;

    const result = await query(
      'UPDATE subscriptions SET is_active = false, ended_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2 RETURNING *',
      [subscriptionId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    res.json({
      message: 'Subscription deactivated successfully',
      subscription: result.rows[0]
    });
  } catch (error) {
    console.error('Deactivate subscription error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete subscription
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    const subscriptionId = req.params.id;

    const result = await query(
      'DELETE FROM subscriptions WHERE id = $1 AND user_id = $2 RETURNING *',
      [subscriptionId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    res.json({ message: 'Subscription deleted successfully' });
  } catch (error) {
    console.error('Delete subscription error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;