const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many OTP requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many verification attempts. Please try again later.' },
});

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

setInterval(() => {
  const now = Date.now();
  for (const [phone, data] of otpStore.entries()) {
    if (now > data.expiresAt) {
      otpStore.delete(phone);
    }
  }
}, 5 * 60 * 1000);

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  const secret = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
  
  jwt.verify(token, secret, (err, distributor) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.distributor = distributor;
    next();
  });
}

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

    if (Date.now() > storedData.expiresAt) {
      otpStore.delete(phone);
      return res.status(400).json({ 
        error: 'OTP expired. Please request a new one.' 
      });
    }

    if (storedData.attempts >= 5) {
      otpStore.delete(phone);
      return res.status(400).json({ 
        error: 'Too many attempts. Please request a new OTP.' 
      });
    }

    const isValid = await verifyOTP(otp, storedData.hashedOTP);
    
    if (!isValid) {
      storedData.attempts++;
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    const distributorQuery = 'SELECT * FROM distributors WHERE phone = $1';
    const distributorResult = await pool.query(distributorQuery, [phone]);

    let distributor;
    let isNewDistributor = false;

    if (distributorResult.rows.length === 0) {
      if (!fullName || fullName.trim() === '') {
        return res.status(400).json({
          error: 'Full name is required for new distributors',
          requiresName: true
        });
      }

      const sanitizedName = fullName.trim().substring(0, 255);

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

    otpStore.delete(phone);

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

router.get('/profile', authenticateToken, async (req, res) => {
  try {
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

router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const { fullName, upi_id, is_working } = req.body;

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

    values.push(req.distributor.distributorId);

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

// ✅ CRITICAL: Create apartment with distributor info
router.post('/apartments', authenticateToken, async (req, res) => {
  try {
    const { name, location, price_per_can, join_code } = req.body;
    const distributorId = req.distributor.distributorId;

    if (!name || !location || !price_per_can || !join_code) {
      return res.status(400).json({ 
        error: 'Name, location, price per can, and join code are required' 
      });
    }

    if (!/^\d{4}$/.test(join_code)) {
      return res.status(400).json({ 
        error: 'Join code must be exactly 4 digits' 
      });
    }

    // Check duplicate code
    const codeCheck = await pool.query(
      'SELECT id FROM apartment_groups WHERE join_code = $1',
      [join_code]
    );
    if (codeCheck.rows.length > 0) {
      return res.status(400).json({ 
        error: 'This join code is already in use. Please use a different code.' 
      });
    }

    // Get distributor info
    const distributorQuery = await pool.query(
      'SELECT full_name, upi_id FROM distributors WHERE id = $1',
      [distributorId]
    );
    if (distributorQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Distributor not found' });
    }

    const { full_name, upi_id } = distributorQuery.rows[0];

    // Insert with distributor info
    const result = await pool.query(`
      INSERT INTO apartment_groups (
        name, location, price_per_can, join_code, 
        distributor_id, distributor_name, distributor_upi_id
      ) 
      VALUES ($1, $2, $3, $4, $5, $6, $7) 
      RETURNING *
    `, [name.trim(), location.trim(), price_per_can, join_code, distributorId, full_name, upi_id]);

    console.log(`✅ Apartment created by ${full_name} (ID: ${distributorId})`);
    console.log(`   UPI: ${upi_id || 'Not set'}`);
    console.log(`   Code: ${join_code}`);

    res.status(201).json({
      message: 'Apartment created successfully',
      apartment: result.rows[0]
    });
  } catch (error) {
    console.error('❌ Create apartment error:', error);
    res.status(500).json({ error: 'Failed to create apartment' });
  }
});

module.exports = router;