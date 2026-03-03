const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');

// =====================================================
// RATE LIMITERS
// =====================================================

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many OTP requests. Please try again later.' },
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many verification attempts. Please try again later.' },
});

// =====================================================
// OTP STORAGE
// =====================================================

const otpStore = new Map();

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function hashOTP(otp) {
  return await bcrypt.hash(otp, 10);
}

async function verifyOTP(plainOTP, hashedOTP) {
  return await bcrypt.compare(plainOTP, hashedOTP);
}

// Clean expired OTPs
setInterval(() => {
  const now = Date.now();
  for (const [phone, data] of otpStore.entries()) {
    if (now > data.expiresAt) {
      otpStore.delete(phone);
    }
  }
}, 5 * 60 * 1000);

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

// =====================================================
// AUTH ENDPOINTS
// =====================================================

router.post('/send-otp', otpLimiter, async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone || !/^\d{10}$/.test(phone)) {
      return res.status(400).json({
        error: 'Valid 10-digit phone number required'
      });
    }

    const otp = generateOTP();
    const hashedOTP = await hashOTP(otp);
    const expiresAt = Date.now() + (10 * 60 * 1000);

    otpStore.set(phone, {
      hashedOTP,
      expiresAt,
      attempts: 0
    });

    console.log(`📱 OTP generated for ${phone}: ${otp}`);

    res.json({
      message: 'OTP sent successfully',
      otp
    });

  } catch (error) {
    console.error('❌ Send OTP error:', error);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

router.post('/verify-otp', verifyLimiter, async (req, res) => {
  try {
    const { phone, otp, fullName } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({
        error: 'Phone and OTP are required'
      });
    }

    const storedData = otpStore.get(phone);

    if (!storedData) {
      return res.status(400).json({
        error: 'No OTP found. Please request a new one.'
      });
    }

    if (Date.now() > storedData.expiresAt) {
      otpStore.delete(phone);
      return res.status(400).json({
        error: 'OTP expired. Please request a new one.'
      });
    }

    const isValid = await verifyOTP(otp, storedData.hashedOTP);

    if (!isValid) {
      storedData.attempts++;
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    const userQuery = 'SELECT * FROM users WHERE phone = $1';
    const userResult = await pool.query(userQuery, [phone]);

    let user;
    let isNewUser = false;

    if (userResult.rows.length === 0) {
      if (!fullName || fullName.trim() === '') {
        return res.status(400).json({
          error: 'Full name is required for new users',
          requiresName: true
        });
      }

      const insertQuery =
        'INSERT INTO users (phone, full_name) VALUES ($1, $2) RETURNING *';
      const insertResult = await pool.query(insertQuery, [phone, fullName.trim()]);
      user = insertResult.rows[0];
      isNewUser = true;

      // Create default can status
      await pool.query(
        `INSERT INTO can_status (user_id, can_1_full, can_2_full, can_3_full) 
         VALUES ($1, true, true, true)`,
        [user.id]
      );

      console.log(`✅ New user registered: ${phone}`);
    } else {
      user = userResult.rows[0];
      console.log(`✅ User logged in: ${phone}`);
    }

    otpStore.delete(phone);

    const token = jwt.sign(
      {
        userId: user.id,
        phone: user.phone
      },
      process.env.JWT_SECRET || 'watercan-secret-key-2026',
      { expiresIn: '30d' }
    );

    res.json({
      message: isNewUser ? 'Registration successful' : 'Login successful',
      token,
      user: {
        id: user.id,
        phone: user.phone,
        fullName: user.full_name
      }
    });

  } catch (error) {
    console.error('❌ Verify OTP error:', error);
    res.status(500).json({ error: 'Failed to verify OTP' });
  }
});

// =====================================================
// USER PROFILE
// =====================================================

router.get('/profile', authenticateToken, async (req, res) => {
  try {
    console.log(`📤 Getting profile for user ${req.user.userId}`);

    const query = 'SELECT id, phone, full_name, address, created_at FROM users WHERE id = $1';
    const result = await pool.query(query, [req.user.userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    console.log(`✅ Profile found`);

    res.json({
      user: {
        id: result.rows[0].id,
        phone: result.rows[0].phone,
        fullName: result.rows[0].full_name,
        address: result.rows[0].address,
        createdAt: result.rows[0].created_at
      }
    });

  } catch (error) {
    console.error('❌ Get profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// =====================================================
// FCM TOKEN (FOR NOTIFICATIONS)
// =====================================================

router.post('/fcm-token', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { fcm_token } = req.body;

    await pool.query(
      'UPDATE users SET fcm_token = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [fcm_token, userId]
    );

    console.log(`✅ FCM token saved for user ${userId}`);
    res.json({ success: true, message: 'FCM token saved' });

  } catch (error) {
    console.error('❌ Error saving FCM token:', error);
    res.status(500).json({ error: 'Failed to save FCM token' });
  }
});

// =====================================================
// CAN STATUS ENDPOINTS
// =====================================================

router.put('/:userId/can-status', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { can_1_full, can_2_full, can_3_full } = req.body;

    console.log(`📤 Updating can status for user ${userId}`);

    await pool.query(
      `INSERT INTO can_status (user_id, can_1_full, can_2_full, can_3_full, updated_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id) 
       DO UPDATE SET 
         can_1_full = $2, 
         can_2_full = $3, 
         can_3_full = $4, 
         updated_at = CURRENT_TIMESTAMP`,
      [userId, can_1_full, can_2_full, can_3_full]
    );

    console.log(`✅ Can status updated`);

    res.json({
      success: true,
      message: 'Can status updated',
      canStatus: { can_1_full, can_2_full, can_3_full }
    });

  } catch (error) {
    console.error('❌ Error updating can status:', error);
    res.status(500).json({ error: 'Failed to update can status' });
  }
});

// =====================================================
// ✅ PAYMENTS ENDPOINT - FIXED
// =====================================================

router.post('/payments', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { order_id, method, amount, status } = req.body;

    console.log(`📤 Creating payment for user ${userId}:`, {
      order_id,
      method,
      amount,
      status: status || 'success'
    });

    // Validate
    if (!order_id || !method || !amount) {
      return res.status(400).json({
        error: 'Order ID, method, and amount are required'
      });
    }

    // Check order exists
    const orderCheck = await pool.query(
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
      [order_id, userId]
    );

    if (orderCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Create payment
    const result = await pool.query(
      `INSERT INTO payments (order_id, method, amount, status, paid_at) 
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP) 
       RETURNING *`,
      [order_id, method, amount, status || 'success']
    );

    console.log(`✅ Payment created: ID ${result.rows[0].id}`);

    res.json({
      message: 'Payment created successfully',
      payment: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Create payment error:', error);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

// =====================================================
// ✅ CAN RETURNS ENDPOINTS - FIXED
// =====================================================

// Create return request
router.post('/:userId/returns', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { quantity, pickup_address, pickup_date, instructions, status, cans_selected } = req.body;

    console.log(`📤 Creating return request for user ${userId}:`, {
      quantity,
      pickup_date,
      status: status || 'pending'
    });

    // Validate
    if (!quantity || quantity < 1 || quantity > 3) {
      return res.status(400).json({
        error: 'Quantity must be between 1 and 3'
      });
    }

    if (!pickup_address || pickup_address.trim() === '') {
      return res.status(400).json({ error: 'Pickup address is required' });
    }

    if (!pickup_date) {
      return res.status(400).json({ error: 'Pickup date is required' });
    }

    // Create return request
    const result = await pool.query(
      `INSERT INTO can_returns (
        user_id, 
        quantity, 
        pickup_address, 
        pickup_date, 
        instructions,
        status, 
        cans_selected,
        created_at
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        userId,
        quantity,
        pickup_address.trim(),
        pickup_date,
        instructions || '',
        status || 'pending',
        JSON.stringify(cans_selected || {})
      ]
    );

    console.log(`✅ Return request created: ID ${result.rows[0].id}`);

    res.status(201).json({
      message: 'Return request created successfully',
      return: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Create return error:', error);
    res.status(500).json({ error: 'Failed to create return request' });
  }
});

// Get user's return requests
router.get('/:userId/returns', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;

    console.log(`📤 Getting returns for user ${userId}`);

    const result = await pool.query(
      `SELECT * FROM can_returns 
       WHERE user_id = $1 
       ORDER BY created_at DESC`,
      [userId]
    );

    console.log(`✅ Found ${result.rows.length} returns`);

    res.json({
      returns: result.rows
    });

  } catch (error) {
    console.error('❌ Get returns error:', error);
    res.status(500).json({ error: 'Failed to get returns' });
  }
});

module.exports = router;