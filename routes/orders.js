const express = require('express');
const router = express.Router();
const { query } = require('../config/database');

// Create new order
router.post('/', async (req, res) => {
  try {
    const userId = req.userId;
    const { address_id, quantity, total_amount, status } = req.body;

    const result = await query(
      'INSERT INTO orders (user_id, address_id, quantity, total_amount, status, created_at) VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP) RETURNING *',
      [userId, address_id, quantity, total_amount, status || 'pending']
    );

    res.status(201).json({
      message: 'Order created successfully',
      order: result.rows[0]
    });
  } catch (error) {
    console.error('Create order error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all orders
router.get('/', async (req, res) => {
  try {
    const userId = req.userId;

    const result = await query(
      `SELECT o.*, a.address_line, a.latitude, a.longitude 
       FROM orders o 
       LEFT JOIN addresses a ON o.address_id = a.id 
       WHERE o.user_id = $1 
       ORDER BY o.created_at DESC`,
      [userId]
    );

    res.json({ orders: result.rows });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get specific order
router.get('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    const orderId = req.params.id;

    const result = await query(
      `SELECT o.*, a.address_line, a.latitude, a.longitude 
       FROM orders o 
       LEFT JOIN addresses a ON o.address_id = a.id 
       WHERE o.id = $1 AND o.user_id = $2`,
      [orderId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ order: result.rows[0] });
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update order
router.put('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    const orderId = req.params.id;
    const { address_id, quantity, total_amount, status } = req.body;

    const result = await query(
      'UPDATE orders SET address_id = $1, quantity = $2, total_amount = $3, status = $4 WHERE id = $5 AND user_id = $6 RETURNING *',
      [address_id, quantity, total_amount, status, orderId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({
      message: 'Order updated successfully',
      order: result.rows[0]
    });
  } catch (error) {
    console.error('Update order error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update order status
router.patch('/:id/status', async (req, res) => {
  try {
    const userId = req.userId;
    const orderId = req.params.id;
    const { status } = req.body;

    const result = await query(
      'UPDATE orders SET status = $1 WHERE id = $2 AND user_id = $3 RETURNING *',
      [status, orderId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({
      message: 'Order status updated successfully',
      order: result.rows[0]
    });
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete order
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    const orderId = req.params.id;

    const result = await query(
      'DELETE FROM orders WHERE id = $1 AND user_id = $2 RETURNING *',
      [orderId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    res.json({ message: 'Order deleted successfully' });
  } catch (error) {
    console.error('Delete order error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;