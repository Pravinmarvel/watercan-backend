const express = require('express');
const router = express.Router();
const { pool } = require('../db');  // ✅ FIXED: Use pool instead of query
const jwt = require('jsonwebtoken');  // ✅ ADDED: JWT for authentication

// ✅ ADDED: Authentication middleware
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
      req.user = user;  // ✅ Sets req.user
      next();
    }
  );
}

// Create new payment
router.post('/', authenticateToken, async (req, res) => {  // ✅ ADDED: authenticateToken
  try {
    const userId = req.user.userId;  // ✅ FIXED: req.user.userId instead of req.userId
    const { order_id, method, amount, status } = req.body;

    // ✅ Verify order belongs to user
    const orderCheck = await pool.query(  // ✅ FIXED: pool.query
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
      [order_id, userId]
    );

    if (orderCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const result = await pool.query(  // ✅ FIXED: pool.query
      'INSERT INTO payments (order_id, method, amount, status, paid_at) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP) RETURNING *',
      [order_id, method, amount, status || 'success']
    );

    res.status(201).json({
      message: 'Payment created successfully',
      payment: result.rows[0]
    });
  } catch (error) {
    console.error('Create payment error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all payments
router.get('/', authenticateToken, async (req, res) => {  // ✅ ADDED: authenticateToken
  try {
    const userId = req.user.userId;  // ✅ FIXED

    const result = await pool.query(  // ✅ FIXED
      `SELECT p.*, o.total_amount as order_amount, o.status as order_status 
       FROM payments p 
       JOIN orders o ON p.order_id = o.id 
       WHERE o.user_id = $1 
       ORDER BY p.paid_at DESC`,
      [userId]
    );

    res.json({ payments: result.rows });
  } catch (error) {
    console.error('Get payments error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get specific payment
router.get('/:id', authenticateToken, async (req, res) => {  // ✅ ADDED: authenticateToken
  try {
    const userId = req.user.userId;  // ✅ FIXED
    const paymentId = req.params.id;

    const result = await pool.query(  // ✅ FIXED
      `SELECT p.*, o.user_id, o.total_amount as order_amount, o.status as order_status 
       FROM payments p 
       JOIN orders o ON p.order_id = o.id 
       WHERE p.id = $1 AND o.user_id = $2`,
      [paymentId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    res.json({ payment: result.rows[0] });
  } catch (error) {
    console.error('Get payment error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get payments for order
router.get('/order/:orderId', authenticateToken, async (req, res) => {  // ✅ ADDED: authenticateToken
  try {
    const userId = req.user.userId;  // ✅ FIXED
    const orderId = req.params.orderId;

    // ✅ Verify order belongs to user
    const orderCheck = await pool.query(  // ✅ FIXED
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
      [orderId, userId]
    );

    if (orderCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const result = await pool.query(  // ✅ FIXED
      'SELECT * FROM payments WHERE order_id = $1 ORDER BY paid_at DESC',
      [orderId]
    );

    res.json({ payments: result.rows });
  } catch (error) {
    console.error('Get order payments error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update payment status
router.put('/:id', authenticateToken, async (req, res) => {  // ✅ ADDED: authenticateToken
  try {
    const userId = req.user.userId;  // ✅ FIXED
    const paymentId = req.params.id;
    const { status } = req.body;

    const result = await pool.query(  // ✅ FIXED
      `UPDATE payments p
       SET status = $1
       FROM orders o
       WHERE p.id = $2 AND p.order_id = o.id AND o.user_id = $3
       RETURNING p.*`,
      [status, paymentId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    res.json({
      message: 'Payment updated successfully',
      payment: result.rows[0]
    });
  } catch (error) {
    console.error('Update payment error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;