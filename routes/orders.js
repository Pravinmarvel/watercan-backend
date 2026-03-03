const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const jwt = require('jsonwebtoken');

// ✅ Authentication middleware - SAME as users.js
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

// POST /api/orders - Create new order
// ✅ NOW TRACKS IF ORDER IS ADDITIONAL CAN REQUEST
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { address_id, quantity, total_amount, status, is_additional } = req.body;

    console.log(`📤 Creating order for user ${userId}:`, {
      address_id,
      quantity,
      total_amount,
      status: status || 'pending',
      is_additional: is_additional || false  // ✅ NEW
    });

    // Validate required fields
    if (!address_id || !quantity || !total_amount) {
      return res.status(400).json({ 
        error: 'Address ID, quantity, and total amount are required' 
      });
    }

    // Validate quantity
    if (quantity <= 0) {
      return res.status(400).json({ 
        error: 'Quantity must be greater than 0' 
      });
    }

    // ✅ NEW: Validate max 3 additional cans
    if (is_additional && quantity > 3) {
      return res.status(400).json({ 
        error: 'Maximum 3 additional cans allowed per request' 
      });
    }

    // Validate total_amount
    if (total_amount <= 0) {
      return res.status(400).json({ 
        error: 'Total amount must be greater than 0' 
      });
    }

    // ✅ UPDATED: Create the order with is_additional flag
    const result = await pool.query(
      `INSERT INTO orders (
        user_id, 
        address_id, 
        quantity, 
        total_amount, 
        status, 
        is_additional,
        created_at
      ) 
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP) 
       RETURNING *`,
      [
        userId, 
        address_id, 
        quantity, 
        total_amount, 
        status || 'pending',
        is_additional || false  // ✅ NEW COLUMN
      ]
    );

    console.log(`✅ Order created: ID ${result.rows[0].id}${is_additional ? ' (ADDITIONAL CANS)' : ''}`);

    res.status(201).json({
      message: 'Order created successfully',
      order: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Create order error:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// GET /api/orders - Get all orders for user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    console.log(`📤 Getting orders for user ${userId}`);

    const result = await pool.query(
      `SELECT 
        o.*, 
        a.address_line, 
        a.latitude, 
        a.longitude 
       FROM orders o 
       LEFT JOIN addresses a ON o.address_id = a.id 
       WHERE o.user_id = $1 
       ORDER BY o.created_at DESC`,
      [userId]
    );

    console.log(`✅ Found ${result.rows.length} orders`);

    res.json({ orders: result.rows });

  } catch (error) {
    console.error('❌ Get orders error:', error);
    res.status(500).json({ error: 'Failed to get orders' });
  }
});

// ✅ NEW: Get additional can orders only
router.get('/additional', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    console.log(`📤 Getting additional can orders for user ${userId}`);

    const result = await pool.query(
      `SELECT 
        o.*, 
        a.address_line, 
        a.latitude, 
        a.longitude 
       FROM orders o 
       LEFT JOIN addresses a ON o.address_id = a.id 
       WHERE o.user_id = $1 AND o.is_additional = true
       ORDER BY o.created_at DESC`,
      [userId]
    );

    console.log(`✅ Found ${result.rows.length} additional can orders`);

    res.json({ orders: result.rows });

  } catch (error) {
    console.error('❌ Get additional orders error:', error);
    res.status(500).json({ error: 'Failed to get additional orders' });
  }
});

// ✅ NEW: Get subscription orders only (non-additional)
router.get('/subscription', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    console.log(`📤 Getting subscription orders for user ${userId}`);

    const result = await pool.query(
      `SELECT 
        o.*, 
        a.address_line, 
        a.latitude, 
        a.longitude 
       FROM orders o 
       LEFT JOIN addresses a ON o.address_id = a.id 
       WHERE o.user_id = $1 AND (o.is_additional = false OR o.is_additional IS NULL)
       ORDER BY o.created_at DESC`,
      [userId]
    );

    console.log(`✅ Found ${result.rows.length} subscription orders`);

    res.json({ orders: result.rows });

  } catch (error) {
    console.error('❌ Get subscription orders error:', error);
    res.status(500).json({ error: 'Failed to get subscription orders' });
  }
});

// GET /api/orders/:id - Get specific order
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const orderId = req.params.id;

    console.log(`📤 Getting order ${orderId} for user ${userId}`);

    const result = await pool.query(
      `SELECT o.*, a.address_line, a.latitude, a.longitude 
       FROM orders o 
       LEFT JOIN addresses a ON o.address_id = a.id 
       WHERE o.id = $1 AND o.user_id = $2`,
      [orderId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    console.log(`✅ Order found`);

    res.json({ order: result.rows[0] });

  } catch (error) {
    console.error('❌ Get order error:', error);
    res.status(500).json({ error: 'Failed to get order' });
  }
});

// PUT /api/orders/:id - Update order
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const orderId = req.params.id;
    const { address_id, quantity, total_amount, status } = req.body;

    console.log(`📤 Updating order ${orderId} for user ${userId}`);

    if (!address_id && !quantity && !total_amount && !status) {
      return res.status(400).json({ 
        error: 'At least one field must be provided to update' 
      });
    }

    const result = await pool.query(
      `UPDATE orders 
       SET address_id = $1, quantity = $2, total_amount = $3, status = $4 
       WHERE id = $5 AND user_id = $6 
       RETURNING *`,
      [address_id, quantity, total_amount, status, orderId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    console.log(`✅ Order updated successfully`);

    res.json({
      message: 'Order updated successfully',
      order: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Update order error:', error);
    res.status(500).json({ error: 'Failed to update order' });
  }
});

// PATCH /api/orders/:id/status - Update order status only
router.patch('/:id/status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const orderId = req.params.id;
    const { status } = req.body;

    console.log(`📤 Updating order ${orderId} status to: ${status}`);

    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    const validStatuses = ['pending', 'confirmed', 'delivered', 'cancelled', 'completed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` 
      });
    }

    const result = await pool.query(
      `UPDATE orders 
       SET status = $1 
       WHERE id = $2 AND user_id = $3 
       RETURNING *`,
      [status, orderId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    console.log(`✅ Order status updated to: ${status}`);

    res.json({
      message: 'Order status updated successfully',
      order: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Update order status error:', error);
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

// DELETE /api/orders/:id - Delete order
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const orderId = req.params.id;

    console.log(`📤 Deleting order ${orderId} for user ${userId}`);

    const result = await pool.query(
      'DELETE FROM orders WHERE id = $1 AND user_id = $2 RETURNING *',
      [orderId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    console.log(`✅ Order deleted successfully`);

    res.json({ message: 'Order deleted successfully' });

  } catch (error) {
    console.error('❌ Delete order error:', error);
    res.status(500).json({ error: 'Failed to delete order' });
  }
});

module.exports = router;