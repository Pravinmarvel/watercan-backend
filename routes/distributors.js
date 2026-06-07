const express = require('express');
const router  = express.Router();
const { pool } = require('../db');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcrypt');
const rateLimit = require('express-rate-limit');
const admin   = require('firebase-admin');

// ── Rate limiters ──────────────────────────────────
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  message: { error: 'Too many OTP requests. Please try again later.' },
  standardHeaders: true, legacyHeaders: false,
});
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Too many verification attempts. Please try again later.' },
});
const googleAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { error: 'Too many login attempts. Please try again later.' },
});

// ── OTP helpers ────────────────────────────────────
const otpStore = new Map();
function generateOTP() { return Math.floor(100000 + Math.random() * 900000).toString(); }
async function hashOTP(otp) { return await bcrypt.hash(otp, 10); }
async function verifyOTP(plain, hashed) { return await bcrypt.compare(plain, hashed); }
setInterval(() => {
  const now = Date.now();
  for (const [phone, data] of otpStore.entries()) {
    if (now > data.expiresAt) otpStore.delete(phone);
  }
}, 5 * 60 * 1000);

// ── Auth middleware ────────────────────────────────
function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  jwt.verify(token, process.env.JWT_SECRET, (err, distributor) => {
    if (err) {
      if (err.name === 'TokenExpiredError')
        return res.status(401).json({ error: 'Token expired. Please log in again.', code: 'TOKEN_EXPIRED' });
      console.error('❌ Token verification failed:', err.message);
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.distributor = distributor;
    next();
  });
}

// ── TOKEN REFRESH ──────────────────────────────────
router.post('/refresh-token', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token required' });
    let decoded;
    try { decoded = jwt.verify(token, process.env.JWT_SECRET); }
    catch (err) {
      if (err.name === 'TokenExpiredError') decoded = jwt.decode(token);
      else return res.status(403).json({ error: 'Invalid token' });
    }
    if (!decoded?.distributorId) return res.status(403).json({ error: 'Invalid token payload' });
    const result = await pool.query(
      'SELECT id, phone, full_name, upi_id, is_working FROM distributors WHERE id = $1',
      [decoded.distributorId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Distributor not found. Please log in again.' });
    const d = result.rows[0];
    const newToken = jwt.sign({ distributorId: d.id, phone: d.phone }, process.env.JWT_SECRET, { expiresIn: '30d' });
    console.log(`✅ Token refreshed for distributor ${d.id}`);
    res.json({ message: 'Token refreshed successfully', token: newToken,
      distributor: { id: d.id, phone: d.phone, fullName: d.full_name, upiId: d.upi_id, isWorking: d.is_working } });
  } catch (e) { console.error('❌ Refresh token error:', e); res.status(500).json({ error: 'Failed to refresh token' }); }
});

// ════════════════════════════════════════════════════
// ✅ NEW: GOOGLE SIGN-IN FOR DISTRIBUTORS
// ════════════════════════════════════════════════════
router.post('/google-signin', googleAuthLimiter, async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'ID token is required' });

    let decodedToken;
    try { decodedToken = await admin.auth().verifyIdToken(idToken); }
    catch (e) {
      console.error('❌ Firebase token error:', e.message);
      return res.status(401).json({ error: 'Invalid Google token. Please try again.' });
    }

    const { uid: googleUid, email, name: displayName } = decodedToken;
    if (!email) return res.status(400).json({ error: 'Google account must have an email address.' });

    console.log(`📤 Distributor Google sign-in: ${email}`);

    // Find existing distributor by email or google_uid
    const existing = await pool.query(
      'SELECT * FROM distributors WHERE email = $1 OR google_uid = $2',
      [email, googleUid]
    );

    if (existing.rows.length > 0) {
      const d = existing.rows[0];
      // Backfill google_uid if not set
      if (!d.google_uid) {
        await pool.query('UPDATE distributors SET google_uid = $1, email = $2 WHERE id = $3', [googleUid, email, d.id]);
      }
      const token = jwt.sign({ distributorId: d.id, phone: d.phone }, process.env.JWT_SECRET, { expiresIn: '30d' });
      console.log(`✅ Distributor Google login: ${email}`);
      return res.json({ message: 'Login successful', token,
        distributor: { id: d.id, phone: d.phone, fullName: d.full_name, email: d.email, upiId: d.upi_id, isWorking: d.is_working } });
    }

    // New distributor — needs phone + name to complete registration
    console.log(`ℹ️ New distributor Google account: ${email}`);
    return res.json({ requiresSetup: true, googleUid, email, displayName: displayName || '' });

  } catch (e) { console.error('❌ Distributor Google sign-in error:', e); res.status(500).json({ error: 'Sign-in failed. Please try again.' }); }
});

// ✅ NEW: COMPLETE GOOGLE REGISTRATION
router.post('/complete-google-registration', async (req, res) => {
  try {
    const { googleUid, email, fullName, phone } = req.body;
    if (!googleUid || !email || !fullName || !phone)
      return res.status(400).json({ error: 'googleUid, email, fullName, and phone are required' });
    if (!/^\d{10}$/.test(phone))
      return res.status(400).json({ error: 'Valid 10-digit phone number required' });

    const phoneCheck = await pool.query('SELECT id FROM distributors WHERE phone = $1', [phone]);
    if (phoneCheck.rows.length > 0) return res.status(400).json({ error: 'Phone number already registered' });

    const r = await pool.query(
      'INSERT INTO distributors (phone, full_name, email, google_uid, is_working) VALUES ($1, $2, $3, $4, true) RETURNING *',
      [phone, fullName.trim(), email, googleUid]
    );
    const d = r.rows[0];
    const token = jwt.sign({ distributorId: d.id, phone: d.phone }, process.env.JWT_SECRET, { expiresIn: '30d' });
    console.log(`✅ New distributor registered via Google: ${email}`);
    res.status(201).json({ message: 'Registration successful', token,
      distributor: { id: d.id, phone: d.phone, fullName: d.full_name, email: d.email, upiId: d.upi_id, isWorking: d.is_working } });
  } catch (e) { console.error('❌ Complete Google reg error:', e); res.status(500).json({ error: 'Registration failed. Please try again.' }); }
});

// ── OTP ENDPOINTS (kept as fallback) ──────────────
// ✅ SECURITY FIX: OTP is no longer returned in the response
router.post('/send-otp', otpLimiter, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || !/^\d{10}$/.test(phone))
      return res.status(400).json({ error: 'Valid 10-digit phone number required' });

    const otp = generateOTP();
    const hashedOTP = await hashOTP(otp);
    otpStore.set(phone, { hashedOTP, expiresAt: Date.now() + 10 * 60 * 1000, attempts: 0 });

    // Dev only — never log OTP in production
    if (process.env.NODE_ENV !== 'production') console.log(`📱 [DEV ONLY] OTP for ${phone}: ${otp}`);
    // TODO production: await sendSMS(phone, `Your WaterCan OTP: ${otp}. Valid 10 minutes.`);

    // ✅ FIXED: otp NOT returned in response
    res.json({ message: 'OTP sent successfully' });
  } catch (e) { console.error('❌ Send OTP error:', e); res.status(500).json({ error: 'Failed to send OTP' }); }
});

router.post('/verify-otp', verifyLimiter, async (req, res) => {
  try {
    const { phone, otp, fullName } = req.body;
    if (!phone || !otp) return res.status(400).json({ error: 'Phone and OTP are required' });
    if (!/^\d{10}$/.test(phone)) return res.status(400).json({ error: 'Invalid phone number format' });
    if (!/^\d{6}$/.test(otp)) return res.status(400).json({ error: 'Invalid OTP format' });

    const storedData = otpStore.get(phone);
    if (!storedData) return res.status(400).json({ error: 'No OTP found. Please request a new one.' });
    if (Date.now() > storedData.expiresAt) { otpStore.delete(phone); return res.status(400).json({ error: 'OTP expired. Please request a new one.' }); }
    if (storedData.attempts >= 5) { otpStore.delete(phone); return res.status(400).json({ error: 'Too many attempts. Please request a new OTP.' }); }

    const isValid = await verifyOTP(otp, storedData.hashedOTP);
    if (!isValid) { storedData.attempts++; return res.status(400).json({ error: 'Invalid OTP' }); }

    const distributorResult = await pool.query('SELECT * FROM distributors WHERE phone = $1', [phone]);
    let distributor; let isNew = false;

    if (!distributorResult.rows.length) {
      if (!fullName?.trim()) return res.status(400).json({ error: 'Full name is required for new distributors', requiresName: true });
      const ir = await pool.query('INSERT INTO distributors (phone, full_name, is_working) VALUES ($1, $2, true) RETURNING *', [phone, fullName.trim().substring(0, 255)]);
      distributor = ir.rows[0]; isNew = true;
      console.log(`✅ New distributor registered: ${phone}`);
    } else {
      distributor = distributorResult.rows[0];
      console.log(`✅ Distributor logged in: ${phone}`);
    }

    otpStore.delete(phone);
    const token = jwt.sign({ distributorId: distributor.id, phone: distributor.phone }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ message: isNew ? 'Registration successful' : 'Login successful', token,
      distributor: { id: distributor.id, phone: distributor.phone, fullName: distributor.full_name, upiId: distributor.upi_id, isWorking: distributor.is_working } });
  } catch (e) { console.error('❌ Verify OTP error:', e); res.status(500).json({ error: 'Failed to verify OTP' }); }
});

// ── PROFILE ────────────────────────────────────────
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    if (!req.distributor?.distributorId) return res.status(401).json({ error: 'Invalid authentication. Please log in again.' });
    const distributorId = req.distributor.distributorId;
    console.log(`📤 Getting profile for distributor ${distributorId}`);
    const result = await pool.query(
      'SELECT id, phone, full_name, upi_id, is_working, created_at, email FROM distributors WHERE id = $1',
      [distributorId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Distributor not found' });
    const d = result.rows[0];
    res.json({ distributor: { id: d.id, phone: d.phone, fullName: d.full_name, upiId: d.upi_id, isWorking: d.is_working, createdAt: d.created_at, email: d.email } });
  } catch (e) { console.error('❌ Get profile error:', e); res.status(500).json({ error: 'Failed to get profile' }); }
});

router.put('/profile', authenticateToken, async (req, res) => {
  try {
    if (!req.distributor?.distributorId) return res.status(401).json({ error: 'Invalid authentication. Please log in again.' });
    const distributorId = req.distributor.distributorId;
    const { fullName, upi_id, is_working } = req.body;
    console.log(`📤 Updating profile for distributor ${distributorId}`);

    const updates = []; const values = []; let p = 1;
    if (fullName !== undefined) { updates.push(`full_name = $${p++}`); values.push(fullName.trim().substring(0, 255)); }
    if (upi_id !== undefined) {
      if (upi_id !== null && upi_id.trim() !== '') {
        if (!/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/.test(upi_id.trim()))
          return res.status(400).json({ error: 'Invalid UPI ID format. Format: username@bank' });
        updates.push(`upi_id = $${p++}`); values.push(upi_id.trim());
      } else { updates.push(`upi_id = $${p++}`); values.push(null); }
    }
    if (is_working !== undefined) { updates.push(`is_working = $${p++}`); values.push(is_working); }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    values.push(distributorId);
    const result = await pool.query(`UPDATE distributors SET ${updates.join(', ')} WHERE id = $${p} RETURNING id, phone, full_name, upi_id, is_working`, values);
    if (!result.rows.length) return res.status(404).json({ error: 'Distributor not found' });
    const d = result.rows[0];
    res.json({ message: 'Profile updated successfully', distributor: { id: d.id, phone: d.phone, fullName: d.full_name, upiId: d.upi_id, isWorking: d.is_working } });
  } catch (e) { console.error('❌ Update profile error:', e); res.status(500).json({ error: 'Failed to update profile' }); }
});

// ── PUBLIC STATUS ──────────────────────────────────
router.get('/:distributorId/status', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, full_name, is_working FROM distributors WHERE id = $1', [req.params.distributorId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Distributor not found' });
    const d = result.rows[0];
    res.json({ distributorId: d.id, name: d.full_name, isWorking: d.is_working });
  } catch (e) { res.status(500).json({ error: 'Failed to get distributor status' }); }
});

router.get('/upi/:distributorId', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, full_name, upi_id FROM distributors WHERE id = $1', [req.params.distributorId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Distributor not found' });
    const d = result.rows[0];
    res.json({ distributorId: d.id, name: d.full_name, upiId: d.upi_id });
  } catch (e) { res.status(500).json({ error: 'Failed to get UPI ID' }); }
});

// ── APARTMENT CREATION ─────────────────────────────
router.post('/apartments', authenticateToken, async (req, res) => {
  try {
    if (!req.distributor?.distributorId) return res.status(401).json({ error: 'Invalid authentication. Please log in again.' });
    const distributorId = req.distributor.distributorId;
    const { name, location, price_per_can, join_code } = req.body;
    if (!name || !location || !price_per_can || !join_code)
      return res.status(400).json({ error: 'Name, location, price per can, and join code are required' });
    if (!/^\d{4}$/.test(join_code)) return res.status(400).json({ error: 'Join code must be exactly 4 digits' });
    const codeCheck = await pool.query('SELECT id FROM apartment_groups WHERE join_code = $1', [join_code]);
    if (codeCheck.rows.length > 0) return res.status(400).json({ error: 'This join code is already in use. Please use a different code.' });
    const dq = await pool.query('SELECT full_name, upi_id FROM distributors WHERE id = $1', [distributorId]);
    if (!dq.rows.length) return res.status(404).json({ error: 'Distributor not found' });
    const { full_name, upi_id } = dq.rows[0];
    const result = await pool.query(
      'INSERT INTO apartment_groups (name, location, price_per_can, join_code, distributor_id, distributor_name, distributor_upi_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [name.trim(), location.trim(), price_per_can, join_code, distributorId, full_name, upi_id]
    );
    console.log(`✅ Apartment created by distributor ${distributorId}`);
    res.status(201).json({ message: 'Apartment created successfully', apartment: result.rows[0] });
  } catch (e) { console.error('❌ Create apartment error:', e); res.status(500).json({ error: 'Failed to create apartment' }); }
});

// ── SCHEDULE ───────────────────────────────────────
router.put('/schedule', authenticateToken, async (req, res) => {
  try {
    if (!req.distributor?.distributorId) return res.status(401).json({ error: 'Invalid authentication' });
    const { working_schedule } = req.body;
    if (typeof working_schedule !== 'object') return res.status(400).json({ error: 'Invalid schedule format' });
    console.log(`📅 Updating schedule for distributor ${req.distributor.distributorId}`);
    const result = await pool.query(
      'UPDATE distributors SET working_schedule = $1 WHERE id = $2 RETURNING id, full_name, is_working, working_schedule',
      [JSON.stringify(working_schedule), req.distributor.distributorId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Distributor not found' });
    res.json({ message: 'Schedule updated successfully', distributor: { id: result.rows[0].id, fullName: result.rows[0].full_name, isWorking: result.rows[0].is_working, workingSchedule: result.rows[0].working_schedule } });
  } catch (e) { console.error('❌ Update schedule error:', e); res.status(500).json({ error: 'Failed to update schedule' }); }
});

router.get('/schedule', authenticateToken, async (req, res) => {
  try {
    if (!req.distributor?.distributorId) return res.status(401).json({ error: 'Invalid authentication' });
    const result = await pool.query('SELECT working_schedule FROM distributors WHERE id = $1', [req.distributor.distributorId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Distributor not found' });
    res.json({ schedule: result.rows[0].working_schedule || {} });
  } catch (e) { console.error('❌ Get schedule error:', e); res.status(500).json({ error: 'Failed to get schedule' }); }
});

router.get('/is-working-now', authenticateToken, async (req, res) => {
  try {
    if (!req.distributor?.distributorId) return res.status(401).json({ error: 'Invalid authentication' });
    const result = await pool.query('SELECT id, full_name, is_working, working_schedule FROM distributors WHERE id = $1', [req.distributor.distributorId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Distributor not found' });
    const distributor = result.rows[0];
    if (!distributor.is_working) return res.json({ isWorking: false, status: 'holiday', message: 'Distributor is on holiday' });
    const now = new Date();
    const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const currentDay = days[now.getDay()];
    const currentTime = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
    const schedule = distributor.working_schedule || {};
    const daySchedule = schedule[currentDay];
    if (!daySchedule) return res.json({ isWorking: true, status: 'working', message: 'No schedule set - default working' });
    if (daySchedule.isHoliday) return res.json({ isWorking: false, status: 'holiday', message: 'Holiday today' });
    if (daySchedule.start && daySchedule.end) {
      const within = currentTime >= daySchedule.start && currentTime <= daySchedule.end;
      return res.json({ isWorking: within, status: within ? 'working' : 'offline', message: within ? `Working (${daySchedule.start} - ${daySchedule.end})` : `Offline (Working hours: ${daySchedule.start} - ${daySchedule.end})` });
    }
    res.json({ isWorking: true, status: 'working', message: 'Working' });
  } catch (e) { console.error('❌ Check working status error:', e); res.status(500).json({ error: 'Failed to check working status' }); }
});

// ── WORKING STATUS (public) ────────────────────────
router.get('/:distributorId/working-status', async (req, res) => {
  try {
    const id = parseInt(req.params.distributorId);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid distributor ID' });
    const result = await pool.query('SELECT id, full_name, is_working, working_schedule FROM distributors WHERE id = $1', [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Distributor not found' });
    const distributor = result.rows[0];
    if (!distributor.is_working) return res.json({ isWorking: false, status: 'holiday', message: 'Distributor is on holiday' });
    const now = new Date();
    const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const currentDay = days[now.getDay()];
    const currentTime = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
    const schedule = distributor.working_schedule || {};
    const daySchedule = schedule[currentDay];
    if (!daySchedule) return res.json({ isWorking: true, status: 'working', message: 'Working' });
    if (daySchedule.isHoliday) return res.json({ isWorking: false, status: 'holiday', message: 'Holiday today' });
    if (daySchedule.start && daySchedule.end) {
      const within = currentTime >= daySchedule.start && currentTime <= daySchedule.end;
      return res.json({ isWorking: within, status: within ? 'working' : 'offline', message: within ? 'Working' : 'Offline', workingHours: `${daySchedule.start} - ${daySchedule.end}` });
    }
    return res.json({ isWorking: true, status: 'working', message: 'Working' });
  } catch (e) { res.status(500).json({ error: 'Failed to get working status' }); }
});

// ── LOCATION ───────────────────────────────────────
// ✅ Uses correct DB column names: current_latitude / current_longitude
router.put('/location', authenticateToken, async (req, res) => {
  try {
    if (!req.distributor?.distributorId) return res.status(401).json({ error: 'Invalid authentication' });
    const { latitude, longitude, timestamp } = req.body;
    if (latitude === undefined || longitude === undefined) return res.status(400).json({ error: 'Latitude and longitude are required' });
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return res.status(400).json({ error: 'Invalid coordinates format' });
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return res.status(400).json({ error: 'Invalid coordinate values' });
    if (process.env.NODE_ENV === 'development') console.log(`📍 Updating location for distributor ${req.distributor.distributorId}: ${latitude}, ${longitude}`);
    const result = await pool.query(
      'UPDATE distributors SET current_latitude = $1, current_longitude = $2, location_updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING id, full_name, current_latitude, current_longitude, location_updated_at',
      [latitude, longitude, req.distributor.distributorId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Distributor not found' });
    if (process.env.NODE_ENV === 'development') console.log(`✅ Location updated for distributor ${req.distributor.distributorId}`);
    res.json({ message: 'Location updated successfully', location: { latitude: result.rows[0].current_latitude, longitude: result.rows[0].current_longitude, updatedAt: result.rows[0].location_updated_at } });
  } catch (e) { console.error('❌ Update location error:', e); res.status(500).json({ error: 'Failed to update location' }); }
});

router.get('/:distributorId/location', async (req, res) => {
  try {
    if (process.env.NODE_ENV === 'development') console.log(`📍 Getting location for distributor ${req.params.distributorId}`);
    const result = await pool.query('SELECT id, full_name, current_latitude, current_longitude, location_updated_at, is_working FROM distributors WHERE id = $1', [req.params.distributorId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Distributor not found' });
    const d = result.rows[0];
    if (!d.current_latitude || !d.current_longitude) return res.json({ message: 'No location data available', location: null });
    const age = new Date() - new Date(d.location_updated_at);
    const isStale = age > 5 * 60 * 1000;
    if (process.env.NODE_ENV === 'development') console.log(`✅ Location found for distributor ${d.id} (${isStale ? 'STALE' : 'FRESH'})`);
    res.json({ location: { latitude: parseFloat(d.current_latitude), longitude: parseFloat(d.current_longitude), last_update: d.location_updated_at, is_stale: isStale, age_minutes: Math.floor(age / 60000) }, distributor: { id: d.id, name: d.full_name, is_working: d.is_working } });
  } catch (e) { console.error('❌ Get location error:', e); res.status(500).json({ error: 'Failed to get location' }); }
});

router.get('/nearby/:latitude/:longitude', async (req, res) => {
  try {
    const { latitude, longitude } = req.params;
    const radius = req.query.radius || 5000;
    if (process.env.NODE_ENV === 'development') console.log(`📍 Finding distributors near ${latitude}, ${longitude} within ${radius}m`);
    const result = await pool.query(`
      SELECT id, full_name, current_latitude, current_longitude, location_updated_at, is_working,
        (6371000 * acos(cos(radians($1)) * cos(radians(current_latitude)) * cos(radians(current_longitude) - radians($2)) + sin(radians($1)) * sin(radians(current_latitude)))) AS distance
      FROM distributors
      WHERE current_latitude IS NOT NULL AND current_longitude IS NOT NULL
        AND location_updated_at > NOW() - INTERVAL '5 minutes' AND is_working = true
      HAVING (6371000 * acos(cos(radians($1)) * cos(radians(current_latitude)) * cos(radians(current_longitude) - radians($2)) + sin(radians($1)) * sin(radians(current_latitude)))) < $3
      ORDER BY distance ASC LIMIT 10
    `, [latitude, longitude, radius]);
    res.json({ count: result.rows.length, distributors: result.rows.map(row => ({ id: row.id, name: row.full_name, distance: Math.round(row.distance), location: { latitude: parseFloat(row.current_latitude), longitude: parseFloat(row.current_longitude), last_update: row.location_updated_at } })) });
  } catch (e) { console.error('❌ Find nearby distributors error:', e); res.status(500).json({ error: 'Failed to find nearby distributors' }); }
});

// ── PUBLIC PROFILE ─────────────────────────────────
router.get('/:distributorId/public-profile', async (req, res) => {
  try {
    const id = parseInt(req.params.distributorId);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid distributor ID' });
    const distResult = await pool.query(`
      SELECT d.id, d.full_name, d.phone, d.upi_id, d.is_working, d.working_schedule, d.created_at,
        COALESCE((SELECT COUNT(*) FROM orders o JOIN users u ON o.user_id = u.id JOIN apartment_groups ag ON u.apartment_id = ag.id WHERE ag.distributor_id = d.id AND o.status IN ('delivered','paid','completed')), 0) AS total_deliveries,
        COALESCE((SELECT ROUND(AVG(rating)::numeric, 1) FROM distributor_ratings WHERE distributor_id = d.id), 0) AS avg_rating,
        COALESCE((SELECT COUNT(*) FROM distributor_ratings WHERE distributor_id = d.id), 0) AS rating_count
      FROM distributors d WHERE d.id = $1`, [id]);
    if (!distResult.rows.length) return res.status(404).json({ error: 'Distributor not found' });
    const d = distResult.rows[0];
    const reviewsResult = await pool.query(`SELECT dr.id, dr.rating, dr.comment, dr.created_at, u.full_name AS reviewer_name FROM distributor_ratings dr JOIN users u ON dr.user_id = u.id WHERE dr.distributor_id = $1 ORDER BY dr.created_at DESC LIMIT 20`, [id]);
    res.json({ success: true, distributor: { id: d.id, fullName: d.full_name, phone: d.phone, upiId: d.upi_id, isWorking: d.is_working, workingSchedule: d.working_schedule || {}, joinedAt: d.created_at, totalDeliveries: parseInt(d.total_deliveries), avgRating: parseFloat(d.avg_rating) || 0, ratingCount: parseInt(d.rating_count), reviews: reviewsResult.rows.map(r => ({ id: r.id, rating: r.rating, comment: r.comment, reviewerName: r.reviewer_name, createdAt: r.created_at })) } });
  } catch (e) { console.error('❌ Public profile error:', e); res.status(500).json({ error: 'Failed to get distributor profile' }); }
});

// ── RATE DISTRIBUTOR ───────────────────────────────
router.post('/:distributorId/rate', async (req, res) => {
  const token = (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  let decoded;
  try { decoded = jwt.verify(token, process.env.JWT_SECRET); } catch (e) { return res.status(403).json({ error: 'Invalid or expired token' }); }
  const userId = decoded.userId;
  if (!userId) return res.status(403).json({ error: 'User token required' });
  try {
    const id = parseInt(req.params.distributorId);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid distributor ID' });
    const { rating, comment } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    const memberCheck = await pool.query('SELECT u.id FROM users u JOIN apartment_groups ag ON u.apartment_id = ag.id WHERE u.id = $1 AND ag.distributor_id = $2', [userId, id]);
    if (!memberCheck.rows.length) return res.status(403).json({ error: 'You can only rate your own distributor' });
    const result = await pool.query(`INSERT INTO distributor_ratings (distributor_id, user_id, rating, comment, created_at, updated_at) VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT (distributor_id, user_id) DO UPDATE SET rating=EXCLUDED.rating, comment=EXCLUDED.comment, updated_at=CURRENT_TIMESTAMP RETURNING *`, [id, userId, Math.round(rating), comment ? comment.trim() : null]);
    const avgResult = await pool.query('SELECT ROUND(AVG(rating)::numeric,1) as avg_rating, COUNT(*) as count FROM distributor_ratings WHERE distributor_id = $1', [id]);
    console.log(`✅ Rating saved: user ${userId} rated distributor ${id} → ${rating}/5`);
    res.status(201).json({ message: 'Rating submitted successfully', rating: result.rows[0], newAverage: parseFloat(avgResult.rows[0].avg_rating) || 0, totalRatings: parseInt(avgResult.rows[0].count) });
  } catch (e) { console.error('❌ Rate distributor error:', e); res.status(500).json({ error: 'Failed to submit rating' }); }
});

router.get('/:distributorId/my-rating', async (req, res) => {
  const token = (req.headers.authorization || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  let decoded;
  try { decoded = jwt.verify(token, process.env.JWT_SECRET); } catch (e) { return res.status(403).json({ error: 'Invalid or expired token' }); }
  const userId = decoded.userId;
  if (!userId) return res.status(403).json({ error: 'User token required' });
  try {
    const result = await pool.query('SELECT rating, comment, updated_at FROM distributor_ratings WHERE distributor_id = $1 AND user_id = $2', [parseInt(req.params.distributorId), userId]);
    if (!result.rows.length) return res.json({ hasRated: false });
    res.json({ hasRated: true, rating: result.rows[0].rating, comment: result.rows[0].comment, updatedAt: result.rows[0].updated_at });
  } catch (e) { console.error('❌ Get my rating error:', e); res.status(500).json({ error: 'Failed to get rating' }); }
});

// ════════════════════════════════════════════════════
// ✅ NEW: DISTRIBUTOR CONFIRMS PAYMENT RECEIVED
// ════════════════════════════════════════════════════
router.post('/confirm-payment', authenticateToken, async (req, res) => {
  try {
    const distributorId = req.distributor.distributorId;
    const { userId, amount } = req.body;
    if (!userId || !amount) return res.status(400).json({ error: 'userId and amount are required' });

    // Find the most recent pending/payment_pending order for this user in distributor's apartments
    const orderResult = await pool.query(
      `SELECT o.id FROM orders o JOIN users u ON o.user_id = u.id JOIN apartment_groups ag ON u.apartment_id = ag.id
       WHERE o.user_id = $1 AND ag.distributor_id = $2 AND o.status NOT IN ('paid','completed')
       ORDER BY o.created_at DESC LIMIT 1`,
      [userId, distributorId]
    );
    if (!orderResult.rows.length) return res.status(404).json({ error: 'No pending order found for this user' });
    const orderId = orderResult.rows[0].id;

    // ✅ Confirm the payment without creating duplicate rows.
    //    First try to flip an existing pending_confirmation payment to success;
    //    only insert a fresh success row if the user had none on this order.
    const upd = await pool.query(
      "UPDATE payments SET status = 'success', paid_at = CURRENT_TIMESTAMP WHERE order_id = $1 AND status = 'pending_confirmation' RETURNING id",
      [orderId]
    );
    if (upd.rows.length === 0) {
      await pool.query(
        `INSERT INTO payments (order_id, method, amount, status, paid_at)
         VALUES ($1, 'confirmed_by_distributor', $2, 'success', CURRENT_TIMESTAMP)`,
        [orderId, amount]
      );
    }
    // Mark order as paid
    await pool.query("UPDATE orders SET status = 'paid' WHERE id = $1", [orderId]);

    // Send FCM to user
    const userResult = await pool.query('SELECT fcm_token, full_name FROM users WHERE id = $1', [userId]);
    if (userResult.rows[0]?.fcm_token) {
      try {
        await admin.messaging().send({
          token: userResult.rows[0].fcm_token,
          notification: { title: '✅ Payment Confirmed!', body: `Your payment of ₹${amount} has been confirmed by your distributor.` },
          data: { type: 'payment_confirmed', orderId: orderId.toString(), amount: amount.toString() },
          android: { priority: 'high', notification: { channelId: 'watercan_channel', sound: 'default', color: '#4CAF50' } },
          apns: { payload: { aps: { sound: 'default', badge: 1 } } }
        });
      } catch (fcmErr) { console.error('⚠️ FCM error:', fcmErr.message); }
    }

    console.log(`✅ Distributor ${distributorId} confirmed payment ₹${amount} for user ${userId}, order ${orderId}`);
    res.json({ message: 'Payment confirmed successfully', orderId });
  } catch (e) { console.error('❌ Confirm payment error:', e); res.status(500).json({ error: 'Failed to confirm payment' }); }
});

// ════════════════════════════════════════════════════
// ✅ NEW: STATS (historical — used by statistics.dart)
// ════════════════════════════════════════════════════
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const aptRes = await pool.query('SELECT id FROM apartment_groups WHERE distributor_id = $1', [req.distributor.distributorId]);
    const aptIds = aptRes.rows.map(r => r.id);
    if (!aptIds.length) return res.json({ weeklyStats: [] });

    const sevenAgo = new Date(); sevenAgo.setDate(sevenAgo.getDate() - 6);
    const ordRes = await pool.query(
      `SELECT DATE(o.created_at AT TIME ZONE 'Asia/Kolkata') as d, SUM(o.quantity) as cans, SUM(o.total_amount) as rev
       FROM orders o JOIN users u ON o.user_id = u.id
       WHERE u.apartment_id = ANY($1) AND o.created_at >= $2
       GROUP BY DATE(o.created_at AT TIME ZONE 'Asia/Kolkata') ORDER BY d ASC`,
      [aptIds, sevenAgo.toISOString()]
    );

    const now = new Date();
    const weeklyStats = [];
    for (let i = 6; i >= 0; i--) {
      const day = new Date(now); day.setDate(day.getDate() - i);
      const key = day.toISOString().substring(0, 10);
      const found = ordRes.rows.find(r => new Date(r.d).toISOString().substring(0, 10) === key);
      weeklyStats.push({ date: key, dayLabel: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day.getDay()], cans: found ? parseInt(found.cans) : 0, revenue: found ? parseFloat(found.rev) : 0.0, returns: 0 });
    }
    res.json({ weeklyStats });
  } catch (e) { console.error('❌ Stats error:', e); res.status(500).json({ error: 'Failed to get stats' }); }
});

module.exports = router;