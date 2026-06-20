const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');

// ✅ Simple in-memory rate limiter for OTP endpoints
// Prevents brute-force and SMS spam
const otpRateLimitStore = new Map();
function otpRateLimit(req, res, next) {
  const phone = req.body?.phone || req.ip;
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute window
  const maxRequests = 3;       // max 3 OTP requests per minute
  
  const record = otpRateLimitStore.get(phone) || { count: 0, resetAt: now + windowMs };
  
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + windowMs;
  }
  
  record.count++;
  otpRateLimitStore.set(phone, record);
  
  if (record.count > maxRequests) {
    return res.status(429).json({ 
      error: 'Too many OTP requests. Please wait a minute before trying again.' 
    });
  }
  next();
}

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
router.post('/send-otp', otpRateLimit, async (req, res) => {
  try {
    const { phone } = req.body;
    
    if (!phone || !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ error: 'Valid 10-digit phone number is required' });
    }

    const otp = generateOTP();
    const expiresAt = Date.now() + (10 * 60 * 1000);

    otpStore.set(phone, { otp, expiresAt, attempts: 0 });
    
    // ✅ SECURITY: Log OTP only in development, NEVER send it in the response
    if (process.env.NODE_ENV !== 'production') {
      console.log(`📱 OTP for ${phone}: ${otp} [DEV ONLY]`);
    }
    
    res.json({ message: 'OTP sent successfully' }); // ✅ OTP NOT returned to client

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
    const query = 'SELECT id, phone, email, full_name, apartment_id, created_at, cycle_start FROM users WHERE id = $1';
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
        createdAt: result.rows[0].created_at,
        cycleStart: result.rows[0].cycle_start
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
        can_litres,
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
        can_litres,
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
        d.is_working,
        u.cycle_start,
        ag.can_litres
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
        isWorking: apartmentData.is_working !== null ? apartmentData.is_working : true,
        cycle_start: apartmentData.cycle_start,
        can_litres: apartmentData.can_litres
      }
    });
  } catch (error) {
    console.error('❌ Get user apartment error:', error);
    res.status(500).json({ error: 'Failed to get apartment details' });
  }
});

// ✅ PUT /api/users/:userId/cycle-start
// Advance (or set) this user's billing cycle start. Called by the app right
// after a payment succeeds, with cycleStart = payDay + 1 (the new cycle begins
// the day after payment). The distributor's "amount owed" then counts cans from
// this date forward. Body: { cycleStart: 'YYYY-MM-DD' }.
router.put('/:userId/cycle-start', authenticateToken, async (req, res) => {
  const { userId } = req.params;

  if (req.user.userId !== parseInt(userId)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const { cycleStart } = req.body;
  if (!cycleStart || !/^\d{4}-\d{2}-\d{2}$/.test(String(cycleStart))) {
    return res.status(400).json({ error: 'cycleStart must be a YYYY-MM-DD date' });
  }

  try {
    const result = await pool.query(
      'UPDATE users SET cycle_start = $1 WHERE id = $2 RETURNING cycle_start',
      [cycleStart, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    console.log(`✅ User ${userId} cycle_start set to ${cycleStart}`);
    res.json({ success: true, cycle_start: result.rows[0].cycle_start });
  } catch (error) {
    console.error('❌ Set cycle-start error:', error);
    res.status(500).json({ error: 'Failed to set cycle start' });
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


// =====================================================
// PUT /api/users/:userId/additional-cans
// ✅ Called by createwatercan.dart when user increments/decrements
//    Writes the count directly into can_status.additional_cans
// =====================================================
router.put('/:userId/additional-cans', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;

    if (req.user.userId !== parseInt(userId)) {
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

    // ✅ Upsert into can_status — creates the row if it doesn't exist yet
    const result = await pool.query(
      `INSERT INTO can_status (user_id, can_1_full, can_2_full, can_3_full, additional_cans, updated_at)
       VALUES ($1, true, true, true, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id)
       DO UPDATE SET
         additional_cans = $2,
         updated_at = CURRENT_TIMESTAMP
       RETURNING additional_cans`,
      [userId, additional_cans]
    );

    console.log(`✅ User ${userId} set additional_cans = ${additional_cans}`);

    res.json({
      success: true,
      message: 'Additional cans updated',
      additionalCans: result.rows[0].additional_cans
    });

  } catch (error) {
    console.error('❌ Set additional cans error:', error);
    res.status(500).json({ error: 'Failed to update additional cans' });
  }
});

// =====================================================
// PUT /api/users/:userId/cod
// ✅ User chooses Cash on Delivery for the current cycle.
//    Stores a flag (valid until cycle_end) so the distributor sees a COD
//    indicator and collects cash. Uses a small cod_flags table, created
//    on first use so no separate migration is required.
// =====================================================
router.put('/:userId/cod', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;

    if (req.user.userId !== parseInt(userId)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const { cod, cycle_end, amount, cans } = req.body;

    // Create the table if it doesn't exist yet (one-time, idempotent).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cod_flags (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        cycle_end TIMESTAMP,
        amount NUMERIC DEFAULT 0,
        cans INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    if (cod === false) {
      // Turn COD off for this user (clear any active flags).
      await pool.query('DELETE FROM cod_flags WHERE user_id = $1', [userId]);
      return res.json({ success: true, message: 'COD cleared' });
    }

    // Replace any existing flag with the new one for this cycle.
    await pool.query('DELETE FROM cod_flags WHERE user_id = $1', [userId]);
    await pool.query(
      `INSERT INTO cod_flags (user_id, cycle_end, amount, cans, created_at)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
      [userId, cycle_end || null, amount || 0, cans || 0]
    );

    console.log(`✅ COD set for user ${userId} (₹${amount || 0}, ${cans || 0} cans)`);
    res.json({ success: true, message: 'Cash on Delivery recorded' });
  } catch (error) {
    console.error('❌ Set COD error:', error);
    res.status(500).json({ error: 'Failed to set Cash on Delivery' });
  }
});

// ── DELETE ACCOUNT (Play Store requirement) ─────────
// Permanently deletes the user and all of their personal data.
router.delete('/account', authenticateToken, async (req, res) => {
  const userId = req.user.userId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Children first (payments reference orders).
    await client.query(
      'DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE user_id = $1)',
      [userId]
    );
    await client.query('DELETE FROM orders WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM addresses WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM subscriptions WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM can_status WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM can_returns WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM distributor_ratings WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM users WHERE id = $1', [userId]);
    await client.query('COMMIT');
    console.log(`🗑️ User ${userId} account deleted`);
    res.json({ success: true, message: 'Account deleted' });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ Delete user account error:', e);
    res.status(500).json({ error: 'Failed to delete account' });
  } finally {
    client.release();
  }
});

module.exports = router;