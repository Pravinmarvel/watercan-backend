const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const jwt = require('jsonwebtoken');

// In-memory OTP storage (10-minute expiry)
const otpStore = new Map();

// Generate 6-digit OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Clean expired OTPs every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [phone, data] of otpStore.entries()) {
    if (now > data.expiresAt) {
      otpStore.delete(phone);
      console.log(`🗑️ Cleaned expired OTP for ${phone}`);
    }
  }
}, 5 * 60 * 1000);

// POST /api/users/send-otp
router.post('/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    
    if (!phone || !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ error: 'Valid 10-digit phone number is required' });
    }

    const otp = generateOTP();
    const expiresAt = Date.now() + (10 * 60 * 1000);

    otpStore.set(phone, { otp, expiresAt, attempts: 0 });
    
    console.log(`📱 OTP generated for ${phone}: ${otp}`);
    
    res.json({ message: 'OTP sent successfully', otp: otp }); // Remove otp in production

  } catch (error) {
    console.error('❌ Send OTP error:', error);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// POST /api/users/verify-otp
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, otp, fullName } = req.body;
    
    if (!phone || !otp) {
      return res.status(400).json({ error: 'Phone and OTP are required' });
    }

    const storedData = otpStore.get(phone);
    if (!storedData) {
      return res.status(400).json({ error: 'No OTP found. Please request a new one.' });
    }

    if (Date.now() > storedData.expiresAt) {
      otpStore.delete(phone);
      return res.status(400).json({ error: 'OTP expired. Please request a new one.' });
    }

    if (storedData.attempts >= 5) {
      otpStore.delete(phone);
      return res.status(400).json({ error: 'Too many attempts. Please request a new OTP.' });
    }

    if (storedData.otp !== otp) {
      storedData.attempts++;
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    // Check if user exists
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

      const insertQuery = 'INSERT INTO users (phone, full_name) VALUES ($1, $2) RETURNING *';
      const insertResult = await pool.query(insertQuery, [phone, fullName.trim()]);
      user = insertResult.rows[0];
      isNewUser = true;
      console.log(`✅ New user registered: ${phone} - ${fullName}`);
    } else {
      user = userResult.rows[0];
      console.log(`✅ User logged in: ${phone}`);
    }

    otpStore.delete(phone);

    const token = jwt.sign(
      { userId: user.id, phone: user.phone },
      process.env.JWT_SECRET || 'watercan-secret-key-2026',
      { expiresIn: '30d' }
    );

    res.json({
      message: isNewUser ? 'Registration successful' : 'Login successful',
      token,
      user: {
        id: user.id,
        phone: user.phone,
        fullName: user.full_name,
        createdAt: user.created_at
      }
    });

  } catch (error) {
    console.error('❌ Verify OTP error:', error);
    res.status(500).json({ error: 'Failed to verify OTP' });
  }
});

// Middleware to verify JWT token
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

// GET /api/users/profile
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const query = 'SELECT id, phone, full_name, created_at FROM users WHERE id = $1';
    const result = await pool.query(query, [req.user.userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      user: {
        id: result.rows[0].id,
        phone: result.rows[0].phone,
        fullName: result.rows[0].full_name,
        createdAt: result.rows[0].created_at
      }
    });

  } catch (error) {
    console.error('❌ Get profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// PUT /api/users/profile
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const { fullName } = req.body;
    
    if (!fullName || fullName.trim() === '') {
      return res.status(400).json({ error: 'Full name is required' });
    }

    const query = 'UPDATE users SET full_name = $1 WHERE id = $2 RETURNING *';
    const result = await pool.query(query, [fullName.trim(), req.user.userId]);

    res.json({
      message: 'Profile updated successfully',
      user: {
        id: result.rows[0].id,
        phone: result.rows[0].phone,
        fullName: result.rows[0].full_name,
        createdAt: result.rows[0].created_at
      }
    });

  } catch (error) {
    console.error('❌ Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ======================================
// ADDRESSES ENDPOINTS
// ======================================

// GET /api/users/addresses
router.get('/addresses', authenticateToken, async (req, res) => {
  try {
    const query = 'SELECT * FROM addresses WHERE user_id = $1 ORDER BY created_at DESC';
    const result = await pool.query(query, [req.user.userId]);

    res.json({ addresses: result.rows });
  } catch (error) {
    console.error('❌ Get addresses error:', error);
    res.status(500).json({ error: 'Failed to get addresses' });
  }
});

// POST /api/users/addresses
router.post('/addresses', authenticateToken, async (req, res) => {
  try {
    const { addressLine, latitude, longitude } = req.body;
    
    if (!addressLine || addressLine.trim() === '') {
      return res.status(400).json({ error: 'Address line is required' });
    }

    const query = `
      INSERT INTO addresses (user_id, address_line, latitude, longitude) 
      VALUES ($1, $2, $3, $4) 
      RETURNING *
    `;
    const result = await pool.query(query, [
      req.user.userId,
      addressLine.trim(),
      latitude || null,
      longitude || null
    ]);

    console.log(`✅ Address created for user ${req.user.userId}`);

    res.status(201).json({
      message: 'Address created successfully',
      address: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Create address error:', error);
    res.status(500).json({ error: 'Failed to create address' });
  }
});

// PUT /api/users/addresses/:id
router.put('/addresses/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { addressLine, latitude, longitude } = req.body;
    
    if (!addressLine || addressLine.trim() === '') {
      return res.status(400).json({ error: 'Address line is required' });
    }

    const query = `
      UPDATE addresses 
      SET address_line = $1, latitude = $2, longitude = $3 
      WHERE id = $4 AND user_id = $5 
      RETURNING *
    `;
    const result = await pool.query(query, [
      addressLine.trim(),
      latitude || null,
      longitude || null,
      id,
      req.user.userId
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Address not found' });
    }

    res.json({
      message: 'Address updated successfully',
      address: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Update address error:', error);
    res.status(500).json({ error: 'Failed to update address' });
  }
});

// ======================================
// ORDERS ENDPOINTS
// ======================================

// GET /api/users/orders
router.get('/orders', authenticateToken, async (req, res) => {
  try {
    const query = `
      SELECT o.*, a.address_line 
      FROM orders o
      LEFT JOIN addresses a ON o.address_id = a.id
      WHERE o.user_id = $1 
      ORDER BY o.created_at DESC
    `;
    const result = await pool.query(query, [req.user.userId]);

    res.json({ orders: result.rows });
  } catch (error) {
    console.error('❌ Get orders error:', error);
    res.status(500).json({ error: 'Failed to get orders' });
  }
});

// POST /api/users/orders
router.post('/orders', authenticateToken, async (req, res) => {
  try {
    const { addressId, quantity, totalAmount, status } = req.body;
    
    if (!addressId || !quantity || !totalAmount) {
      return res.status(400).json({ error: 'Address ID, quantity, and total amount are required' });
    }

    const query = `
      INSERT INTO orders (user_id, address_id, quantity, total_amount, status) 
      VALUES ($1, $2, $3, $4, $5) 
      RETURNING *
    `;
    const result = await pool.query(query, [
      req.user.userId,
      addressId,
      quantity,
      totalAmount,
      status || 'pending'
    ]);

    console.log(`✅ Order created for user ${req.user.userId}`);

    res.status(201).json({
      message: 'Order created successfully',
      order: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Create order error:', error);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// ======================================
// PAYMENTS ENDPOINTS
// ======================================

// GET /api/users/payments
router.get('/payments', authenticateToken, async (req, res) => {
  try {
    const query = `
      SELECT p.*, o.quantity, o.total_amount as order_amount
      FROM payments p
      LEFT JOIN orders o ON p.order_id = o.id
      WHERE o.user_id = $1 
      ORDER BY p.created_at DESC
    `;
    const result = await pool.query(query, [req.user.userId]);

    res.json({ payments: result.rows });
  } catch (error) {
    console.error('❌ Get payments error:', error);
    res.status(500).json({ error: 'Failed to get payments' });
  }
});

// POST /api/users/payments
router.post('/payments', authenticateToken, async (req, res) => {
  try {
    const { orderId, method, amount, status } = req.body;
    
    if (!orderId || !method || !amount) {
      return res.status(400).json({ error: 'Order ID, method, and amount are required' });
    }

    const query = `
      INSERT INTO payments (order_id, method, amount, status) 
      VALUES ($1, $2, $3, $4) 
      RETURNING *
    `;
    const result = await pool.query(query, [
      orderId,
      method,
      amount,
      status || 'success'
    ]);

    console.log(`✅ Payment created for order ${orderId}`);

    res.status(201).json({
      message: 'Payment created successfully',
      payment: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Create payment error:', error);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

// ======================================
// SUBSCRIPTIONS ENDPOINTS
// ======================================

// GET /api/users/subscriptions
router.get('/subscriptions', authenticateToken, async (req, res) => {
  try {
    const query = 'SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC';
    const result = await pool.query(query, [req.user.userId]);

    res.json({ subscriptions: result.rows });
  } catch (error) {
    console.error('❌ Get subscriptions error:', error);
    res.status(500).json({ error: 'Failed to get subscriptions' });
  }
});

// GET /api/users/subscriptions/active
router.get('/subscriptions/active', authenticateToken, async (req, res) => {
  try {
    const query = 'SELECT * FROM subscriptions WHERE user_id = $1 AND is_active = true LIMIT 1';
    const result = await pool.query(query, [req.user.userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ subscription: null });
    }

    res.json({ subscription: result.rows[0] });
  } catch (error) {
    console.error('❌ Get active subscription error:', error);
    res.status(500).json({ error: 'Failed to get active subscription' });
  }
});

// POST /api/users/subscriptions
router.post('/subscriptions', authenticateToken, async (req, res) => {
  try {
    const { isActive, startedAt, endedAt } = req.body;
    
    const query = `
      INSERT INTO subscriptions (user_id, is_active, started_at, ended_at) 
      VALUES ($1, $2, $3, $4) 
      RETURNING *
    `;
    const result = await pool.query(query, [
      req.user.userId,
      isActive !== undefined ? isActive : true,
      startedAt || new Date().toISOString(),
      endedAt || null
    ]);

    console.log(`✅ Subscription created for user ${req.user.userId}`);

    res.status(201).json({
      message: 'Subscription created successfully',
      subscription: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Create subscription error:', error);
    res.status(500).json({ error: 'Failed to create subscription' });
  }
});

// POST /api/users/subscriptions/:id/activate
router.post('/subscriptions/:id/activate', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const query = `
      UPDATE subscriptions 
      SET is_active = true, started_at = $1 
      WHERE id = $2 AND user_id = $3 
      RETURNING *
    `;
    const result = await pool.query(query, [
      new Date().toISOString(),
      id,
      req.user.userId
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    res.json({
      message: 'Subscription activated successfully',
      subscription: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Activate subscription error:', error);
    res.status(500).json({ error: 'Failed to activate subscription' });
  }
});

// POST /api/users/subscriptions/:id/deactivate
router.post('/subscriptions/:id/deactivate', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const query = `
      UPDATE subscriptions 
      SET is_active = false, ended_at = $1 
      WHERE id = $2 AND user_id = $3 
      RETURNING *
    `;
    const result = await pool.query(query, [
      new Date().toISOString(),
      id,
      req.user.userId
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    res.json({
      message: 'Subscription deactivated successfully',
      subscription: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Deactivate subscription error:', error);
    res.status(500).json({ error: 'Failed to deactivate subscription' });
  }
});

// ======================================
// CAN STATUS ENDPOINTS
// ======================================

// GET /api/users/can-status
router.get('/can-status', authenticateToken, async (req, res) => {
  try {
    const query = 'SELECT * FROM can_status WHERE user_id = $1 LIMIT 1';
    const result = await pool.query(query, [req.user.userId]);

    if (result.rows.length === 0) {
      // Create default can status if not exists
      const insertQuery = `
        INSERT INTO can_status (user_id, can_1_full, can_2_full, can_3_full) 
        VALUES ($1, true, true, true) 
        RETURNING *
      `;
      const insertResult = await pool.query(insertQuery, [req.user.userId]);
      return res.json({ canStatus: insertResult.rows[0] });
    }

    res.json({ canStatus: result.rows[0] });
  } catch (error) {
    console.error('❌ Get can status error:', error);
    res.status(500).json({ error: 'Failed to get can status' });
  }
});

// PUT /api/users/can-status
router.put('/can-status', authenticateToken, async (req, res) => {
  try {
    const { can1Full, can2Full, can3Full } = req.body;
    
    // Check if can status exists
    const checkQuery = 'SELECT * FROM can_status WHERE user_id = $1';
    const checkResult = await pool.query(checkQuery, [req.user.userId]);

    let result;
    if (checkResult.rows.length === 0) {
      // Create new can status
      const insertQuery = `
        INSERT INTO can_status (user_id, can_1_full, can_2_full, can_3_full) 
        VALUES ($1, $2, $3, $4) 
        RETURNING *
      `;
      result = await pool.query(insertQuery, [
        req.user.userId,
        can1Full !== undefined ? can1Full : true,
        can2Full !== undefined ? can2Full : true,
        can3Full !== undefined ? can3Full : true
      ]);
    } else {
      // Update existing can status
      const updateQuery = `
        UPDATE can_status 
        SET can_1_full = $1, can_2_full = $2, can_3_full = $3 
        WHERE user_id = $4 
        RETURNING *
      `;
      result = await pool.query(updateQuery, [
        can1Full !== undefined ? can1Full : checkResult.rows[0].can_1_full,
        can2Full !== undefined ? can2Full : checkResult.rows[0].can_2_full,
        can3Full !== undefined ? can3Full : checkResult.rows[0].can_3_full,
        req.user.userId
      ]);
    }

    console.log(`✅ Can status updated for user ${req.user.userId}`);

    res.json({
      message: 'Can status updated successfully',
      canStatus: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Update can status error:', error);
    res.status(500).json({ error: 'Failed to update can status' });
  }
});

module.exports = router;
