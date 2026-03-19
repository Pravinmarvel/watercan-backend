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
    
    // ✅ CRITICAL QUERY: Gets residents with TOTAL cans including additional!
    const query = `
      SELECT 
        u.id,
        u.phone,
        u.full_name,
        u.apartment_id,
        a.address_line,
        cs.can_1_full,
        cs.can_2_full,
        cs.can_3_full,
        cs.updated_at as can_status_updated,
        COALESCE(SUM(o.quantity), 0) as total_cans_cycle
      FROM users u
      LEFT JOIN addresses a ON a.user_id = u.id
      LEFT JOIN can_status cs ON cs.user_id = u.id
      LEFT JOIN orders o ON o.user_id = u.id 
        AND o.created_at >= $2 
        AND o.created_at <= $3
      WHERE u.apartment_id = $1
      GROUP BY u.id, u.phone, u.full_name, u.apartment_id, 
               a.address_line, cs.can_1_full, cs.can_2_full, 
               cs.can_3_full, cs.updated_at
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
    
    res.json({
      success: true,
      cycleStart: cycleStart.toISOString(),
      cycleEnd: cycleEnd.toISOString(),
      residents: result.rows.map(row => ({
        id: row.id,
        phone: row.phone,
        fullName: row.full_name,
        address: row.address_line,
        canStatus: {
          can1Full: row.can_1_full,
          can2Full: row.can_2_full,
          can3Full: row.can_3_full,
          updatedAt: row.can_status_updated
        },
        totalCansThisCycle: parseInt(row.total_cans_cycle)
      }))
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