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

// =====================================================
// AUTHENTICATION MIDDLEWARE
// =====================================================
function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  const secret = process.env.JWT_SECRET;
  
  jwt.verify(token, secret, (err, distributor) => {
    if (err) {
      console.error('❌ Token verification failed:', err.message);
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.distributor = distributor;
    next();
  });
}

// =====================================================
// OTP ENDPOINTS
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

    if (process.env.NODE_ENV === 'development') console.log(`📱 OTP generated for ${phone}`);

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

    const secret = process.env.JWT_SECRET;

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
// PROFILE ENDPOINTS
// =====================================================

router.get('/profile', authenticateToken, async (req, res) => {
  try {
    if (!req.distributor || !req.distributor.distributorId) {
      console.error('❌ Distributor object missing or invalid:', req.distributor);
      return res.status(401).json({ error: 'Invalid authentication. Please log in again.' });
    }

    const distributorId = req.distributor.distributorId;
    console.log(`📤 Getting profile for distributor ${distributorId}`);
    
    const query = 
      'SELECT id, phone, full_name, upi_id, is_working, created_at FROM distributors WHERE id = $1';
    const result = await pool.query(query, [distributorId]);

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
    if (!req.distributor || !req.distributor.distributorId) {
      console.error('❌ Distributor object missing or invalid:', req.distributor);
      return res.status(401).json({ error: 'Invalid authentication. Please log in again.' });
    }

    const distributorId = req.distributor.distributorId;
    const { fullName, upi_id, is_working } = req.body;

    console.log(`📤 Updating profile for distributor ${distributorId}`);

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
      
      console.log(`🔄 Distributor ${distributorId} working status changed to: ${is_working ? 'Working' : 'Holiday'}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(distributorId);

    const query = `
      UPDATE distributors 
      SET ${updates.join(', ')} 
      WHERE id = $${paramCount} 
      RETURNING id, phone, full_name, upi_id, is_working
    `;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Distributor not found' });
    }

    console.log(`✅ Profile updated: Working status is now ${result.rows[0].is_working ? 'Working' : 'Holiday'}`);

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
// PUBLIC ENDPOINTS
// =====================================================

router.get('/:distributorId/status', async (req, res) => {
  try {
    const { distributorId } = req.params;

    console.log(`📤 Getting working status for distributor ${distributorId}`);

    const query = 'SELECT id, full_name, is_working FROM distributors WHERE id = $1';
    const result = await pool.query(query, [distributorId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Distributor not found' });
    }

    const distributor = result.rows[0];

    console.log(`✅ Distributor status: ${distributor.is_working ? 'Working' : 'Holiday'}`);

    res.json({
      distributorId: distributor.id,
      name: distributor.full_name,
      isWorking: distributor.is_working
    });

  } catch (error) {
    console.error('❌ Get distributor status error:', error);
    res.status(500).json({ error: 'Failed to get distributor status' });
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

// =====================================================
// APARTMENT CREATION
// =====================================================

router.post('/apartments', authenticateToken, async (req, res) => {
  try {
    if (!req.distributor || !req.distributor.distributorId) {
      console.error('❌ Distributor object missing or invalid:', req.distributor);
      return res.status(401).json({ error: 'Invalid authentication. Please log in again.' });
    }

    const distributorId = req.distributor.distributorId;
    const { name, location, price_per_can, join_code } = req.body;

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

    const codeCheck = await pool.query(
      'SELECT id FROM apartment_groups WHERE join_code = $1',
      [join_code]
    );
    if (codeCheck.rows.length > 0) {
      return res.status(400).json({ 
        error: 'This join code is already in use. Please use a different code.' 
      });
    }

    const distributorQuery = await pool.query(
      'SELECT full_name, upi_id FROM distributors WHERE id = $1',
      [distributorId]
    );
    if (distributorQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Distributor not found' });
    }

    const { full_name, upi_id } = distributorQuery.rows[0];

    const result = await pool.query(`
      INSERT INTO apartment_groups (
        name, location, price_per_can, join_code, 
        distributor_id, distributor_name, distributor_upi_id
      ) 
      VALUES ($1, $2, $3, $4, $5, $6, $7) 
      RETURNING *
    `, [name.trim(), location.trim(), price_per_can, join_code, distributorId, full_name, upi_id]);

    console.log(`✅ Apartment created by ${full_name} (ID: ${distributorId})`);

    res.status(201).json({
      message: 'Apartment created successfully',
      apartment: result.rows[0]
    });
  } catch (error) {
    console.error('❌ Create apartment error:', error);
    res.status(500).json({ error: 'Failed to create apartment' });
  }
});

// =====================================================
// WORKING SCHEDULE ROUTES
// =====================================================

router.put('/schedule', authenticateToken, async (req, res) => {
  try {
    if (!req.distributor || !req.distributor.distributorId) {
      return res.status(401).json({ error: 'Invalid authentication' });
    }

    const distributorId = req.distributor.distributorId;
    const { working_schedule } = req.body;

    console.log(`📅 Updating schedule for distributor ${distributorId}`);

    if (typeof working_schedule !== 'object') {
      return res.status(400).json({ error: 'Invalid schedule format' });
    }

    const query = `
      UPDATE distributors 
      SET working_schedule = $1 
      WHERE id = $2 
      RETURNING id, full_name, is_working, working_schedule
    `;

    const result = await pool.query(query, [
      JSON.stringify(working_schedule),
      distributorId
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Distributor not found' });
    }

    console.log(`✅ Schedule updated for distributor ${distributorId}`);

    res.json({
      message: 'Schedule updated successfully',
      distributor: {
        id: result.rows[0].id,
        fullName: result.rows[0].full_name,
        isWorking: result.rows[0].is_working,
        workingSchedule: result.rows[0].working_schedule
      }
    });

  } catch (error) {
    console.error('❌ Update schedule error:', error);
    res.status(500).json({ error: 'Failed to update schedule' });
  }
});

router.get('/schedule', authenticateToken, async (req, res) => {
  try {
    if (!req.distributor || !req.distributor.distributorId) {
      return res.status(401).json({ error: 'Invalid authentication' });
    }

    const distributorId = req.distributor.distributorId;

    const query = `
      SELECT id, full_name, working_schedule 
      FROM distributors 
      WHERE id = $1
    `;

    const result = await pool.query(query, [distributorId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Distributor not found' });
    }

    res.json({
      schedule: result.rows[0].working_schedule || {}
    });

  } catch (error) {
    console.error('❌ Get schedule error:', error);
    res.status(500).json({ error: 'Failed to get schedule' });
  }
});

router.get('/is-working-now', authenticateToken, async (req, res) => {
  try {
    if (!req.distributor || !req.distributor.distributorId) {
      return res.status(401).json({ error: 'Invalid authentication' });
    }

    const distributorId = req.distributor.distributorId;

    const query = `
      SELECT id, full_name, is_working, working_schedule 
      FROM distributors 
      WHERE id = $1
    `;

    const result = await pool.query(query, [distributorId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Distributor not found' });
    }

    const distributor = result.rows[0];
    
    if (!distributor.is_working) {
      return res.json({
        isWorking: false,
        status: 'holiday',
        message: 'Distributor is on holiday'
      });
    }

    const now = new Date();
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const currentDay = days[now.getDay()];
    const currentTime = now.toLocaleTimeString('en-IN', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: false,
      timeZone: 'Asia/Kolkata'
    });

    const schedule = distributor.working_schedule || {};
    const daySchedule = schedule[currentDay];

    if (!daySchedule) {
      return res.json({
        isWorking: true,
        status: 'working',
        message: 'No schedule set - default working'
      });
    }

    if (daySchedule.isHoliday) {
      return res.json({
        isWorking: false,
        status: 'holiday',
        message: 'Holiday today'
      });
    }

    if (daySchedule.start && daySchedule.end) {
      const isWithinHours = currentTime >= daySchedule.start && currentTime <= daySchedule.end;
      
      return res.json({
        isWorking: isWithinHours,
        status: isWithinHours ? 'working' : 'offline',
        message: isWithinHours 
          ? `Working (${daySchedule.start} - ${daySchedule.end})`
          : `Offline (Working hours: ${daySchedule.start} - ${daySchedule.end})`
      });
    }

    res.json({
      isWorking: true,
      status: 'working',
      message: 'Working'
    });

  } catch (error) {
    console.error('❌ Check working status error:', error);
    res.status(500).json({ error: 'Failed to check working status' });
  }
});

// =====================================================
// LOCATION TRACKING ROUTES
// =====================================================

// PUT /api/distributors/location - Update distributor's current location
router.put('/location', authenticateToken, async (req, res) => {
  try {
    if (!req.distributor || !req.distributor.distributorId) {
      return res.status(401).json({ error: 'Invalid authentication' });
    }

    const distributorId = req.distributor.distributorId;
    const { latitude, longitude, timestamp } = req.body;

    // Validate coordinates
    if (!latitude || !longitude) {
      return res.status(400).json({ error: 'Latitude and longitude are required' });
    }

    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      return res.status(400).json({ error: 'Invalid coordinates format' });
    }

    // Validate coordinate ranges
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: 'Invalid coordinate values' });
    }

    if (process.env.NODE_ENV === 'development') {
      console.log(`📍 Updating location for distributor ${distributorId}: ${latitude}, ${longitude}`);
    }

    // Update distributor location in database
    const query = `
      UPDATE distributors 
      SET 
        current_latitude = $1,
        current_longitude = $2,
        location_updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING id, full_name, current_latitude, current_longitude, location_updated_at
    `;

    const result = await pool.query(query, [latitude, longitude, distributorId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Distributor not found' });
    }

    if (process.env.NODE_ENV === 'development') {
      console.log(`✅ Location updated for distributor ${distributorId}`);
    }

    res.json({
      message: 'Location updated successfully',
      location: {
        latitude: result.rows[0].current_latitude,
        longitude: result.rows[0].current_longitude,
        updatedAt: result.rows[0].location_updated_at
      }
    });

  } catch (error) {
    console.error('❌ Update location error:', error);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

// GET /api/distributors/:distributorId/location - Get distributor's current location
router.get('/:distributorId/location', async (req, res) => {
  try {
    const { distributorId } = req.params;

    if (process.env.NODE_ENV === 'development') {
      console.log(`📍 Getting location for distributor ${distributorId}`);
    }

    const query = `
      SELECT 
        id,
        full_name,
        current_latitude,
        current_longitude,
        location_updated_at,
        is_working
      FROM distributors
      WHERE id = $1
    `;

    const result = await pool.query(query, [distributorId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Distributor not found' });
    }

    const distributor = result.rows[0];

    // Check if location data exists
    if (!distributor.current_latitude || !distributor.current_longitude) {
      return res.json({
        message: 'No location data available',
        location: null
      });
    }

    // Check if location is stale (older than 5 minutes)
    const locationAge = new Date() - new Date(distributor.location_updated_at);
    const isStale = locationAge > 5 * 60 * 1000; // 5 minutes

    if (process.env.NODE_ENV === 'development') {
      console.log(`✅ Location found for distributor ${distributorId} (${isStale ? 'STALE' : 'FRESH'})`);
    }

    res.json({
      location: {
        latitude: parseFloat(distributor.current_latitude),
        longitude: parseFloat(distributor.current_longitude),
        last_update: distributor.location_updated_at,
        is_stale: isStale,
        age_minutes: Math.floor(locationAge / 60000)
      },
      distributor: {
        id: distributor.id,
        name: distributor.full_name,
        is_working: distributor.is_working
      }
    });

  } catch (error) {
    console.error('❌ Get location error:', error);
    res.status(500).json({ error: 'Failed to get location' });
  }
});

// GET /api/distributors/nearby/:latitude/:longitude - Find nearby distributors
router.get('/nearby/:latitude/:longitude', async (req, res) => {
  try {
    const { latitude, longitude } = req.params;
    const radius = req.query.radius || 5000; // Default 5km radius

    if (process.env.NODE_ENV === 'development') {
      console.log(`📍 Finding distributors near ${latitude}, ${longitude} within ${radius}m`);
    }

    // Using Haversine formula for distance calculation
    const query = `
      SELECT 
        id,
        full_name,
        current_latitude,
        current_longitude,
        location_updated_at,
        is_working,
        (
          6371000 * acos(
            cos(radians($1)) * cos(radians(current_latitude)) * 
            cos(radians(current_longitude) - radians($2)) + 
            sin(radians($1)) * sin(radians(current_latitude))
          )
        ) AS distance
      FROM distributors
      WHERE 
        current_latitude IS NOT NULL 
        AND current_longitude IS NOT NULL
        AND location_updated_at > NOW() - INTERVAL '5 minutes'
        AND is_working = true
      HAVING distance < $3
      ORDER BY distance ASC
      LIMIT 10
    `;

    const result = await pool.query(query, [latitude, longitude, radius]);

    res.json({
      count: result.rows.length,
      distributors: result.rows.map(row => ({
        id: row.id,
        name: row.full_name,
        distance: Math.round(row.distance),
        location: {
          latitude: parseFloat(row.current_latitude),
          longitude: parseFloat(row.current_longitude),
          last_update: row.location_updated_at
        }
      }))
    });

  } catch (error) {
    console.error('❌ Find nearby distributors error:', error);
    res.status(500).json({ error: 'Failed to find nearby distributors' });
  }
});

module.exports = router;