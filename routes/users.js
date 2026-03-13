const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');

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

// =====================================================
// ✅ NEW: GOOGLE SIGN-IN
// =====================================================
router.post('/google-signin', async (req, res) => {
  try {
    const { idToken } = req.body;
    
    if (!idToken) {
      return res.status(400).json({ error: 'ID token is required' });
    }

    console.log('📤 Verifying Google ID token...');

    // Verify the Google ID token with Firebase
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const { uid, email, name } = decodedToken;

    console.log(`✅ Google token verified: ${email}`);

    // Check if user exists with this email
    const userQuery = 'SELECT * FROM users WHERE email = $1';
    const userResult = await pool.query(userQuery, [email]);

    if (userResult.rows.length > 0) {
      // Existing user - return token
      const user = userResult.rows[0];
      
      const token = jwt.sign(
        { userId: user.id, email: user.email },
        process.env.JWT_SECRET,
        { expiresIn: '30d' }
      );

      console.log(`✅ Existing user logged in: ${email}`);

      return res.json({
        token,
        user: {
          id: user.id,
          email: user.email,
          phone: user.phone,
          fullName: user.full_name
        },
        requiresPhoneSetup: !user.phone // If no phone, need to set it up
      });
    } else {
      // New user - need phone number and name
      console.log(`ℹ️ New Google user: ${email} - requires phone setup`);

      return res.json({
        requiresPhoneSetup: true,
        email: email,
        googleName: name || null,
        googleUid: uid
      });
    }

  } catch (error) {
    console.error('❌ Google sign-in error:', error);
    
    if (error.code === 'auth/id-token-expired') {
      return res.status(401).json({ error: 'Token expired. Please sign in again.' });
    }
    
    res.status(500).json({ error: 'Failed to verify Google sign-in' });
  }
});

// =====================================================
// ✅ NEW: COMPLETE GOOGLE REGISTRATION (Phone + Name)
// =====================================================
router.post('/complete-google-registration', async (req, res) => {
  try {
    const { email, phone, fullName, googleUid } = req.body;
    
    if (!email || !phone || !fullName || !googleUid) {
      return res.status(400).json({ 
        error: 'Email, phone, full name, and Google UID are required' 
      });
    }

    // Validate phone
    if (!/^\d{10}$/.test(phone)) {
      return res.status(400).json({ error: 'Valid 10-digit phone number is required' });
    }

    console.log(`📤 Completing Google registration for ${email}`);

    // Check if phone is already taken
    const phoneCheck = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
    if (phoneCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Phone number already registered' });
    }

    // Create new user
    const insertQuery = `
      INSERT INTO users (email, phone, full_name, firebase_uid) 
      VALUES ($1, $2, $3, $4) 
      RETURNING *
    `;
    
    const result = await pool.query(insertQuery, [
      email,
      phone,
      fullName.trim(),
      googleUid
    ]);

    const user = result.rows[0];

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    console.log(`✅ Google user registered successfully: ${email}`);

    res.status(201).json({
      message: 'Registration successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        fullName: user.full_name
      }
    });

  } catch (error) {
    console.error('❌ Complete Google registration error:', error);
    res.status(500).json({ error: 'Failed to complete registration' });
  }
});

// =====================================================
// EXISTING OTP ENDPOINTS
// =====================================================

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
    
    console.log(`📱 OTP for ${phone}: ${otp}`);
    
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
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      message: isNewUser ? 'Registration successful' : 'Login successful',
      token,
      user: {
        id: user.id,
        phone: user.phone,
        fullName: user.full_name,
        email: user.email,
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

// GET /api/users/profile
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const query = 'SELECT id, phone, email, full_name, apartment_id, created_at FROM users WHERE id = $1';
    const result = await pool.query(query, [req.user.userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      user: {
        id: result.rows[0].id,
        phone: result.rows[0].phone,
        email: result.rows[0].email,
        fullName: result.rows[0].full_name,
        apartmentId: result.rows[0].apartment_id,
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
        email: result.rows[0].email,
        fullName: result.rows[0].full_name,
        createdAt: result.rows[0].created_at
      }
    });

  } catch (error) {
    console.error('❌ Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ✅ NEW: POST /api/users/fcm-token
router.post('/fcm-token', authenticateToken, async (req, res) => {
  try {
    const { fcm_token } = req.body;

    console.log(`📤 Saving FCM token for user ${req.user.userId}`);

    if (!fcm_token || fcm_token.trim() === '') {
      return res.status(400).json({ error: 'FCM token is required' });
    }

    const query = 'UPDATE users SET fcm_token = $1 WHERE id = $2 RETURNING id';
    const result = await pool.query(query, [fcm_token, req.user.userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    console.log(`✅ FCM token saved for user ${req.user.userId}`);

    res.json({
      message: 'FCM token saved successfully',
      userId: result.rows[0].id
    });

  } catch (error) {
    console.error('❌ Save FCM token error:', error);
    res.status(500).json({ error: 'Failed to save FCM token' });
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

// ✅ FIXED: GET /api/users/:userId/apartment - Returns isWorking status
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
        ag.distributor_id,
        ag.distributor_name,
        ag.distributor_upi_id,
        d.is_working
      FROM users u
      LEFT JOIN apartment_groups ag ON u.apartment_id = ag.id
      LEFT JOIN distributors d ON ag.distributor_id = d.id
      WHERE u.id = $1
    `, [userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const apartmentData = result.rows[0];

    res.json({
      success: true,
      apartment: {
        apartment_id: apartmentData.apartment_id,
        apartment_name: apartmentData.apartment_name,
        location: apartmentData.location,
        price_per_can: apartmentData.price_per_can,
        join_code: apartmentData.join_code,
        distributor_id: apartmentData.distributor_id,
        distributor_name: apartmentData.distributor_name,
        distributor_upi_id: apartmentData.distributor_upi_id,
        isWorking: apartmentData.is_working !== null ? apartmentData.is_working : true
      }
    });
  } catch (error) {
    console.error('❌ Get user apartment error:', error);
    res.status(500).json({ error: 'Failed to get apartment details' });
  }
});

// ✅ NEW: GET /api/users/distributor-upi - For backward compatibility
router.get('/distributor-upi', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        ag.distributor_id,
        ag.distributor_name,
        ag.distributor_upi_id,
        d.is_working
      FROM users u
      LEFT JOIN apartment_groups ag ON u.apartment_id = ag.id
      LEFT JOIN distributors d ON ag.distributor_id = d.id
      WHERE u.id = $1
    `, [req.user.userId]);

    if (result.rows.length === 0 || !result.rows[0].distributor_id) {
      return res.status(404).json({ error: 'No distributor found for this user' });
    }

    const data = result.rows[0];

    res.json({
      distributorId: data.distributor_id,
      distributorName: data.distributor_name,
      upiId: data.distributor_upi_id,
      isWorking: data.is_working !== null ? data.is_working : true
    });
  } catch (error) {
    console.error('❌ Get distributor UPI error:', error);
    res.status(500).json({ error: 'Failed to get distributor information' });
  }
});

module.exports = router;