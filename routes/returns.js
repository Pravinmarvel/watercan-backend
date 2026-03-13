const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const jwt = require('jsonwebtoken');

// =====================================================
// AUTHENTICATION MIDDLEWARE - UNIVERSAL
// =====================================================
function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    
    // Handle both user and distributor tokens
    if (decoded.userId) {
      req.user = decoded;
    } else if (decoded.distributorId) {
      req.distributor = decoded;
    } else {
      return res.status(403).json({ error: 'Invalid token format' });
    }
    
    next();
  });
}

// =====================================================
// CREATE RETURN REQUEST - USER
// =====================================================
router.post('/create', authenticateToken, async (req, res) => {
  try {
    const { quantity, pickupDate, pickupAddress } = req.body;
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'User authentication required' });
    }

    // Validation
    if (!quantity || quantity < 1 || quantity > 3) {
      return res.status(400).json({ 
        error: 'Quantity must be between 1 and 3' 
      });
    }

    if (!pickupDate) {
      return res.status(400).json({ error: 'Pickup date is required' });
    }

    if (!pickupAddress || pickupAddress.trim() === '') {
      return res.status(400).json({ error: 'Pickup address is required' });
    }

    console.log(`📤 Creating return request for user ${userId}:`, {
      quantity,
      pickupDate,
      pickupAddress: pickupAddress.substring(0, 50)
    });

    // Check if user has pending returns
    const existingQuery = `
      SELECT id FROM can_returns 
      WHERE user_id = $1 AND status = 'pending'
    `;
    const existing = await pool.query(existingQuery, [userId]);

    if (existing.rows.length > 0) {
      return res.status(400).json({ 
        error: 'You already have a pending return request' 
      });
    }

    // Create return request
    const insertQuery = `
      INSERT INTO can_returns (user_id, quantity, pickup_date, pickup_address, status, created_at)
      VALUES ($1, $2, $3, $4, 'pending', CURRENT_TIMESTAMP)
      RETURNING *
    `;
    
    const result = await pool.query(insertQuery, [
      userId,
      quantity,
      pickupDate,
      pickupAddress.trim()
    ]);

    console.log(`✅ Return request created: User ${userId}, ID ${result.rows[0].id}, Qty ${quantity}`);

    res.status(201).json({
      message: 'Return request created successfully',
      return: {
        id: result.rows[0].id,
        quantity: result.rows[0].quantity,
        pickupDate: result.rows[0].pickup_date,
        pickupAddress: result.rows[0].pickup_address,
        status: result.rows[0].status,
        createdAt: result.rows[0].created_at
      }
    });

  } catch (error) {
    console.error('❌ Create return error:', error);
    res.status(500).json({ 
      error: 'Failed to create return request',
      details: error.message 
    });
  }
});

// =====================================================
// GET USER'S RETURN REQUESTS
// =====================================================
router.get('/my-returns', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'User authentication required' });
    }

    console.log(`📤 Getting returns for user ${userId}`);

    const query = `
      SELECT * FROM can_returns 
      WHERE user_id = $1 
      ORDER BY created_at DESC
    `;
    
    const result = await pool.query(query, [userId]);

    console.log(`✅ Found ${result.rows.length} returns for user ${userId}`);

    res.json({
      returns: result.rows.map(row => ({
        id: row.id,
        quantity: row.quantity,
        pickupDate: row.pickup_date,
        pickupAddress: row.pickup_address,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
    });

  } catch (error) {
    console.error('❌ Get returns error:', error);
    res.status(500).json({ error: 'Failed to get return requests' });
  }
});

// =====================================================
// GET ALL PENDING RETURNS - DISTRIBUTOR
// =====================================================
router.get('/pending', authenticateToken, async (req, res) => {
  try {
    const distributorId = req.distributor?.distributorId;

    if (!distributorId) {
      return res.status(401).json({ error: 'Distributor authentication required' });
    }

    console.log(`📤 Getting pending returns for distributor ${distributorId}`);

    const query = `
      SELECT 
        cr.*,
        u.full_name,
        u.phone,
        ag.name as apartment_name,
        ag.location as apartment_location
      FROM can_returns cr
      JOIN users u ON cr.user_id = u.id
      LEFT JOIN apartment_groups ag ON u.apartment_id = ag.id
      WHERE cr.status = 'pending' 
        AND ag.distributor_id = $1
      ORDER BY cr.pickup_date ASC
    `;
    
    const result = await pool.query(query, [distributorId]);

    console.log(`✅ Found ${result.rows.length} pending returns`);

    res.json({
      returns: result.rows.map(row => ({
        id: row.id,
        userId: row.user_id,
        userName: row.full_name,
        userPhone: row.phone,
        apartmentName: row.apartment_name,
        apartmentLocation: row.apartment_location,
        quantity: row.quantity,
        pickupDate: row.pickup_date,
        pickupAddress: row.pickup_address,
        status: row.status,
        createdAt: row.created_at
      }))
    });

  } catch (error) {
    console.error('❌ Get pending returns error:', error);
    res.status(500).json({ error: 'Failed to get pending returns' });
  }
});

// =====================================================
// MARK RETURN AS COLLECTED - DISTRIBUTOR
// =====================================================
router.put('/:returnId/collect', authenticateToken, async (req, res) => {
  try {
    const { returnId } = req.params;
    const distributorId = req.distributor?.distributorId;

    if (!distributorId) {
      return res.status(401).json({ error: 'Distributor authentication required' });
    }

    console.log(`📤 Marking return ${returnId} as collected by distributor ${distributorId}`);

    // Check if return exists and is pending
    const checkQuery = `
      SELECT * FROM can_returns 
      WHERE id = $1 AND status = 'pending'
    `;
    const checkResult = await pool.query(checkQuery, [returnId]);

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ 
        error: 'Return request not found or already collected' 
      });
    }

    // Update status to collected
    const updateQuery = `
      UPDATE can_returns 
      SET status = 'collected', updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `;
    
    const result = await pool.query(updateQuery, [returnId]);

    console.log(`✅ Return collected: ID ${returnId}`);

    res.json({
      message: 'Return marked as collected',
      return: {
        id: result.rows[0].id,
        status: result.rows[0].status,
        updatedAt: result.rows[0].updated_at
      }
    });

  } catch (error) {
    console.error('❌ Mark collected error:', error);
    res.status(500).json({ error: 'Failed to mark return as collected' });
  }
});

// =====================================================
// CANCEL RETURN REQUEST - USER
// =====================================================
router.delete('/:returnId', authenticateToken, async (req, res) => {
  try {
    const { returnId } = req.params;
    const userId = req.user?.userId;

    if (!userId) {
      return res.status(401).json({ error: 'User authentication required' });
    }

    console.log(`📤 Cancelling return ${returnId} by user ${userId}`);

    // Check if return belongs to user and is pending
    const checkQuery = `
      SELECT * FROM can_returns 
      WHERE id = $1 AND user_id = $2 AND status = 'pending'
    `;
    const checkResult = await pool.query(checkQuery, [returnId, userId]);

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ 
        error: 'Return request not found or cannot be cancelled' 
      });
    }

    // Delete the return request
    const deleteQuery = 'DELETE FROM can_returns WHERE id = $1';
    await pool.query(deleteQuery, [returnId]);

    console.log(`✅ Return cancelled: ID ${returnId}`);

    res.json({
      message: 'Return request cancelled successfully'
    });

  } catch (error) {
    console.error('❌ Cancel return error:', error);
    res.status(500).json({ error: 'Failed to cancel return request' });
  }
});

// =====================================================
// GET RETURN STATISTICS - DISTRIBUTOR
// =====================================================
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const distributorId = req.distributor?.distributorId;

    if (!distributorId) {
      return res.status(401).json({ error: 'Distributor authentication required' });
    }

    const statsQuery = `
      SELECT 
        COUNT(*) FILTER (WHERE cr.status = 'pending') as pending_count,
        COUNT(*) FILTER (WHERE cr.status = 'collected') as collected_count,
        SUM(cr.quantity) FILTER (WHERE cr.status = 'pending') as pending_cans,
        SUM(cr.quantity) FILTER (WHERE cr.status = 'collected' AND cr.updated_at >= CURRENT_DATE) as today_collected
      FROM can_returns cr
      JOIN users u ON cr.user_id = u.id
      JOIN apartment_groups ag ON u.apartment_id = ag.id
      WHERE ag.distributor_id = $1
    `;
    
    const result = await pool.query(statsQuery, [distributorId]);
    const stats = result.rows[0];

    res.json({
      pendingReturns: parseInt(stats.pending_count) || 0,
      collectedReturns: parseInt(stats.collected_count) || 0,
      pendingCans: parseInt(stats.pending_cans) || 0,
      todayCollected: parseInt(stats.today_collected) || 0
    });

  } catch (error) {
    console.error('❌ Get stats error:', error);
    res.status(500).json({ error: 'Failed to get statistics' });
  }
});

module.exports = router;