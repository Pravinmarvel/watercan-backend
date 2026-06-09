// =====================================================
// APARTMENTS API ROUTE - NEW BACKEND ENDPOINT
// =====================================================

const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// GET /api/apartments/:apartmentId/residents
// Returns all residents with their order totals for current cycle
router.get('/:apartmentId/residents', async (req, res) => {
  try {
    const { apartmentId } = req.params;
    
    console.log(`📤 Getting residents for apartment ${apartmentId}`);
    
    // Get current 10-day cycle dates
    const now = new Date();
    const day = now.getDate();
    let cycleStart, cycleEnd;
    
    if (day <= 10) {
      cycleStart = new Date(now.getFullYear(), now.getMonth(), 1);
      cycleEnd = new Date(now.getFullYear(), now.getMonth(), 10);
    } else if (day <= 20) {
      cycleStart = new Date(now.getFullYear(), now.getMonth(), 11);
      cycleEnd = new Date(now.getFullYear(), now.getMonth(), 20);
    } else {
      cycleStart = new Date(now.getFullYear(), now.getMonth(), 21);
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      cycleEnd = new Date(now.getFullYear(), now.getMonth(), lastDay);
    }
    
    // ✅ CRITICAL QUERY: Gets residents with subscription cans, additional cans, can status,
    //    total subscription count (for new/renewed detection), and return history
    const query = `
      SELECT 
        u.id,
        u.phone,
        u.full_name,
        u.apartment_id,
        -- ✅ FIX: Subquery gets the MOST RECENT saved address only
        -- Prevents duplicate rows when a user has multiple addresses
        (SELECT a.address_line 
         FROM addresses a 
         WHERE a.user_id = u.id 
         ORDER BY a.created_at DESC 
         LIMIT 1) as address_line,
        (SELECT a.latitude
         FROM addresses a
         WHERE a.user_id = u.id
         ORDER BY a.created_at DESC
         LIMIT 1) as user_latitude,
        (SELECT a.longitude
         FROM addresses a
         WHERE a.user_id = u.id
         ORDER BY a.created_at DESC
         LIMIT 1) as user_longitude,
        cs.can_1_full,
        cs.can_2_full,
        cs.can_3_full,
        cs.updated_at as can_status_updated,
        COALESCE(cs.additional_cans, 0) as additional_cans,
        -- ✅ FIXED cycle can count. The old version did COALESCE(SUM(o.quantity),0)
        -- over a LEFT JOIN orders, which summed EVERY order row in the cycle:
        --   • duplicate daily order rows (created before the user app started
        --     updating one order per day in place), and
        --   • the cycle-total "payment" order created at checkout.
        -- That double/triple-counted the cycle (e.g. ₹1240 instead of ₹400).
        -- This counts the SAME way the user app does: one figure per calendar
        -- day (the latest/biggest order for that day), summed across the cycle,
        -- and ignores any order that already has a payment attached (the
        -- checkout summary order).
        COALESCE((
          SELECT SUM(per_day.daily_qty)
          FROM (
            SELECT MAX(od.quantity) AS daily_qty
            FROM orders od
            WHERE od.user_id = u.id
              AND od.created_at >= $2
              AND od.created_at <= $3
              AND (od.status IS NULL OR od.status <> 'scheduled')
              AND NOT EXISTS (
                SELECT 1 FROM payments p WHERE p.order_id = od.id
              )
            GROUP BY (od.created_at AT TIME ZONE 'UTC')::date
          ) per_day
        ), 0) as total_cans_cycle,
        (SELECT COUNT(*) FROM subscriptions s WHERE s.user_id = u.id) as total_subscriptions,
        (SELECT COUNT(*) FROM can_returns cr WHERE cr.user_id = u.id AND cr.status = 'collected') as total_collected_returns,
        (SELECT COUNT(*) FROM orders o2 WHERE o2.user_id = u.id AND o2.status = 'scheduled' AND o2.scheduled_for IS NOT NULL AND o2.scheduled_for >= NOW()) as scheduled_orders_count,
        (SELECT json_agg(json_build_object('id', o3.id, 'quantity', o3.quantity, 'scheduled_for', o3.scheduled_for, 'created_at', o3.created_at) ORDER BY o3.scheduled_for ASC)
         FROM orders o3 
         WHERE o3.user_id = u.id AND o3.status = 'scheduled' AND o3.scheduled_for IS NOT NULL AND o3.scheduled_for >= NOW()
        ) as scheduled_order_list
      FROM users u
      -- ✅ REMOVED: LEFT JOIN addresses — was causing one row per address per user
      -- ✅ REMOVED: LEFT JOIN orders — cycle cans now come from the per-day
      --    dedup subquery above, so we no longer aggregate here (and no longer
      --    need a GROUP BY). This is what eliminated the inflated total.
      LEFT JOIN can_status cs ON cs.user_id = u.id
      WHERE u.apartment_id = $1
      ORDER BY u.full_name ASC
    `;
    
    const result = await pool.query(query, [
      apartmentId,
      cycleStart.toISOString(),
      cycleEnd.toISOString()
    ]);
    
    console.log(`✅ Found ${result.rows.length} residents`);
    
    // Log details for debugging
    result.rows.forEach(row => {
      console.log(`   User ${row.id}: ${row.total_cans_cycle} cans`);
    });

    // ✅ Get this apartment's distributor location (to compute proximity).
    let distLat = null, distLng = null;
    try {
      const dloc = await pool.query(
        `SELECT d.current_latitude, d.current_longitude
         FROM apartment_groups ag
         JOIN distributors d ON d.id = ag.distributor_id
         WHERE ag.id = $1`,
        [apartmentId]
      );
      if (dloc.rows.length > 0) {
        distLat = dloc.rows[0].current_latitude != null ? parseFloat(dloc.rows[0].current_latitude) : null;
        distLng = dloc.rows[0].current_longitude != null ? parseFloat(dloc.rows[0].current_longitude) : null;
      }
    } catch (e) {
      console.warn('⚠️ Could not load distributor location:', e.message);
    }

    // ✅ Active Cash-on-Delivery users (table may not exist yet → empty set).
    let codUserIds = new Set();
    try {
      const codRes = await pool.query(
        `SELECT DISTINCT user_id FROM cod_flags
         WHERE cycle_end IS NULL OR cycle_end >= NOW()`
      );
      codUserIds = new Set(codRes.rows.map(r => r.user_id));
    } catch (e) {
      // cod_flags not created yet — no COD users. Safe to ignore.
    }

    // Haversine distance in metres.
    const distanceMeters = (lat1, lng1, lat2, lng2) => {
      const toRad = (d) => d * Math.PI / 180;
      const R = 6371000;
      const dLat = toRad(lat2 - lat1);
      const dLng = toRad(lng2 - lng1);
      const a = Math.sin(dLat / 2) ** 2 +
                Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };

    const residents = result.rows.map(row => {
      const uLat = row.user_latitude  != null ? parseFloat(row.user_latitude)  : null;
      const uLng = row.user_longitude != null ? parseFloat(row.user_longitude) : null;
      let distance = null;
      if (distLat != null && distLng != null && uLat != null && uLng != null) {
        distance = Math.round(distanceMeters(distLat, distLng, uLat, uLng));
      }
      return {
        id: row.id,
        phone: row.phone,
        fullName: row.full_name,
        address: row.address_line,
        latitude: uLat,
        longitude: uLng,
        // ✅ Distance (metres) from the distributor's last known location,
        //    or null if either side has no coordinates / no live location.
        distance: distance,
        // ✅ COD flag for this cycle.
        cod: codUserIds.has(row.id),
        canStatus: {
          can1Full: row.can_1_full,
          can2Full: row.can_2_full,
          can3Full: row.can_3_full,
          updatedAt: row.can_status_updated
        },
        additionalCans: parseInt(row.additional_cans) || 0,
        totalCansThisCycle: parseInt(row.total_cans_cycle),
        scheduledOrders: parseInt(row.scheduled_orders_count) || 0,
        scheduledOrderList: row.scheduled_order_list || [],
        customerStatus: parseInt(row.total_subscriptions) === 0
          ? 'new'
          : parseInt(row.total_collected_returns) > 0
            ? 'renewed'
            : null
      };
    });

    // ✅ Sort nearest-first when distances are known; residents without a
    //    distance go to the end. (The app also sorts, but sorting here keeps
    //    every client consistent.)
    residents.sort((a, b) => {
      if (a.distance == null && b.distance == null) return 0;
      if (a.distance == null) return 1;
      if (b.distance == null) return -1;
      return a.distance - b.distance;
    });

    res.json({
      success: true,
      cycleStart: cycleStart.toISOString(),
      cycleEnd: cycleEnd.toISOString(),
      residents: residents
    });
    
  } catch (error) {
    console.error('❌ Get apartment residents error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get apartment residents',
      details: error.message
    });
  }
});

// GET /api/apartments/:apartmentId/orders
// Get all orders for an apartment (for debugging)
router.get('/:apartmentId/orders', async (req, res) => {
  try {
    const { apartmentId } = req.params;
    const { startDate, endDate } = req.query;
    
    let query = `
      SELECT 
        o.id,
        o.user_id,
        o.quantity,
        o.total_amount,
        o.status,
        o.created_at,
        u.full_name,
        u.phone
      FROM orders o
      JOIN users u ON o.user_id = u.id
      WHERE u.apartment_id = $1
    `;
    
    const params = [apartmentId];
    
    if (startDate) {
      params.push(startDate);
      query += ` AND o.created_at >= $${params.length}`;
    }
    
    if (endDate) {
      params.push(endDate);
      query += ` AND o.created_at <= $${params.length}`;
    }
    
    query += ` ORDER BY o.created_at DESC LIMIT 200`;
    
    const result = await pool.query(query, params);
    
    console.log(`✅ Found ${result.rows.length} orders for apartment ${apartmentId}`);
    
    res.json({
      success: true,
      orders: result.rows
    });
    
  } catch (error) {
    console.error('❌ Get apartment orders error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get apartment orders' 
    });
  }
});

// GET /api/distributors/:distributorId/apartments
// Get all apartments for a distributor
router.get('/distributor/:distributorId', async (req, res) => {
  try {
    const { distributorId } = req.params;
    
    const query = `
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
      WHERE distributor_id = $1
      ORDER BY name ASC
    `;
    
    const result = await pool.query(query, [distributorId]);
    
    console.log(`✅ Found ${result.rows.length} apartments for distributor ${distributorId}`);
    
    res.json({
      success: true,
      apartments: result.rows
    });
    
  } catch (error) {
    console.error('❌ Get distributor apartments error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get apartments' 
    });
  }
});

// =====================================================
// GET DISTRIBUTOR WORKING STATUS - NEW
// =====================================================
router.get('/:distributorId/working-status', async (req, res) => {
  try {
    const distributorId = parseInt(req.params.distributorId);

    if (isNaN(distributorId)) {
      return res.status(400).json({ error: 'Invalid distributor ID' });
    }

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
    
    // If globally set to holiday
    if (!distributor.is_working) {
      return res.json({
        isWorking: false,
        status: 'holiday',
        message: 'Distributor is on holiday'
      });
    }

    // Check current day and time (IST timezone)
    const now = new Date();
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const currentDay = days[now.getDay()];
    
    // Format current time in HH:MM format (24-hour)
    const currentTime = now.toLocaleTimeString('en-IN', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: false,
      timeZone: 'Asia/Kolkata'
    });

    const schedule = distributor.working_schedule || {};
    const daySchedule = schedule[currentDay];

    console.log(`📅 Checking ${distributor.full_name} schedule for ${currentDay} at ${currentTime}`);

    if (!daySchedule) {
      // No schedule set for today, assume working
      console.log(`✅ No schedule for ${currentDay} - default working`);
      return res.json({
        isWorking: true,
        status: 'working',
        message: 'Working'
      });
    }

    // Check if it's a holiday
    if (daySchedule.isHoliday) {
      console.log(`🏖️ ${currentDay} is marked as holiday`);
      return res.json({
        isWorking: false,
        status: 'holiday',
        message: 'Holiday today'
      });
    }

    // Check working hours
    if (daySchedule.start && daySchedule.end) {
      const isWithinHours = currentTime >= daySchedule.start && currentTime <= daySchedule.end;
      
      console.log(`⏰ Working hours: ${daySchedule.start} - ${daySchedule.end}, Current: ${currentTime}, Within hours: ${isWithinHours}`);
      
      return res.json({
        isWorking: isWithinHours,
        status: isWithinHours ? 'working' : 'offline',
        message: isWithinHours 
          ? `Working`
          : `Offline`,
        workingHours: `${daySchedule.start} - ${daySchedule.end}`
      });
    }

    // Default to working
    return res.json({
      isWorking: true,
      status: 'working',
      message: 'Working'
    });

  } catch (error) {
    console.error('❌ Get working status error:', error);
    res.status(500).json({ error: 'Failed to get working status' });
  }
});

module.exports = router;