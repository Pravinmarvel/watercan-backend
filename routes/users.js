const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// Store OTPs in memory (in production, use Redis)
const otpStore = new Map();

// Generate 6-digit OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send OTP (POST /api/users/send-otp)
router.post('/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone || phone.length < 10) {
      return res.status(400).json({ error: 'Valid phone number is required' });
    }

    // Generate OTP
    const otp = generateOTP();
    
    // Store OTP with 5-minute expiry
    otpStore.set(phone, {
      otp: otp,
      expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes
    });

    // In production, send OTP via SMS (Twilio, AWS SNS, etc.)
    console.log(`📱 OTP for ${phone}: ${otp}`);

    res.json({
      message: 'OTP sent successfully',
      // REMOVE THIS IN PRODUCTION - only for testing
      otp: otp,
      expiresIn: 300 // seconds
    });
  } catch (error) {
    console.error('Send OTP error:', error);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// Verify OTP and Login/Register (POST /api/users/verify-otp)
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, otp, full_name } = req.body;

    if (!phone || !otp) {
      return res.status(400).json({ error: 'Phone and OTP are required' });
    }

    // Check if OTP exists and is valid
    const storedOTP = otpStore.get(phone);
    
    if (!storedOTP) {
      return res.status(400).json({ error: 'No OTP found. Please request a new one.' });
    }

    if (Date.now() > storedOTP.expiresAt) {
      otpStore.delete(phone);
      return res.status(400).json({ error: 'OTP expired. Please request a new one.' });
    }

    if (storedOTP.otp !== otp) {
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    // OTP is valid, delete it
    otpStore.delete(phone);

    // Check if user exists
    let result = await pool.query(
      'SELECT * FROM users WHERE phone = $1',
      [phone]
    );

    let user;
    let isNewUser = false;

    if (result.rows.length === 0) {
      // New user - register
      if (!full_name) {
        return res.status(400).json({ error: 'Full name is required for new users' });
      }

      result = await pool.query(
        'INSERT INTO users (phone, full_name) VALUES ($1, $2) RETURNING id, phone, full_name, created_at',
        [phone, full_name]
      );
      
      user = result.rows[0];
      isNewUser = true;
    } else {
      // Existing user - login
      user = result.rows[0];
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, phone: user.phone },
      process.env.JWT_SECRET || 'watercan-secret-key-change-in-production',
      { expiresIn: '30d' }
    );

    res.json({
      message: isNewUser ? 'Registration successful' : 'Login successful',
      token,
      user: {
        id: user.id,
        phone: user.phone,
        full_name: user.full_name,
        created_at: user.created_at
      },
      isNewUser
    });
  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ error: 'Failed to verify OTP' });
  }
});

// Get user profile (GET /api/users/profile)
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, phone, full_name, created_at FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// Update user profile (PUT /api/users/profile)
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const { full_name } = req.body;

    if (!full_name) {
      return res.status(400).json({ error: 'Full name is required' });
    }

    const result = await pool.query(
      'UPDATE users SET full_name = $1 WHERE id = $2 RETURNING id, phone, full_name, created_at',
      [full_name, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      message: 'Profile updated successfully',
      user: result.rows[0]
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

module.exports = router;
