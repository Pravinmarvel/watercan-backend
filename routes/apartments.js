const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateDistributor } = require('../middleware/auth');

// ========================================
// GET ALL APARTMENTS FOR A DISTRIBUTOR
// ========================================
router.get('/distributor/:distributorId', async (req, res) => {
  try {
    const { distributorId } = req.params;

    console.log(`📥 Getting apartments for distributor ${distributorId}`);

    const result = await pool.query(
      `SELECT id, name, location, price_per_can, join_code, created_at 
       FROM apartments 
       WHERE distributor_id = $1 
       ORDER BY created_at DESC`,
      [distributorId]
    );

    console.log(`✅ Found ${result.rows.length} apartments`);

    res.json({
      apartments: result.rows.map(apt => ({
        id: apt.id,
        name: apt.name,
        location: apt.location,
        price_per_can: apt.price_per_can,
        join_code: apt.join_code,
        created_at: apt.created_at
      }))
    });

  } catch (error) {
    console.error('❌ Error getting apartments:', error);
    res.status(500).json({ error: 'Failed to get apartments' });
  }
});

// ========================================
// GET RESIDENTS OF AN APARTMENT (WITH ADDITIONAL CANS)
// ========================================
router.get('/:id/residents', async (req, res) => {
  try {
    const apartmentId = parseInt(req.params.id);

    console.log(`📥 Getting residents for apartment ${apartmentId}`);

    // Get all users in this apartment
    const usersResult = await pool.query(
      `SELECT id, full_name, phone, address 
       FROM users 
       WHERE apartment_id = $1 
       ORDER BY full_name`,
      [apartmentId]
    );

    console.log(`✅ Found ${usersResult.rows.length} users in apartment`);

    if (usersResult.rows.length === 0) {
      return res.json({ residents: [] });
    }

    // ✅ Calculate current cycle dates
    const now = new Date();
    const day = now.getDate();
    let cycleStart, cycleEnd;

    if (day <= 10) {
      // Cycle 1: 1st - 10th
      cycleStart = new Date(now.getFullYear(), now.getMonth(), 1);
      cycleEnd = new Date(now.getFullYear(), now.getMonth(), 10, 23, 59, 59);
    } else if (day <= 20) {
      // Cycle 2: 11th - 20th
      cycleStart = new Date(now.getFullYear(), now.getMonth(), 11);
      cycleEnd = new Date(now.getFullYear(), now.getMonth(), 20, 23, 59, 59);
    } else {
      // Cycle 3: 21st - end of month
      cycleStart = new Date(now.getFullYear(), now.getMonth(), 21);
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      cycleEnd = new Date(now.getFullYear(), now.getMonth(), daysInMonth, 23, 59, 59);
    }

    console.log(`📅 Current cycle: ${cycleStart.toISOString()} to ${cycleEnd.toISOString()}`);

    const residents = [];

    for (const user of usersResult.rows) {
      // ✅ Get can status
      const canStatusResult = await pool.query(
        `SELECT can_1_full, can_2_full, can_3_full, updated_at 
         FROM can_status 
         WHERE user_id = $1`,
        [user.id]
      );

      const canStatus = canStatusResult.rows[0] || {
        can_1_full: true,
        can_2_full: true,
        can_3_full: true,
        updated_at: null
      };

      // ✅ Count SUBSCRIPTION cans (is_additional = false OR null)
      const subscriptionResult = await pool.query(
        `SELECT COUNT(*) as count 
         FROM orders 
         WHERE user_id = $1 
         AND created_at >= $2 
         AND created_at <= $3 
         AND (is_additional = false OR is_additional IS NULL)`,
        [user.id, cycleStart, cycleEnd]
      );

      const subscriptionCans = parseInt(subscriptionResult.rows[0]?.count || 0);

      // ✅ Count ADDITIONAL cans (is_additional = true)
      const additionalResult = await pool.query(
        `SELECT COUNT(*) as count, MAX(created_at) as last_request
         FROM orders 
         WHERE user_id = $1 
         AND created_at >= $2 
         AND created_at <= $3 
         AND is_additional = true`,
        [user.id, cycleStart, cycleEnd]
      );

      const additionalCans = parseInt(additionalResult.rows[0]?.count || 0);
      const lastAdditionalRequest = additionalResult.rows[0]?.last_request || null;

      // ✅ Total cans for this cycle
      const totalCans = subscriptionCans + additionalCans;

      console.log(`   User ${user.id}: ${totalCans} total (${subscriptionCans} sub + ${additionalCans} extra)`);

      residents.push({
        id: user.id,
        fullName: user.full_name,
        phone: user.phone,
        address: user.address,
        canStatus: {
          can1Full: canStatus.can_1_full,
          can2Full: canStatus.can_2_full,
          can3Full: canStatus.can_3_full,
          updatedAt: canStatus.updated_at
        },
        totalCansThisCycle: totalCans,
        subscriptionCans: subscriptionCans,      // ✅ NEW: Subscription cans only
        additionalCans: additionalCans,          // ✅ NEW: Additional cans only
        lastAdditionalRequest: lastAdditionalRequest  // ✅ NEW: When last additional was requested
      });
    }

    console.log(`✅ Returning ${residents.length} residents with can data`);

    res.json({ residents });

  } catch (error) {
    console.error('❌ Error fetching residents:', error);
    res.status(500).json({ error: 'Failed to fetch residents' });
  }
});

// ========================================
// CREATE NEW APARTMENT
// ========================================
router.post('/', authenticateDistributor, async (req, res) => {
  try {
    const { name, location, price_per_can, join_code } = req.body;
    const distributorId = req.distributor.distributorId;

    console.log(`📥 Creating apartment for distributor ${distributorId}`);

    // Validate inputs
    if (!name || !location || !price_per_can || !join_code) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (join_code.length !== 4 || !/^\d{4}$/.test(join_code)) {
      return res.status(400).json({ error: 'Join code must be 4 digits' });
    }

    // Check if join code already exists
    const existingCode = await pool.query(
      'SELECT id FROM apartments WHERE join_code = $1',
      [join_code]
    );

    if (existingCode.rows.length > 0) {
      return res.status(400).json({ error: 'Join code already exists' });
    }

    // Create apartment
    const result = await pool.query(
      `INSERT INTO apartments (distributor_id, name, location, price_per_can, join_code) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING *`,
      [distributorId, name, location, price_per_can, join_code]
    );

    console.log(`✅ Apartment created with ID ${result.rows[0].id}`);

    res.status(201).json({
      apartment: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Error creating apartment:', error);
    res.status(500).json({ error: 'Failed to create apartment' });
  }
});

// ========================================
// UPDATE APARTMENT PRICE
// ========================================
router.put('/:id', authenticateDistributor, async (req, res) => {
  try {
    const apartmentId = parseInt(req.params.id);
    const { price_per_can } = req.body;
    const distributorId = req.distributor.distributorId;

    console.log(`📥 Updating apartment ${apartmentId} price to ${price_per_can}`);

    // Validate
    if (!price_per_can || price_per_can <= 0) {
      return res.status(400).json({ error: 'Invalid price' });
    }

    // Check ownership
    const apartmentCheck = await pool.query(
      'SELECT id FROM apartments WHERE id = $1 AND distributor_id = $2',
      [apartmentId, distributorId]
    );

    if (apartmentCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Apartment not found or unauthorized' });
    }

    // Update price
    const result = await pool.query(
      `UPDATE apartments 
       SET price_per_can = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2 
       RETURNING *`,
      [price_per_can, apartmentId]
    );

    console.log(`✅ Apartment ${apartmentId} price updated to ${price_per_can}`);

    res.json({
      apartment: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Error updating apartment:', error);
    res.status(500).json({ error: 'Failed to update apartment' });
  }
});

// ========================================
// DELETE APARTMENT
// ========================================
router.delete('/:id', authenticateDistributor, async (req, res) => {
  try {
    const apartmentId = parseInt(req.params.id);
    const distributorId = req.distributor.distributorId;

    console.log(`📥 Deleting apartment ${apartmentId}`);

    // Check ownership
    const apartmentCheck = await pool.query(
      'SELECT id FROM apartments WHERE id = $1 AND distributor_id = $2',
      [apartmentId, distributorId]
    );

    if (apartmentCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Apartment not found or unauthorized' });
    }

    // Check if there are users
    const usersCheck = await pool.query(
      'SELECT COUNT(*) as count FROM users WHERE apartment_id = $1',
      [apartmentId]
    );

    if (parseInt(usersCheck.rows[0].count) > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete apartment with active users' 
      });
    }

    // Delete apartment
    await pool.query('DELETE FROM apartments WHERE id = $1', [apartmentId]);

    console.log(`✅ Apartment ${apartmentId} deleted`);

    res.json({ 
      success: true, 
      message: 'Apartment deleted successfully' 
    });

  } catch (error) {
    console.error('❌ Error deleting apartment:', error);
    res.status(500).json({ error: 'Failed to delete apartment' });
  }
});

// ========================================
// JOIN APARTMENT (FOR USERS)
// ========================================
router.post('/join', async (req, res) => {
  try {
    const { join_code, user_id } = req.body;

    console.log(`📥 User ${user_id} joining apartment with code ${join_code}`);

    // Validate
    if (!join_code || !user_id) {
      return res.status(400).json({ error: 'Missing join code or user ID' });
    }

    // Find apartment by join code
    const apartmentResult = await pool.query(
      'SELECT id, name, location, price_per_can FROM apartments WHERE join_code = $1',
      [join_code]
    );

    if (apartmentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid join code' });
    }

    const apartment = apartmentResult.rows[0];

    // Update user's apartment
    await pool.query(
      'UPDATE users SET apartment_id = $1 WHERE id = $2',
      [apartment.id, user_id]
    );

    console.log(`✅ User ${user_id} joined apartment ${apartment.id}`);

    res.json({
      success: true,
      apartment: apartment
    });

  } catch (error) {
    console.error('❌ Error joining apartment:', error);
    res.status(500).json({ error: 'Failed to join apartment' });
  }
});

module.exports = router;