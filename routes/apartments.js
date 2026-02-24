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
    
    // Query to get residents with their order totals
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
      error: 'Failed to get apartment residents' 
    });
  }
});

// GET /api/apartments/:apartmentId/orders
// Get all orders for an apartment (for debugging)
router.get('/:apartmentId/orders', async (req, res) => {
  try {
    const { apartmentId } = req.params;
    
    const query = `
      SELECT 
        o.*,
        u.full_name,
        u.phone
      FROM orders o
      JOIN users u ON o.user_id = u.id
      WHERE u.apartment_id = $1
      ORDER BY o.created_at DESC
      LIMIT 100
    `;
    
    const result = await pool.query(query, [apartmentId]);
    
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

module.exports = router;