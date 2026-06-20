const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin'); // ✅ CORRECT IMPORT

// =====================================================
// AUTHENTICATION MIDDLEWARE - HANDLES BOTH USER & DISTRIBUTOR TOKENS
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
    (err, decoded) => {
      if (err) {
        console.error('❌ Token verification failed:', err.message);
        return res.status(403).json({ error: 'Invalid or expired token' });
      }
      
      // ✅ CRITICAL FIX: Handle both user and distributor tokens
      if (decoded.userId) {
        req.user = decoded; // User token
      } else if (decoded.distributorId) {
        req.distributor = decoded; // Distributor token
      } else {
        return res.status(403).json({ error: 'Invalid token format' });
      }
      
      next();
    }
  );
}

// =====================================================
// GET /api/can-status - Get user's can status
// =====================================================
router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID required' });
    }
    
    console.log(`📤 Getting can status for user ${userId}`);
    
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
      console.log(`🆕 Creating default can status for user ${userId}`);
      
      const newStatus = await pool.query(
        `INSERT INTO can_status (user_id, can_1_full, can_2_full, can_3_full, updated_at) 
         VALUES ($1, true, true, true, CURRENT_TIMESTAMP) 
         RETURNING *`,
        [userId]
      );
      
      console.log(`✅ Default can status created for user ${userId}`);
      return res.json({ canStatus: newStatus.rows[0] });
    }

    console.log(`✅ Can status found for user ${userId}`);
    res.json({ canStatus: result.rows[0] });

  } catch (error) {
    console.error('❌ Error getting can status:', error);
    res.status(500).json({ error: 'Failed to get can status' });
  }
});

// =====================================================
// PUT /api/can-status - Update can status
// ✅ WORKS FOR BOTH USER AND DISTRIBUTOR!
// =====================================================
router.put('/', authenticateToken, async (req, res) => {
  try {
    // ✅ CRITICAL FIX: Extract userId from either path param OR token
    let userId;
    
    // Check if userId is in the URL path (e.g., /api/users/1/can-status)
    if (req.baseUrl && req.baseUrl.includes('/users/')) {
      const match = req.baseUrl.match(/\/users\/(\d+)/);
      userId = match ? parseInt(match[1]) : null;
    }
    
    // Fallback to token userId
    if (!userId && req.user?.userId) {
      userId = req.user.userId;
    }
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID required' });
    }
    
    const { can_1_full, can_2_full, can_3_full } = req.body;
    
    console.log(`📤 Updating can status for user ${userId}:`, {
      can_1_full,
      can_2_full,
      can_3_full,
      updatedBy: req.user ? 'user' : 'distributor'
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

    // Check if user exists
    const userCheck = await pool.query('SELECT id, full_name FROM users WHERE id = $1', [userId]);
    
    if (userCheck.rows.length === 0) {
      console.error(`❌ User ${userId} not found in database`);
      return res.status(404).json({ error: 'User not found' });
    }

    // Insert or update using UPSERT
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

    // ✅ Send notification if cans were filled (only when called by distributor)
    const wasFilled = can_1_full === true || can_2_full === true || can_3_full === true;
    if (wasFilled && req.distributor) {
      const userName = userCheck.rows[0].full_name;
      await sendCanFilledNotification(userId, userName);
    }

    res.json({ 
      message: 'Can status updated successfully',
      canStatus: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Error updating can status:', error);
    res.status(500).json({ error: 'Failed to update can status' });
  }
});

// =====================================================
// BULK UPDATE - Distributor fills multiple cans
// =====================================================
router.put('/bulk', authenticateToken, async (req, res) => {
  try {
    const { updates } = req.body;
    
    console.log(`📤 Bulk updating can status for ${updates.length} users`);

    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'Updates array is required' });
    }

    const results = [];
    const notifications = [];

    for (const update of updates) {
      const { userId, can_1_full, can_2_full, can_3_full } = update;

      if (!userId) continue;

      try {
        // Get user info
        const userCheck = await pool.query(
          'SELECT id, full_name FROM users WHERE id = $1', 
          [userId]
        );
        
        if (userCheck.rows.length === 0) continue;

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

        // Send notification if filled
        const wasFilled = can_1_full === true || can_2_full === true || can_3_full === true;
        if (wasFilled) {
          const userName = userCheck.rows[0].full_name;
          notifications.push(sendCanFilledNotification(userId, userName));
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
// DELETE /api/can-status - Reset can status
// =====================================================
router.delete('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId;
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID required' });
    }
    
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
// ✅ BEAUTIFUL NOTIFICATION WITH DISTRIBUTOR NAME & TIME
// =====================================================
async function sendCanFilledNotification(userId, userName) {
  try {
    // Get user's FCM token
    const userQuery = await pool.query(
      'SELECT fcm_token FROM users WHERE id = $1',
      [userId]
    );

    if (userQuery.rows.length === 0 || !userQuery.rows[0].fcm_token) {
      console.log(`ℹ️ No FCM token for user ${userId}`);
      return;
    }

    const fcmToken = userQuery.rows[0].fcm_token;

    // ✅ Get distributor info
    const distributorQuery = await pool.query(`
      SELECT d.full_name as distributor_name
      FROM users u
      JOIN apartment_groups ag ON u.apartment_id = ag.id
      JOIN distributors d ON ag.distributor_id = d.id
      WHERE u.id = $1
    `, [userId]);

    const distributorName = distributorQuery.rows[0]?.distributor_name || 'Your distributor';
    
    // ✅ Format time and date (IST)
    const now = new Date();
    const currentTime = now.toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata'
    });
    const currentDate = now.toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata'
    });
    const dateTimeStr = `${currentDate}, ${currentTime}`;

    // ✅ Send beautiful notification with Firebase Admin SDK
    await admin.messaging().send({
      token: fcmToken,
      notification: {
        title: `✨ Fresh Water Delivered!`,
        body: `${distributorName} filled your cans on ${dateTimeStr}. Enjoy fresh, clean water! 💧`
      },
      data: {
        type: 'can_filled',
        userId: userId.toString(),
        distributorName: distributorName,
        timestamp: now.toISOString(),
        time: currentTime,
        date: currentDate,
        dateTime: dateTimeStr
      },
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'watercan_channel',
          icon: '@mipmap/ic_launcher',
          color: '#03A9F4',
          defaultSound: true,
          defaultVibrateTimings: true
        }
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
            'content-available': 1
          }
        }
      }
    });

    console.log(`✅ Notification sent: "${distributorName} filled cans for ${userName} at ${currentTime}"`);

  } catch (error) {
    console.error(`❌ Notification error for user ${userId}:`, error.message);
  }
}

// =====================================================
// PUT /api/can-status/fill/:userId
// ✅ Called by DISTRIBUTOR to fill cans for a specific user
// =====================================================
router.put('/fill/:userId', authenticateToken, async (req, res) => {
  try {
    const distributorId = req.distributor?.distributorId;

    if (!distributorId) {
      return res.status(401).json({ error: 'Distributor authentication required' });
    }

    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const { can_1_full, can_2_full, can_3_full } = req.body;

    if (
      typeof can_1_full !== 'boolean' ||
      typeof can_2_full !== 'boolean' ||
      typeof can_3_full !== 'boolean'
    ) {
      return res.status(400).json({ error: 'All can status values must be boolean' });
    }

    const userCheck = await pool.query(
      'SELECT id, full_name FROM users WHERE id = $1',
      [userId]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

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

    console.log(`✅ Distributor ${distributorId} filled cans for user ${userId}`);

    // ✅ NEW: Remove the EARLIEST pending scheduled order for this user.
    // Each fill clears one scheduled delivery, earliest first. So if a user
    // has two scheduled cans, the one with the earliest scheduled_for is
    // removed on this fill, and the later one remains for the next fill.
    try {
      const sched = await pool.query(
        `SELECT id FROM orders
         WHERE user_id = $1 AND status = 'scheduled' AND scheduled_for IS NOT NULL
         ORDER BY scheduled_for ASC
         LIMIT 1`,
        [userId]
      );
      if (sched.rows.length > 0) {
        await pool.query(
          `UPDATE orders SET status = 'delivered' WHERE id = $1`,
          [sched.rows[0].id]
        );
        console.log(`✅ Cleared earliest scheduled order ${sched.rows[0].id} for user ${userId}`);
      }
    } catch (schedErr) {
      console.warn('⚠️ Could not clear scheduled order:', schedErr.message);
    }

    const wasFilled = can_1_full === true || can_2_full === true || can_3_full === true;
    if (wasFilled) {
      const userName = userCheck.rows[0].full_name;
      sendCanFilledNotification(userId, userName).catch(() => {});
    }

    res.json({
      message: 'Can status updated successfully',
      canStatus: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Error in distributor fill route:', error);
    res.status(500).json({ error: 'Failed to update can status' });
  }
});


// =====================================================
// ✅ FCM NOTIFICATION: Additional Cans Filled by Distributor
// =====================================================
async function sendAdditionalCanFilledNotification(userId, userName, count) {
  try {
    const userQuery = await pool.query(
      'SELECT fcm_token FROM users WHERE id = $1',
      [userId]
    );

    if (userQuery.rows.length === 0 || !userQuery.rows[0].fcm_token) {
      console.log(`ℹ️ No FCM token for user ${userId}`);
      return;
    }

    const fcmToken = userQuery.rows[0].fcm_token;

    const distributorQuery = await pool.query(`
      SELECT d.full_name as distributor_name
      FROM users u
      JOIN apartment_groups ag ON u.apartment_id = ag.id
      JOIN distributors d ON ag.distributor_id = d.id
      WHERE u.id = $1
    `, [userId]);

    const distributorName = distributorQuery.rows[0]?.distributor_name || 'Your distributor';

    const now = new Date();
    const currentTime = now.toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata'
    });
    const currentDate = now.toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata'
    });
    const dateTimeStr = `${currentDate}, ${currentTime}`;

    await admin.messaging().send({
      token: fcmToken,
      notification: {
        title: `💧 Additional Cans Delivered!`,
        body: `${distributorName} delivered your ${count} additional can${count > 1 ? 's' : ''} on ${dateTimeStr}. Enjoy! 🌊`
      },
      data: {
        type: 'additional_can_filled',
        userId: userId.toString(),
        distributorName: distributorName,
        filledCount: count.toString(),
        timestamp: now.toISOString(),
        time: currentTime,
        date: currentDate,
        dateTime: dateTimeStr
      },
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'watercan_channel',
          icon: '@mipmap/ic_launcher',
          color: '#03A9F4',
          defaultSound: true,
          defaultVibrateTimings: true
        }
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
            'content-available': 1
          }
        }
      }
    });

    console.log(`✅ Additional can notification sent to user ${userId}: ${distributorName} filled ${count} extra can(s) at ${currentTime}`);

  } catch (error) {
    console.error(`❌ Additional can notification error for user ${userId}:`, error.message);
  }
}


// =====================================================
// PUT /api/can-status/fill-additional/:userId
// ✅ Called by DISTRIBUTOR to mark additional cans as filled
//    Resets additional_cans to 0 and sends FCM notification
// =====================================================
router.put('/fill-additional/:userId', authenticateToken, async (req, res) => {
  try {
    const distributorId = req.distributor?.distributorId;

    if (!distributorId) {
      return res.status(401).json({ error: 'Distributor authentication required' });
    }

    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Get user info and current additional_cans count before resetting
    const userCheck = await pool.query(
      `SELECT u.id, u.full_name, COALESCE(cs.additional_cans, 0) as additional_cans
       FROM users u
       LEFT JOIN can_status cs ON cs.user_id = u.id
       WHERE u.id = $1`,
      [userId]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const additionalCount = parseInt(userCheck.rows[0].additional_cans) || 0;
    const userName = userCheck.rows[0].full_name;

    // ✅ Reset additional_cans to 0 in can_status (upsert)
    const result = await pool.query(
      `INSERT INTO can_status (user_id, can_1_full, can_2_full, can_3_full, additional_cans, updated_at)
       VALUES ($1, true, true, true, 0, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id)
       DO UPDATE SET
         additional_cans = 0,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [userId]
    );

    console.log(`✅ Distributor ${distributorId} filled ${additionalCount} additional can(s) for user ${userId} (${userName})`);

    // ✅ Send FCM notification for additional cans
    sendAdditionalCanFilledNotification(userId, userName, additionalCount).catch(() => {});

    res.json({
      message: `Additional cans filled successfully. Reset to 0.`,
      filledCount: additionalCount,
      canStatus: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Error in fill-additional route:', error);
    res.status(500).json({ error: 'Failed to fill additional cans' });
  }
});

// =====================================================
// PUT /api/can-status/set-additional/:userId
// ✅ Called by USER APP (createwatercan.dart) when they increment/decrement
//    Sets additional_cans = requested count (0–3)
// =====================================================
router.put('/set-additional/:userId', authenticateToken, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Only allow the user themselves to set their additional cans
    if (req.user?.userId !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { additional_cans } = req.body;

    if (typeof additional_cans !== 'number' || additional_cans < 0 || additional_cans > 3) {
      return res.status(400).json({ error: 'additional_cans must be a number between 0 and 3' });
    }

    const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const result = await pool.query(
      `INSERT INTO can_status (user_id, can_1_full, can_2_full, can_3_full, additional_cans, updated_at)
       VALUES ($1, true, true, true, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id)
       DO UPDATE SET
         additional_cans = $2,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [userId, additional_cans]
    );

    console.log(`✅ User ${userId} set additional_cans = ${additional_cans}`);

    res.json({
      message: 'Additional cans updated successfully',
      additionalCans: result.rows[0].additional_cans,
      canStatus: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Error setting additional cans:', error);
    res.status(500).json({ error: 'Failed to set additional cans' });
  }
});

module.exports = router;