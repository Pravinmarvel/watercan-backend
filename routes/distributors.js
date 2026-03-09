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
// HELPER: Calculate distance between two coordinates (Haversine formula)
// =====================================================
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // Distance in meters
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
        isWorking: distributor.is_working,
        currentLatitude: distributor.current_latitude,
        currentLongitude: distributor.current_longitude
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
      'SELECT id, phone, full_name, upi_id, is_working, current_latitude, current_longitude, created_at FROM distributors WHERE id = $1';
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
        currentLatitude: result.rows[0].current_latitude,
        currentLongitude: result.rows[0].current_longitude,
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
      const sanitizedUpi = upi_id.trim().substring(0, 100);
      updates.push(`upi_id = $${paramCount}`);
      values.push(sanitizedUpi);
      paramCount++;
    }

    if (is_working !== undefined) {
      updates.push(`is_working = $${paramCount}`);
      values.push(is_working);
      paramCount++;
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(distributorId);

    const query = `
      UPDATE distributors 
      SET ${updates.join(', ')} 
      WHERE id = $${paramCount} 
      RETURNING id, phone, full_name, upi_id, is_working, current_latitude, current_longitude
    `;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Distributor not found' });
    }

    console.log(`✅ Profile updated for distributor ${distributorId}`);

    res.json({
      message: 'Profile updated successfully',
      distributor: {
        id: result.rows[0].id,
        phone: result.rows[0].phone,
        fullName: result.rows[0].full_name,
        upiId: result.rows[0].upi_id,
        isWorking: result.rows[0].is_working,
        currentLatitude: result.rows[0].current_latitude,
        currentLongitude: result.rows[0].current_longitude
      }
    });

  } catch (error) {
    console.error('❌ Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// =====================================================
// LOCATION TRACKING ENDPOINTS - NEW
// =====================================================

// Update distributor's current location
router.post('/update-location', authenticateToken, async (req, res) => {
  try {
    if (!req.distributor || !req.distributor.distributorId) {
      return res.status(401).json({ error: 'Invalid authentication' });
    }

    const distributorId = req.distributor.distributorId;
    const { latitude, longitude } = req.body;

    // Validate coordinates
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      return res.status(400).json({ error: 'Valid latitude and longitude required' });
    }

    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: 'Invalid coordinate values' });
    }

    console.log(`📍 Updating location for distributor ${distributorId}: ${latitude}, ${longitude}`);

    // Update distributor's location
    const updateQuery = `
      UPDATE distributors 
      SET current_latitude = $1, current_longitude = $2, location_updated_at = NOW()
      WHERE id = $3
      RETURNING id, current_latitude, current_longitude
    `;

    const updateResult = await pool.query(updateQuery, [latitude, longitude, distributorId]);

    if (updateResult.rows.length === 0) {
      return res.status(404).json({ error: 'Distributor not found' });
    }

    // Get all apartments managed by this distributor
    const apartmentsQuery = `
      SELECT id FROM apartment_groups WHERE distributor_id = $1
    `;
    const apartmentsResult = await pool.query(apartmentsQuery, [distributorId]);
    const apartmentIds = apartmentsResult.rows.map(row => row.id);

    if (apartmentIds.length === 0) {
      return res.json({
        message: 'Location updated',
        nearbyUsers: []
      });
    }

    // Get all users in these apartments with their addresses
    const usersQuery = `
      SELECT u.id, u.full_name, u.apartment_id, a.latitude, a.longitude
      FROM users u
      JOIN addresses a ON a.user_id = u.id
      WHERE u.apartment_id = ANY($1) AND a.latitude IS NOT NULL AND a.longitude IS NOT NULL
    `;
    const usersResult = await pool.query(usersQuery, [apartmentIds]);

    // Check proximity (100m radius) and update their can status
    const nearbyUsers = [];
    const PROXIMITY_RADIUS = 100; // meters

    for (const user of usersResult.rows) {
      const distance = calculateDistance(
        latitude, 
        longitude, 
        user.latitude, 
        user.longitude
      );

      if (distance <= PROXIMITY_RADIUS) {
        nearbyUsers.push({
          userId: user.id,
          userName: user.full_name,
          distance: Math.round(distance),
          latitude: user.latitude,
          longitude: user.longitude
        });

        // Update can status to "out for delivery" (is_working = 'out for delivery')
        // We'll add a new column or use existing is_working field
        console.log(`🚚 Distributor within ${Math.round(distance)}m of user ${user.id}`);
      }
    }

    console.log(`✅ Location updated. Found ${nearbyUsers.length} nearby users`);

    res.json({
      message: 'Location updated successfully',
      location: {
        latitude: updateResult.rows[0].current_latitude,
        longitude: updateResult.rows[0].current_longitude
      },
      nearbyUsers: nearbyUsers
    });

  } catch (error) {
    console.error('❌ Update location error:', error);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

// Get distributor's current location
router.get('/location', authenticateToken, async (req, res) => {
  try {
    if (!req.distributor || !req.distributor.distributorId) {
      return res.status(401).json({ error: 'Invalid authentication' });
    }

    const distributorId = req.distributor.distributorId;

    const query = `
      SELECT current_latitude, current_longitude, location_updated_at 
      FROM distributors 
      WHERE id = $1
    `;

    const result = await pool.query(query, [distributorId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Distributor not found' });
    }

    res.json({
      location: {
        latitude: result.rows[0].current_latitude,
        longitude: result.rows[0].current_longitude,
        updatedAt: result.rows[0].location_updated_at
      }
    });

  } catch (error) {
    console.error('❌ Get location error:', error);
    res.status(500).json({ error: 'Failed to get location' });
  }
});

// Check if distributor is near a specific user (for user app)
router.get('/near-user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    // Get user's address
    const userQuery = `
      SELECT u.apartment_id, a.latitude, a.longitude
      FROM users u
      JOIN addresses a ON a.user_id = u.id
      WHERE u.id = $1 AND a.latitude IS NOT NULL AND a.longitude IS NOT NULL
      LIMIT 1
    `;
    const userResult = await pool.query(userQuery, [userId]);

    if (userResult.rows.length === 0) {
      return res.json({ 
        isNearby: false, 
        message: 'User address not found' 
      });
    }

    const { apartment_id, latitude: userLat, longitude: userLon } = userResult.rows[0];

    // Get distributor for this apartment
    const distributorQuery = `
      SELECT d.id, d.full_name, d.current_latitude, d.current_longitude, d.location_updated_at
      FROM distributors d
      JOIN apartment_groups ag ON ag.distributor_id = d.id
      WHERE ag.id = $1 AND d.current_latitude IS NOT NULL AND d.current_longitude IS NOT NULL
    `;
    const distributorResult = await pool.query(distributorQuery, [apartment_id]);

    if (distributorResult.rows.length === 0) {
      return res.json({ 
        isNearby: false, 
        message: 'Distributor location not available' 
      });
    }

    const distributor = distributorResult.rows[0];
    const distance = calculateDistance(
      distributor.current_latitude,
      distributor.current_longitude,
      userLat,
      userLon
    );

    const PROXIMITY_RADIUS = 100; // meters
    const isNearby = distance <= PROXIMITY_RADIUS;

    res.json({
      isNearby: isNearby,
      distance: Math.round(distance),
      distributorName: distributor.full_name,
      message: isNearby 
        ? `Distributor is ${Math.round(distance)}m away - Out for delivery!` 
        : `Distributor is ${Math.round(distance)}m away`
    });

  } catch (error) {
    console.error('❌ Check proximity error:', error);
    res.status(500).json({ error: 'Failed to check proximity' });
  }
});

// =====================================================
// EXISTING ENDPOINTS (CONTINUED)
// =====================================================

router.get('/status/:distributorId', async (req, res) => {
  try {
    const { distributorId } = req.params;

    const query = 'SELECT id, full_name, is_working FROM distributors WHERE id = $1';
    const result = await pool.query(query, [distributorId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Distributor not found' });
    }

    res.json({
      distributorId: result.rows[0].id,
      name: result.rows[0].full_name,
      isWorking: result.rows[0].is_working
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

module.exports = router;