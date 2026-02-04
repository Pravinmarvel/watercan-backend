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

// POST /api/users/send-otp - Send OTP to phone
router.post('/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    
    // Validate phone number
    if (!phone || !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ 
        error: 'Valid 10-digit phone number is required' 
      });
    }

    // Generate OTP
    const otp = generateOTP();
    const expiresAt = Date.now() + (10 * 60 * 1000); // 10 minutes

    // Store OTP
    otpStore.set(phone, { 
      otp, 
      expiresAt, 
      attempts: 0 
    });
    
    console.log(`📱 OTP generated for ${phone}: ${otp}`);
    
    // TODO: In production, send OTP via Twilio SMS
    // await twilioClient.messages.create({
    //   body: `Your WaterCan OTP is: ${otp}`,
    //   to: phone,
    //   from: process.env.TWILIO_PHONE_NUMBER
    // });
    
    res.json({ 
      message: 'OTP sent successfully',
      // REMOVE THIS LINE IN PRODUCTION!
      otp: otp  // Only for testing
    });

  } catch (error) {
    console.error('❌ Send OTP error:', error);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// POST /api/users/verify-otp - Verify OTP and login/register
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, otp, fullName } = req.body;
    
    // Validate input
    if (!phone || !otp) {
      return res.status(400).json({ 
        error: 'Phone and OTP are required' 
      });
    }

    // Check if OTP exists
    const storedData = otpStore.get(phone);
    if (!storedData) {
      return res.status(400).json({ 
        error: 'No OTP found. Please request a new one.' 
      });
    }

    // Check if expired
    if (Date.now() > storedData.expiresAt) {
      otpStore.delete(phone);
      return res.status(400).json({ 
        error: 'OTP expired. Please request a new one.' 
      });
    }

    // Check attempts (max 5)
    if (storedData.attempts >= 5) {
      otpStore.delete(phone);
      return res.status(400).json({ 
        error: 'Too many attempts. Please request a new OTP.' 
      });
    }

    // Verify OTP
    if (storedData.otp !== otp) {
      storedData.attempts++;
      return res.status(400).json({ 
        error: 'Invalid OTP' 
      });
    }

    // ✅ OTP is correct - check if user exists
    const userQuery = 'SELECT * FROM users WHERE phone = $1';
    const userResult = await pool.query(userQuery, [phone]);

    let user;
    let isNewUser = false;

    if (userResult.rows.length === 0) {
      // New user - require full name
      if (!fullName || fullName.trim() === '') {
        // DON'T delete OTP - allow retry with name
        return res.status(400).json({ 
          error: 'Full name is required for new users',
          requiresName: true  // Signal to Flutter to show name field
        });
      }

      // Create new user
      const insertQuery = `
        INSERT INTO users (phone, full_name) 
        VALUES ($1, $2) 
        RETURNING *
      `;
      const insertResult = await pool.query(insertQuery, [phone, fullName.trim()]);
      user = insertResult.rows[0];
      isNewUser = true;
      console.log(`✅ New user registered: ${phone} - ${fullName}`);
    } else {
      // Existing user
      user = userResult.rows[0];
      console.log(`✅ User logged in: ${phone}`);
    }

    // Delete OTP after successful verification
    otpStore.delete(phone);

    // Generate JWT token
    const token = jwt.sign(
      { 
        userId: user.id, 
        phone: user.phone 
      },
      process.env.JWT_SECRET || 'watercan-secret-key-2026',
      { expiresIn: '30d' }
    );

    // Return success response
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

// GET /api/users/profile - Get user profile
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

// PUT /api/users/profile - Update user profile
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const { fullName } = req.body;
    
    if (!fullName || fullName.trim() === '') {
      return res.status(400).json({ error: 'Full name is required' });
    }

    const query = `
      UPDATE users 
      SET full_name = $1 
      WHERE id = $2 
      RETURNING *
    `;
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

module.exports = router;
