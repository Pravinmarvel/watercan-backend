const express = require('express');
const router  = express.Router();
const { pool } = require('../db');
const jwt     = require('jsonwebtoken');
const admin   = require('firebase-admin');

function authenticateToken(req, res, next) {
  const token = (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

// ════════════════════════════════════════════════════
// CREATE PAYMENT
// ✅ FIX: status is now 'pending_confirmation' (not 'success')
//    until the distributor confirms via /confirm-payment.
//    This prevents users from self-marking as paid.
// ════════════════════════════════════════════════════
router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { orderId, method, amount, status } = req.body;

    if (!orderId || !method || !amount)
      return res.status(400).json({ error: 'Order ID, payment method, and amount are required' });

    console.log(`💰 Creating payment for order ${orderId} by user ${userId}`);

    const orderCheck = await pool.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [orderId, userId]);
    if (!orderCheck.rows.length) return res.status(404).json({ error: 'Order not found' });

    const paymentResult = await pool.query(
      `INSERT INTO payments (order_id, method, amount, status, paid_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP) RETURNING *`,
      [orderId, method, amount, 'pending_confirmation']
      // ✅ Always 'pending_confirmation' — distributor must confirm
    );
    const payment = paymentResult.rows[0];

    // Mark order as payment_pending (not fully paid until distributor confirms)
    await pool.query("UPDATE orders SET status = 'payment_pending' WHERE id = $1", [orderId]);

    console.log(`✅ Payment initiated: ID ${payment.id}, awaiting distributor confirmation`);

    // Notify user that payment is being processed
    try {
      const ur = await pool.query('SELECT fcm_token FROM users WHERE id = $1', [userId]);
      if (ur.rows[0]?.fcm_token) {
        await admin.messaging().send({
          token: ur.rows[0].fcm_token,
          notification: { title: '⏳ Payment Submitted', body: `Your payment of ₹${amount} is pending confirmation by your distributor.` },
          data: { type: 'payment_pending', payment_id: payment.id.toString(), order_id: orderId.toString(), amount: amount.toString(), click_action: 'FLUTTER_NOTIFICATION_CLICK' },
          android: { priority: 'high', notification: { channelId: 'watercan_channel', priority: 'high', sound: 'default', color: '#FF9800' } },
          apns: { payload: { aps: { sound: 'default', badge: 1 } } }
        });
      }
    } catch (fcmErr) { console.error('⚠️ FCM notify error:', fcmErr.message); }

    res.status(201).json({
      message: 'Payment submitted. Awaiting distributor confirmation.',
      payment: { id: payment.id, orderId: payment.order_id, method: payment.method, amount: payment.amount, status: payment.status, paidAt: payment.paid_at }
    });
  } catch (e) { console.error('❌ Create payment error:', e); res.status(500).json({ error: 'Failed to create payment' }); }
});

// ── GET PAYMENT BY ORDER ───────────────────────────
router.get('/order/:orderId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { orderId } = req.params;
    const result = await pool.query(
      'SELECT p.*, o.user_id FROM payments p JOIN orders o ON p.order_id = o.id WHERE p.order_id = $1 AND o.user_id = $2',
      [orderId, userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Payment not found' });
    res.json({ payment: result.rows[0] });
  } catch (e) { console.error('❌ Get payment error:', e); res.status(500).json({ error: 'Failed to get payment' }); }
});

// ── GET ALL PAYMENTS FOR USER ──────────────────────
router.get('/my-payments', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const result = await pool.query(
      `SELECT p.*, o.quantity, o.total_amount, o.created_at as order_date
       FROM payments p JOIN orders o ON p.order_id = o.id
       WHERE o.user_id = $1 ORDER BY p.paid_at DESC`,
      [userId]
    );
    res.json({ payments: result.rows });
  } catch (e) { console.error('❌ Get payments error:', e); res.status(500).json({ error: 'Failed to get payments' }); }
});

// ── GET PAYMENTS FOR DISTRIBUTOR (all) ────────────
router.get('/distributor/payments', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access token required' });

    jwt.verify(token, process.env.JWT_SECRET, async (err, distributor) => {
      if (err) return res.status(403).json({ error: 'Invalid or expired token' });
      const distributorId = distributor.distributorId;

      try {
        const aptsResult = await pool.query('SELECT id FROM apartment_groups WHERE distributor_id = $1', [distributorId]);
        const aptIds = aptsResult.rows.map(r => r.id);
        if (!aptIds.length) return res.json({ payments: [], count: 0 });

        const result = await pool.query(
          `SELECT p.*, o.quantity, o.total_amount, o.user_id, u.full_name as user_name,
                  u.phone as user_phone, ag.name as apartment_name
           FROM payments p JOIN orders o ON p.order_id = o.id
           JOIN users u ON o.user_id = u.id
           JOIN apartment_groups ag ON u.apartment_id = ag.id
           WHERE u.apartment_id = ANY($1) ORDER BY p.paid_at DESC LIMIT 100`,
          [aptIds]
        );
        res.json({ payments: result.rows, count: result.rows.length });
      } catch (qe) { console.error('❌ Distributor payments query error:', qe); res.status(500).json({ error: 'Failed to get payments' }); }
    });
  } catch (e) { console.error('❌ Get distributor payments error:', e); res.status(500).json({ error: 'Failed to get payments' }); }
});

// ════════════════════════════════════════════════════
// ✅ NEW: GET PENDING CONFIRMATION PAYMENTS (for distributor)
// Distributor sees who has submitted payment but not yet been confirmed.
// ════════════════════════════════════════════════════
router.get('/distributor/pending', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access token required' });

    let distributor;
    try { distributor = jwt.verify(token, process.env.JWT_SECRET); }
    catch { return res.status(403).json({ error: 'Invalid or expired token' }); }

    const aptsResult = await pool.query('SELECT id FROM apartment_groups WHERE distributor_id = $1', [distributor.distributorId]);
    const aptIds = aptsResult.rows.map(r => r.id);
    if (!aptIds.length) return res.json({ payments: [] });

    const result = await pool.query(
      `SELECT p.id as payment_id, p.method, p.amount, p.paid_at,
              o.id as order_id, o.quantity,
              u.id as user_id, u.full_name, u.phone,
              ag.name as apartment_name
       FROM payments p JOIN orders o ON p.order_id = o.id
       JOIN users u ON o.user_id = u.id
       JOIN apartment_groups ag ON u.apartment_id = ag.id
       WHERE u.apartment_id = ANY($1) AND p.status = 'pending_confirmation'
       ORDER BY p.paid_at ASC`,
      [aptIds]
    );
    res.json({ payments: result.rows });
  } catch (e) { console.error('❌ Get pending payments error:', e); res.status(500).json({ error: 'Failed to get pending payments' }); }
});

module.exports = router;