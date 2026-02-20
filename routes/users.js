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
    
    res.json({ message: 'OTP sent successfully', otp: otp });

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

// Authentication middleware
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
    const { address_line, latitude, longitude } = req.body;
    
    if (!address_line || address_line.trim() === '') {
      return res.status(400).json({ error: 'Address line is required' });
    }

    const query = `
      INSERT INTO addresses (user_id, address_line, latitude, longitude) 
      VALUES ($1, $2, $3, $4) 
      RETURNING *
    `;
    const result = await pool.query(query, [
      req.user.userId,
      address_line.trim(),
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
    const { address_line, latitude, longitude } = req.body;
    
    if (!address_line || address_line.trim() === '') {
      return res.status(400).json({ error: 'Address line is required' });
    }

    const query = `
      UPDATE addresses 
      SET address_line = $1, latitude = $2, longitude = $3 
      WHERE id = $4 AND user_id = $5 
      RETURNING *
    `;
    const result = await pool.query(query, [
      address_line.trim(),
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

// ========================================
// CAN STATUS ENDPOINTS
// ========================================

// GET /api/users/can-status
router.get('/can-status', authenticateToken, async (req, res) => {
  try {
    console.log(`📤 Getting can status for user ${req.user.userId}`);
    
    const result = await pool.query(
      'SELECT * FROM can_status WHERE user_id = $1',
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      console.log(`🆕 Creating default can status for user ${req.user.userId}`);
      
      const newStatus = await pool.query(
        `INSERT INTO can_status (user_id, can_1_full, can_2_full, can_3_full, updated_at) 
         VALUES ($1, true, true, true, CURRENT_TIMESTAMP) 
         RETURNING *`,
        [req.user.userId]
      );
      
      console.log(`✅ Default can status created`);
      return res.json({ canStatus: newStatus.rows[0] });
    }

    console.log(`✅ Can status found`);
    res.json({ canStatus: result.rows[0] });

  } catch (error) {
    console.error('❌ Error getting can status:', error);
    res.status(500).json({ error: 'Failed to get can status' });
  }
});

// PUT /api/users/can-status
router.put('/can-status', authenticateToken, async (req, res) => {
  try {
    const { can_1_full, can_2_full, can_3_full } = req.body;
    
    console.log(`📤 Updating can status for user ${req.user.userId}`);

    if (
      typeof can_1_full !== 'boolean' || 
      typeof can_2_full !== 'boolean' || 
      typeof can_3_full !== 'boolean'
    ) {
      return res.status(400).json({ 
        error: 'All can status values must be boolean' 
      });
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
      [req.user.userId, can_1_full, can_2_full, can_3_full]
    );

    console.log(`✅ Can status updated successfully`);

    res.json({ 
      message: 'Can status updated successfully',
      canStatus: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Error updating can status:', error);
    res.status(500).json({ error: 'Failed to update can status' });
  }
});

// ========================================
// APARTMENT ENDPOINTS
// ========================================

// GET /api/users/apartments
router.get('/apartments', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id, 
        name, 
        location, 
        price_per_can, 
        join_code, 
        distributor_id,
        distributor_name,
        distributor_upi_id,
        created_at
      FROM apartment_groups
      ORDER BY name ASC
    `);

    console.log(`✅ Fetched ${result.rows.length} apartments`);

    res.json({
      success: true,
      apartments: result.rows
    });
  } catch (error) {
    console.error('❌ Get apartments error:', error);
    res.status(500).json({ error: 'Failed to get apartments' });
  }
});

// GET /api/users/apartments/search
router.get('/apartments/search', async (req, res) => {
  const { query } = req.query;

  try {
    const result = await pool.query(`
      SELECT 
        id, 
        name, 
        location, 
        price_per_can, 
        join_code,
        distributor_id,
        distributor_name,
        distributor_upi_id,
        created_at
      FROM apartment_groups
      WHERE 
        LOWER(name) LIKE $1 OR 
        LOWER(location) LIKE $1
      ORDER BY name ASC
    `, [`%${query.toLowerCase()}%`]);

    res.json({
      success: true,
      apartments: result.rows
    });
  } catch (error) {
    console.error('❌ Search apartments error:', error);
    res.status(500).json({ error: 'Failed to search apartments' });
  }
});

// PUT /api/users/:userId/apartment
router.put('/:userId/apartment', authenticateToken, async (req, res) => {
  const { userId } = req.params;
  const { apartment_id } = req.body;

  if (req.user.userId !== parseInt(userId)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    const result = await pool.query(`
      UPDATE users
      SET apartment_id = $1
      WHERE id = $2
      RETURNING id, phone, full_name, apartment_id
    `, [apartment_id, userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      message: 'Apartment updated successfully',
      user: result.rows[0]
    });
  } catch (error) {
    console.error('❌ Update apartment error:', error);
    res.status(500).json({ error: 'Failed to update apartment' });
  }
});

// GET /api/users/:userId/apartment
router.get('/:userId/apartment', authenticateToken, async (req, res) => {
  const { userId } = req.params;

  if (req.user.userId !== parseInt(userId)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    const result = await pool.query(`
      SELECT 
        u.id,
        u.apartment_id,
        ag.name as apartment_name,
        ag.location,
        ag.price_per_can,
        ag.join_code,
        ag.distributor_name,
        ag.distributor_upi_id
      FROM users u
      LEFT JOIN apartment_groups ag ON u.apartment_id = ag.id
      WHERE u.id = $1
    `, [userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      apartment: result.rows[0]
    });
  } catch (error) {
    console.error('❌ Get user apartment error:', error);
    res.status(500).json({ error: 'Failed to get apartment details' });
  }
});

module.exports = router;