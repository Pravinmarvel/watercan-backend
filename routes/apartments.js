// =====================================================
// APARTMENTS API ROUTE - FIXED VERSION
// =====================================================

const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// =====================================================
// GET /api/apartments/:apartmentId/residents
// Returns all residents with their order totals for current cycle
// =====================================================
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
      cycleEnd = new Date(now.getFullYear(), now.getMonth(), 10, 23, 59, 59);
    } else if (day <= 20) {
      cycleStart = new Date(now.getFullYear(), now.getMonth(), 11);
      cycleEnd = new Date(now.getFullYear(), now.getMonth(), 20, 23, 59, 59);
    } else {
      cycleStart = new Date(now.getFullYear(), now.getMonth(), 21);
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      cycleEnd = new Date(now.getFullYear(), now.getMonth(), lastDay, 23, 59, 59);
    }
    
    console.log(`📅 Cycle: ${cycleStart.toISOString()} to ${cycleEnd.toISOString()}`);
    
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
    
    console.log(`✅ Found ${result.rows.length} residents for apartment ${apartmentId}`);
    
    // Log details for debugging
    result.rows.forEach(row => {
      console.log(`   User ${row.id} (${row.full_name}): ${row.total_cans_cycle} cans this cycle`);
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
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// =====================================================
// GET /api/apartments/:apartmentId/orders
// Get all orders for an apartment (for debugging)
// =====================================================
router.get('/:apartmentId/orders', async (req, res) => {
  try {
    const { apartmentId } = req.params;
    const { startDate, endDate } = req.query;
    
    console.log(`📤 Getting orders for apartment ${apartmentId}`);
    
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
      error: 'Failed to get apartment orders',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// =====================================================
// GET /api/apartments/distributor/:distributorId
// Get all apartments for a distributor
// =====================================================
router.get('/distributor/:distributorId', async (req, res) => {
  try {
    const { distributorId } = req.params;
    
    console.log(`📤 Getting apartments for distributor ${distributorId}`);
    
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
      error: 'Failed to get apartments',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// =====================================================
// GET /api/apartments (all apartments - for testing)
// =====================================================
router.get('/', async (req, res) => {
  try {
    console.log(`📤 Getting all apartments`);
    
    const query = `
      SELECT 
        id,
        name,
        location,
        price_per_can,
        join_code,
        distributor_id,
        distributor_name,
        created_at
      FROM apartment_groups
      ORDER BY created_at DESC
      LIMIT 100
    `;
    
    const result = await pool.query(query);
    
    console.log(`✅ Found ${result.rows.length} total apartments`);
    
    res.json({
      success: true,
      apartments: result.rows
    });
    
  } catch (error) {
    console.error('❌ Get all apartments error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get apartments',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;