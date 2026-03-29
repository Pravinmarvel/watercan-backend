const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin'); // ✅ CORRECT IMPORT

// =====================================================
// AUTHENTICATION MIDDLEWARE
// =====================================================
function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(
    token, 
    process.env.JWT_SECRET, 
    (err, user) => {
      if (err) {
        return res.status(403).json({ error: 'Invalid or expired token' });
      }
      req.user = user;
      next();
    }
  );
}

// =====================================================
// CREATE PAYMENT - ENHANCED WITH NOTIFICATION
// =====================================================
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { orderId, method, amount, status } = req.body;

    // Validate inputs
    if (!orderId || !method || !amount) {
      return res.status(400).json({
        error: 'Order ID, payment method, and amount are required'
      });
    }

    console.log(`💰 Creating payment for order ${orderId} by user ${userId}`);

    // Verify order belongs to user
    const orderCheck = await pool.query(
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
      [orderId, userId]
    );

    if (orderCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderCheck.rows[0];

    // Create payment record
    const paymentQuery = `
      INSERT INTO payments (order_id, method, amount, status, paid_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      RETURNING *
    `;

    const paymentResult = await pool.query(paymentQuery, [
      orderId,
      method,
      amount,
      status || 'success'
    ]);

    const payment = paymentResult.rows[0];

    // Update order status to 'paid'
    await pool.query(
      'UPDATE orders SET status = $1 WHERE id = $2',
      ['paid', orderId]
    );

    console.log(`✅ Payment created: ID ${payment.id}`);

    // ✅ Send notification to user
    try {
      // Get user's FCM token
      const userResult = await pool.query(
        'SELECT fcm_token, full_name FROM users WHERE id = $1',
        [userId]
      );

      if (userResult.rows.length > 0 && userResult.rows[0].fcm_token) {
        const fcmToken = userResult.rows[0].fcm_token;

        // Send notification via Firebase
        const message = {
          token: fcmToken,
          notification: {
            title: '✅ Payment Confirmed!',
            body: `Your payment of ₹${amount} has been confirmed. Thank you!`
          },
          data: {
            type: 'payment_success',
            payment_id: payment.id.toString(),
            order_id: orderId.toString(),
            amount: amount.toString(),
            click_action: 'FLUTTER_NOTIFICATION_CLICK'
          },
          android: {
            priority: 'high',
            notification: {
              channelId: 'watercan_channel',
              priority: 'high',
              sound: 'default',
              color: '#4CAF50'
            }
          },
          apns: {
            payload: {
              aps: {
                sound: 'default',
                badge: 1
              }
            }
          }
        };

        await admin.messaging().send(message);
        console.log(`🔔 Payment confirmation notification sent to user ${userId}`);
      }
    } catch (notifError) {
      console.error('⚠️ Failed to send notification:', notifError.message);
      // Don't fail the payment if notification fails
    }

    res.status(201).json({
      message: 'Payment created successfully',
      payment: {
        id: payment.id,
        orderId: payment.order_id,
        method: payment.method,
        amount: payment.amount,
        status: payment.status,
        paidAt: payment.paid_at
      }
    });

  } catch (error) {
    console.error('❌ Create payment error:', error);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

// =====================================================
// GET PAYMENT BY ORDER ID
// =====================================================
router.get('/order/:orderId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { orderId } = req.params;

    const query = `
      SELECT p.*, o.user_id
      FROM payments p
      JOIN orders o ON p.order_id = o.id
      WHERE p.order_id = $1 AND o.user_id = $2
    `;

    const result = await pool.query(query, [orderId, userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    res.json({
      payment: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Get payment error:', error);
    res.status(500).json({ error: 'Failed to get payment' });
  }
});

// =====================================================
// GET ALL PAYMENTS FOR USER
// =====================================================
router.get('/my-payments', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    const query = `
      SELECT p.*, o.quantity, o.total_amount, o.created_at as order_date
      FROM payments p
      JOIN orders o ON p.order_id = o.id
      WHERE o.user_id = $1
      ORDER BY p.paid_at DESC
    `;

    const result = await pool.query(query, [userId]);

    res.json({
      payments: result.rows
    });

  } catch (error) {
    console.error('❌ Get payments error:', error);
    res.status(500).json({ error: 'Failed to get payments' });
  }
});

// =====================================================
// GET PAYMENTS FOR DISTRIBUTOR (NEW)
// =====================================================
router.get('/distributor/payments', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Access token required' });
    }

    const secret = process.env.JWT_SECRET;

    jwt.verify(token, secret, async (err, distributor) => {
      if (err) {
        return res.status(403).json({ error: 'Invalid or expired token' });
      }

      const distributorId = distributor.distributorId;

      try {
        // Get all apartments for this distributor
        const apartmentsResult = await pool.query(
          'SELECT id FROM apartment_groups WHERE distributor_id = $1',
          [distributorId]
        );

        const apartmentIds = apartmentsResult.rows.map(row => row.id);

        if (apartmentIds.length === 0) {
          return res.json({ payments: [], count: 0 });
        }

        // Get all payments from users in these apartments
        const query = `
          SELECT 
            p.*,
            o.quantity,
            o.total_amount,
            o.user_id,
            u.full_name as user_name,
            u.phone as user_phone,
            ag.name as apartment_name
          FROM payments p
          JOIN orders o ON p.order_id = o.id
          JOIN users u ON o.user_id = u.id
          JOIN apartment_groups ag ON u.apartment_id = ag.id
          WHERE u.apartment_id = ANY($1)
          ORDER BY p.paid_at DESC
          LIMIT 100
        `;

        const result = await pool.query(query, [apartmentIds]);

        res.json({
          payments: result.rows,
          count: result.rows.length
        });
      } catch (queryError) {
        console.error('❌ Get distributor payments query error:', queryError);
        res.status(500).json({ error: 'Failed to get payments' });
      }
    });

  } catch (error) {
    console.error('❌ Get distributor payments error:', error);
    res.status(500).json({ error: 'Failed to get payments' });
  }
});

module.exports = router;