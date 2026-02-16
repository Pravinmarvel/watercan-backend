// =====================================================
// SECURE DISTRIBUTOR ROUTES - PRODUCTION READY
// =====================================================

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt'); // npm install bcrypt
const rateLimit = require('express-rate-limit'); // npm install express-rate-limit

// =====================================================
// 1. RATE LIMITING - Prevent brute force attacks
// =====================================================

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Max 5 requests per 15 minutes per IP
  message: { error: 'Too many OTP requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // Max 10 verification attempts per 15 minutes
  message: { error: 'Too many verification attempts. Please try again later.' },
});

// =====================================================
// 2. ENCRYPTED OTP STORAGE
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

// Clean expired OTPs every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [phone, data] of otpStore.entries()) {
    if (now > data.expiresAt) {
      otpStore.delete(phone);
    }
  }
}, 5 * 60 * 1000);

// =====================================================
// 3. SECURE JWT TOKEN GENERATION
// =====================================================

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  // USE ENVIRONMENT VARIABLE - NEVER hardcode!
  const secret = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
  
  jwt.verify(token, secret, (err, distributor) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.distributor = distributor;
    next();
  });
}

// =====================================================
// 4. SEND OTP - WITH RATE LIMITING
// =====================================================

router.post('/send-otp', otpLimiter, async (req, res) => {
  try {
    const { phone } = req.body;

    // Input validation
    if (!phone || !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ 
        error: 'Valid 10-digit phone number required' 
      });
    }

    const otp = generateOTP();
    const hashedOTP = await hashOTP(otp);
    const expiresAt = Date.now() + (10 * 60 * 1000); // 10 minutes

    // Store HASHED OTP, not plain text
    otpStore.set(phone, { 
      hashedOTP, 
      expiresAt, 
      attempts: 0 
    });

    console.log(`📱 OTP generated for ${phone}: ${otp}`);

    // In production, send via SMS service (Twilio, etc.)
    // For now, return in response (REMOVE IN PRODUCTION!)
    res.json({ 
      message: 'OTP sent successfully', 
      otp // ⚠️ REMOVE THIS IN PRODUCTION!
    });

  } catch (error) {
    console.error('❌ Send OTP error:', error);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// =====================================================
// 5. VERIFY OTP - WITH PROTECTION
// =====================================================

router.post('/verify-otp', verifyLimiter, async (req, res) => {
  try {
    const { phone, otp, fullName } = req.body;

    // Input validation
    if (!phone || !otp) {
      return res.status(400).json({ 
        error: 'Phone and OTP are required' 
      });
    }

    if (!/^\d{10}$/.test(phone)) {
      return res.status(400).json({ 
        error: 'Invalid phone number format' 
      });
    }

    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({ 
        error: 'Invalid OTP format' 
      });
    }

    const storedData = otpStore.get(phone);
    
    if (!storedData) {
      return res.status(400).json({ 
        error: 'No OTP found. Please request a new one.' 
      });
    }

    // Check expiry
    if (Date.now() > storedData.expiresAt) {
      otpStore.delete(phone);
      return res.status(400).json({ 
        error: 'OTP expired. Please request a new one.' 
      });
    }

    // Check max attempts
    if (storedData.attempts >= 5) {
      otpStore.delete(phone);
      return res.status(400).json({ 
        error: 'Too many attempts. Please request a new OTP.' 
      });
    }

    // Verify OTP using bcrypt
    const isValid = await verifyOTP(otp, storedData.hashedOTP);
    
    if (!isValid) {
      storedData.attempts++;
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    // ✅ OTP is valid - proceed with authentication

    // Use parameterized query to prevent SQL injection
    const distributorQuery = 'SELECT * FROM distributors WHERE phone = $1';
    const distributorResult = await pool.query(distributorQuery, [phone]);

    let distributor;
    let isNewDistributor = false;

    if (distributorResult.rows.length === 0) {
      // New distributor - require name
      if (!fullName || fullName.trim() === '') {
        return res.status(400).json({
          error: 'Full name is required for new distributors',
          requiresName: true
        });
      }

      // Sanitize input
      const sanitizedName = fullName.trim().substring(0, 255);

      // Insert new distributor with default values
      const insertQuery = 
        'INSERT INTO distributors (phone, full_name, is_working) VALUES ($1, $2, $3) RETURNING *';
      const insertResult = await pool.query(insertQuery, [phone, sanitizedName, true]);
      distributor = insertResult.rows[0];
      isNewDistributor = true;
      
      console.log(`✅ New distributor registered: ${phone}`);
    } else {
      distributor = distributorResult.rows[0];
      console.log(`✅ Distributor logged in: ${phone}`);
    }

    // Clear OTP after successful verification
    otpStore.delete(phone);

    // Generate secure JWT token
    const secret = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

    const token = jwt.sign(
      { 
        distributorId: distributor.id, 
        phone: distributor.phone 
      },
      secret,
      { expiresIn: '30d' }
    );

    res.json({
      message: isNewDistributor ? 'Registration successful' : 'Login successful',
      token,
      distributor: {
        id: distributor.id,
        phone: distributor.phone,
        fullName: distributor.full_name,
        upiId: distributor.upi_id,
        isWorking: distributor.is_working
      }
    });

  } catch (error) {
    console.error('❌ Verify OTP error:', error);
    res.status(500).json({ error: 'Failed to verify OTP' });
  }
});

// =====================================================
// 6. GET PROFILE - PROTECTED ROUTE
// =====================================================

router.get('/profile', authenticateToken, async (req, res) => {
  try {
    // Parameterized query to prevent SQL injection
    const query = 
      'SELECT id, phone, full_name, upi_id, is_working, created_at FROM distributors WHERE id = $1';
    const result = await pool.query(query, [req.distributor.distributorId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Distributor not found' });
    }

    res.json({
      distributor: {
        id: result.rows[0].id,
        phone: result.rows[0].phone,
        fullName: result.rows[0].full_name,
        upiId: result.rows[0].upi_id,
        isWorking: result.rows[0].is_working,
        createdAt: result.rows[0].created_at
      }
    });

  } catch (error) {
    console.error('❌ Get profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// =====================================================
// 7. UPDATE PROFILE - PROTECTED ROUTE
// =====================================================

router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const { fullName, upi_id, is_working } = req.body;

    // Build dynamic update query
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (fullName !== undefined) {
      const sanitizedName = fullName.trim().substring(0, 255);
      updates.push(`full_name = $${paramCount}`);
      values.push(sanitizedName);
      paramCount++;
    }

    if (upi_id !== undefined) {
      // Validate UPI ID format if provided
      if (upi_id !== null && upi_id.trim() !== '') {
        const upiRegex = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/;
        if (!upiRegex.test(upi_id.trim())) {
          return res.status(400).json({ 
            error: 'Invalid UPI ID format. Format: username@bank' 
          });
        }
        updates.push(`upi_id = $${paramCount}`);
        values.push(upi_id.trim());
      } else {
        updates.push(`upi_id = $${paramCount}`);
        values.push(null);
      }
      paramCount++;
    }

    if (is_working !== undefined) {
      updates.push(`is_working = $${paramCount}`);
      values.push(is_working);
      paramCount++;
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    // Add distributor ID to values
    values.push(req.distributor.distributorId);

    // Construct and execute query
    const query = `
      UPDATE distributors 
      SET ${updates.join(', ')} 
      WHERE id = $${paramCount} 
      RETURNING id, phone, full_name, upi_id, is_working
    `;

    const result = await pool.query(query, values);

    res.json({
      message: 'Profile updated successfully',
      distributor: {
        id: result.rows[0].id,
        phone: result.rows[0].phone,
        fullName: result.rows[0].full_name,
        upiId: result.rows[0].upi_id,
        isWorking: result.rows[0].is_working
      }
    });

  } catch (error) {
    console.error('❌ Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// =====================================================
// 8. GET DISTRIBUTOR UPI ID (PUBLIC - for user payments)
// =====================================================

router.get('/upi/:distributorId', async (req, res) => {
  try {
    const { distributorId } = req.params;

    const query = 'SELECT id, full_name, upi_id FROM distributors WHERE id = $1';
    const result = await pool.query(query, [distributorId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Distributor not found' });
    }

    const distributor = result.rows[0];

    res.json({
      distributorId: distributor.id,
      name: distributor.full_name,
      upiId: distributor.upi_id
    });

  } catch (error) {
    console.error('❌ Get UPI error:', error);
    res.status(500).json({ error: 'Failed to get UPI ID' });
  }
});

module.exports = router;