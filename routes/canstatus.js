const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const jwt = require('jsonwebtoken');

// =====================================================
// AUTHENTICATION MIDDLEWARE - FIXED
// =====================================================
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
        console.error('❌ Token verification failed:', err.message);
        return res.status(403).json({ error: 'Invalid or expired token' });
      }
      req.user = user;
      next();
    }
  );
}

// =====================================================
// GET /api/can-status - Get user's can status
// =====================================================
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    console.log(`📤 Getting can status for user ${userId}`);
    
    // ✅ FIXED: Check if user exists first
    const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
    
    if (userCheck.rows.length === 0) {
      console.error(`❌ User ${userId} not found in database`);
      return res.status(404).json({ error: 'User not found' });
    }
    
    const result = await pool.query(
      'SELECT * FROM can_status WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      // Create default status if doesn't exist (all cans full by default)
      console.log(`🆕 Creating default can status for user ${userId}`);
      
      // ✅ FIXED: User exists, safe to insert
      const newStatus = await pool.query(
        `INSERT INTO can_status (user_id, can_1_full, can_2_full, can_3_full, updated_at) 
         VALUES ($1, true, true, true, CURRENT_TIMESTAMP) 
         RETURNING *`,
        [userId]
      );
      
      console.log(`✅ Default can status created for user ${userId}`);
      return res.json({ 
        canStatus: newStatus.rows[0] 
      });
    }

    console.log(`✅ Can status found for user ${userId}`);
    res.json({ 
      canStatus: result.rows[0] 
    });

  } catch (error) {
    console.error('❌ Error getting can status:', error);
    
    // ✅ FIXED: Better error messages
    if (error.code === '23503') {
      return res.status(400).json({ 
        error: 'User not found. Please log in again.',
        code: 'USER_NOT_FOUND'
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to get can status',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// =====================================================
// PUT /api/can-status - Update can status
// =====================================================
router.put('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { can_1_full, can_2_full, can_3_full } = req.body;
    
    console.log(`📤 Updating can status for user ${userId}:`, {
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

    // ✅ FIXED: Check if user exists first
    const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
    
    if (userCheck.rows.length === 0) {
      console.error(`❌ User ${userId} not found in database`);
      return res.status(404).json({ error: 'User not found. Please log in again.' });
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
      [userId, can_1_full, can_2_full, can_3_full]
    );

    console.log(`✅ Can status updated successfully for user ${userId}`);

    // ✅ NEW: Send notification if cans were filled
    const wasFilled = can_1_full === true || can_2_full === true || can_3_full === true;
    if (wasFilled) {
      await sendCanFilledNotification(userId);
    }

    res.json({ 
      message: 'Can status updated successfully',
      canStatus: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Error updating can status:', error);
    
    // ✅ FIXED: Better error messages
    if (error.code === '23503') {
      return res.status(400).json({ 
        error: 'User not found. Please log in again.',
        code: 'USER_NOT_FOUND'
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to update can status',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// =====================================================
// ✅ NEW: BULK UPDATE CAN STATUS (for distributor)
// PUT /api/can-status/bulk - Distributor fills multiple cans
// =====================================================
router.put('/bulk', authenticateToken, async (req, res) => {
  try {
    const { updates } = req.body; // Array of { userId, can_1_full, can_2_full, can_3_full }
    
    console.log(`📤 Bulk updating can status for ${updates.length} users`);

    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'Updates array is required' });
    }

    const results = [];
    const notifications = [];

    for (const update of updates) {
      const { userId, can_1_full, can_2_full, can_3_full } = update;

      // Validate
      if (!userId) continue;

      try {
        // Update can status
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
          [userId, can_1_full, can_2_full, can_3_full]
        );

        results.push(result.rows[0]);

        // Send notification if cans were filled
        const wasFilled = can_1_full === true || can_2_full === true || can_3_full === true;
        if (wasFilled) {
          notifications.push(sendCanFilledNotification(userId));
        }

      } catch (err) {
        console.error(`❌ Error updating user ${userId}:`, err);
      }
    }

    // Send all notifications
    await Promise.allSettled(notifications);

    console.log(`✅ Bulk update completed: ${results.length} users updated`);

    res.json({ 
      message: `Successfully updated ${results.length} can statuses`,
      updated: results.length
    });

  } catch (error) {
    console.error('❌ Bulk update error:', error);
    res.status(500).json({ error: 'Failed to bulk update can status' });
  }
});

// =====================================================
// DELETE /api/can-status - Reset can status (optional)
// =====================================================
router.delete('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    console.log(`📤 Resetting can status for user ${userId}`);
    
    const result = await pool.query(
      `UPDATE can_status 
       SET can_1_full = true, can_2_full = true, can_3_full = true, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1
       RETURNING *`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Can status not found' });
    }

    console.log(`✅ Can status reset to all full for user ${userId}`);

    res.json({ 
      message: 'Can status reset successfully',
      canStatus: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Error resetting can status:', error);
    res.status(500).json({ error: 'Failed to reset can status' });
  }
});

// =====================================================
// ✅ NOTIFICATION HELPER FUNCTION
// =====================================================
async function sendCanFilledNotification(userId) {
  try {
    // Get user's FCM token
    const userQuery = await pool.query(
      'SELECT fcm_token, full_name FROM users WHERE id = $1',
      [userId]
    );

    if (userQuery.rows.length === 0 || !userQuery.rows[0].fcm_token) {
      console.log(`ℹ️ No FCM token for user ${userId}`);
      return;
    }

    const fcmToken = userQuery.rows[0].fcm_token;
    const userName = userQuery.rows[0].full_name;

    // Send notification via FCM
    // Note: You'll need to implement FCM sending on your server
    // This is a placeholder for the notification logic
    console.log(`📬 Sending notification to ${userName} (User ${userId})`);
    console.log(`📱 FCM Token: ${fcmToken.substring(0, 20)}...`);

    // TODO: Implement actual FCM notification sending here
    // Example using Firebase Admin SDK:
    /*
    const admin = require('firebase-admin');
    await admin.messaging().send({
      token: fcmToken,
      notification: {
        title: '✅ Cans Filled!',
        body: 'Your water cans have been filled by the distributor'
      },
      data: {
        type: 'can_filled',
        userId: userId.toString()
      }
    });
    */

  } catch (error) {
    console.error(`❌ Error sending notification to user ${userId}:`, error);
  }
}

module.exports = router;