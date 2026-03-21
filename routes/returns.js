const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const jwt = require('jsonwebtoken');

// =====================================================
// AUTHENTICATION MIDDLEWARE - handles user + distributor tokens
// =====================================================
function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    if (decoded.userId) req.user = decoded;
    else if (decoded.distributorId) req.distributor = decoded;
    else return res.status(403).json({ error: 'Invalid token format' });
    next();
  });
}

// =====================================================
// POST /api/returns/create  — USER submits return request
// Body: { quantity, pickupDate, pickupAddress, instructions? }
// =====================================================
router.post('/create', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'User authentication required' });

    const { quantity, pickupDate, pickupAddress, instructions } = req.body;

    if (!quantity || quantity < 1 || quantity > 3)
      return res.status(400).json({ error: 'Quantity must be between 1 and 3' });
    if (!pickupDate)
      return res.status(400).json({ error: 'Pickup date is required' });
    if (!pickupAddress || pickupAddress.trim() === '')
      return res.status(400).json({ error: 'Pickup address is required' });

    // Block duplicates
    const existing = await pool.query(
      `SELECT id FROM can_returns WHERE user_id = $1 AND status = 'pending'`,
      [userId]
    );
    if (existing.rows.length > 0)
      return res.status(400).json({ error: 'You already have a pending return. Cancel it first.' });

    const result = await pool.query(
      `INSERT INTO can_returns
         (user_id, quantity, pickup_date, pickup_address, instructions, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', CURRENT_TIMESTAMP)
       RETURNING *`,
      [userId, quantity, pickupDate, pickupAddress.trim(), instructions ? instructions.trim() : null]
    );

    const row = result.rows[0];
    console.log(`✅ Return created: ID ${row.id}, user ${userId}, qty ${quantity}`);

    res.status(201).json({
      message: 'Return request created successfully',
      return: {
        id: row.id,
        quantity: row.quantity,
        pickupDate: row.pickup_date,
        pickupAddress: row.pickup_address,
        instructions: row.instructions,
        status: row.status,
        createdAt: row.created_at
      }
    });

  } catch (error) {
    console.error('❌ Create return error:', error);
    res.status(500).json({ error: 'Failed to create return request', details: error.message });
  }
});

// =====================================================
// GET /api/returns/my-returns  — USER gets their history
// =====================================================
router.get('/my-returns', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'User authentication required' });

    const result = await pool.query(
      `SELECT * FROM can_returns WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );

    res.json({
      returns: result.rows.map(row => ({
        id: row.id,
        quantity: row.quantity,
        pickupDate: row.pickup_date,
        pickupAddress: row.pickup_address,
        instructions: row.instructions,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
    });

  } catch (error) {
    console.error('❌ Get returns error:', error);
    res.status(500).json({ error: 'Failed to get return requests' });
  }
});

// =====================================================
// GET /api/returns/pending  — DISTRIBUTOR gets pending returns
// =====================================================
router.get('/pending', authenticateToken, async (req, res) => {
  try {
    const distributorId = req.distributor?.distributorId;
    if (!distributorId) return res.status(401).json({ error: 'Distributor authentication required' });

    const result = await pool.query(
      `SELECT cr.*, u.full_name, u.phone,
              ag.name as apartment_name, ag.location as apartment_location
       FROM can_returns cr
       JOIN users u ON cr.user_id = u.id
       LEFT JOIN apartment_groups ag ON u.apartment_id = ag.id
       WHERE cr.status = 'pending' AND ag.distributor_id = $1
       ORDER BY cr.pickup_date ASC`,
      [distributorId]
    );

    console.log(`✅ ${result.rows.length} pending returns for distributor ${distributorId}`);

    res.json({
      returns: result.rows.map(row => ({
        id: row.id,
        userId: row.user_id,
        userName: row.full_name,
        userPhone: row.phone,
        apartmentName: row.apartment_name,
        apartmentLocation: row.apartment_location,
        quantity: row.quantity,
        pickupDate: row.pickup_date,
        pickupAddress: row.pickup_address,
        instructions: row.instructions,
        status: row.status,
        createdAt: row.created_at
      }))
    });

  } catch (error) {
    console.error('❌ Get pending returns error:', error);
    res.status(500).json({ error: 'Failed to get pending returns' });
  }
});

// =====================================================
// PUT /api/returns/:returnId/pick  — DISTRIBUTOR picks up cans
//   1. Marks return as 'collected'
//   2. Sets all 3 cans to EMPTY (false) in can_status
//   3. Sends FCM push notification to user
// =====================================================
router.put('/:returnId/pick', authenticateToken, async (req, res) => {
  try {
    const distributorId = req.distributor?.distributorId;
    if (!distributorId) return res.status(401).json({ error: 'Distributor authentication required' });

    const returnId = parseInt(req.params.returnId);
    if (isNaN(returnId)) return res.status(400).json({ error: 'Invalid return ID' });

    // Fetch return + user FCM token
    const checkResult = await pool.query(
      `SELECT cr.*, u.full_name, u.fcm_token
       FROM can_returns cr
       JOIN users u ON cr.user_id = u.id
       WHERE cr.id = $1 AND cr.status = 'pending'`,
      [returnId]
    );

    if (checkResult.rows.length === 0)
      return res.status(404).json({ error: 'Return request not found or already collected' });

    const row = checkResult.rows[0];
    const userId = row.user_id;
    const userName = row.full_name;
    const quantity = row.quantity;

    // 1. Mark return collected
    await pool.query(
      `UPDATE can_returns SET status = 'collected', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [returnId]
    );

    // 2. Set all 3 cans to EMPTY
    await pool.query(
      `INSERT INTO can_status (user_id, can_1_full, can_2_full, can_3_full, updated_at)
       VALUES ($1, false, false, false, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id)
       DO UPDATE SET can_1_full = false, can_2_full = false, can_3_full = false,
                     updated_at = CURRENT_TIMESTAMP`,
      [userId]
    );

    console.log(`✅ Return ${returnId} picked — user ${userId} cans set EMPTY`);

    // 3. FCM notification
    if (row.fcm_token) {
      try {
        const admin = require('firebase-admin');
        const now = new Date();
        const timeStr = now.toLocaleTimeString('en-IN', {
          hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata'
        });

        await admin.messaging().send({
          token: row.fcm_token,
          notification: {
            title: '📦 Cans Collected!',
            body: `Your ${quantity} empty can${quantity > 1 ? 's have' : ' has'} been picked up at ${timeStr}. Ready for refill! 🚰`
          },
          data: {
            type: 'cans_collected',
            returnId: returnId.toString(),
            userId: userId.toString(),
            quantity: quantity.toString(),
            timestamp: now.toISOString()
          },
          android: {
            priority: 'high',
            notification: {
              sound: 'default', channelId: 'watercan_channel',
              icon: '@mipmap/ic_launcher', color: '#FF5722',
              defaultSound: true, defaultVibrateTimings: true
            }
          },
          apns: { payload: { aps: { sound: 'default', badge: 1, 'content-available': 1 } } }
        });
        console.log(`🔔 FCM sent to user ${userId} at ${timeStr}`);
      } catch (fcmErr) {
        console.error(`⚠️ FCM error:`, fcmErr.message); // non-fatal
      }
    }

    res.json({ message: 'Cans picked up. User notified and cans set to empty.', returnId, userId, userName, quantity });

  } catch (error) {
    console.error('❌ Pick up return error:', error);
    res.status(500).json({ error: 'Failed to mark return as picked up' });
  }
});

// =====================================================
// PUT /api/returns/:returnId/collect  — legacy alias
// =====================================================
router.put('/:returnId/collect', authenticateToken, async (req, res) => {
  try {
    const distributorId = req.distributor?.distributorId;
    if (!distributorId) return res.status(401).json({ error: 'Distributor authentication required' });

    const { returnId } = req.params;
    const check = await pool.query(`SELECT * FROM can_returns WHERE id = $1 AND status = 'pending'`, [returnId]);
    if (check.rows.length === 0) return res.status(404).json({ error: 'Return not found or already collected' });

    const result = await pool.query(
      `UPDATE can_returns SET status = 'collected', updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
      [returnId]
    );
    res.json({ message: 'Return marked as collected', return: { id: result.rows[0].id, status: result.rows[0].status, updatedAt: result.rows[0].updated_at } });

  } catch (error) {
    console.error('❌ Collect error:', error);
    res.status(500).json({ error: 'Failed to mark return as collected' });
  }
});

// =====================================================
// DELETE /api/returns/:returnId  — USER cancels pending return
// =====================================================
router.delete('/:returnId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'User authentication required' });

    const { returnId } = req.params;
    const check = await pool.query(
      `SELECT * FROM can_returns WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
      [returnId, userId]
    );
    if (check.rows.length === 0) return res.status(404).json({ error: 'Return not found or cannot be cancelled' });

    await pool.query('DELETE FROM can_returns WHERE id = $1', [returnId]);
    console.log(`✅ Return ${returnId} cancelled by user ${userId}`);
    res.json({ message: 'Return request cancelled successfully' });

  } catch (error) {
    console.error('❌ Cancel return error:', error);
    res.status(500).json({ error: 'Failed to cancel return request' });
  }
});

// =====================================================
// GET /api/returns/stats  — DISTRIBUTOR statistics
// =====================================================
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const distributorId = req.distributor?.distributorId;
    if (!distributorId) return res.status(401).json({ error: 'Distributor authentication required' });

    const result = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE cr.status = 'pending') as pending_count,
         COUNT(*) FILTER (WHERE cr.status = 'collected') as collected_count,
         SUM(cr.quantity) FILTER (WHERE cr.status = 'pending') as pending_cans,
         SUM(cr.quantity) FILTER (WHERE cr.status = 'collected' AND cr.updated_at >= CURRENT_DATE) as today_collected
       FROM can_returns cr
       JOIN users u ON cr.user_id = u.id
       JOIN apartment_groups ag ON u.apartment_id = ag.id
       WHERE ag.distributor_id = $1`,
      [distributorId]
    );

    const s = result.rows[0];
    res.json({
      pendingReturns: parseInt(s.pending_count) || 0,
      collectedReturns: parseInt(s.collected_count) || 0,
      pendingCans: parseInt(s.pending_cans) || 0,
      todayCollected: parseInt(s.today_collected) || 0
    });

  } catch (error) {
    console.error('❌ Stats error:', error);
    res.status(500).json({ error: 'Failed to get statistics' });
  }
});

module.exports = router;