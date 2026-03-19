const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRES_IN = '7d'; // 7 days

// ============================================
// GENERATE JWT TOKEN
// ============================================
function generateToken(userId, userType = 'user') {
  return jwt.sign(
    { 
      userId, 
      userType,
      iat: Math.floor(Date.now() / 1000)
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// ============================================
// VERIFY USER TOKEN
// ============================================
async function verifyUserToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'No token provided',
        message: 'Authorization header required'
      });
    }

    const token = authHeader.substring(7);

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      
      // Check if user exists
      const result = await pool.query(
        'SELECT id, email, full_name, phone FROM users WHERE id = $1',
        [decoded.userId]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ 
          error: 'Invalid token',
          message: 'User not found'
        });
      }

      req.user = {
        id: decoded.userId,
        ...result.rows[0]
      };

      next();
    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError') {
        // Token expired - client needs to refresh
        return res.status(401).json({ 
          error: 'Token expired',
          message: 'Please log in again',
          code: 'TOKEN_EXPIRED'
        });
      }

      if (jwtError.name === 'JsonWebTokenError') {
        return res.status(401).json({ 
          error: 'Invalid token',
          message: 'Authentication failed'
        });
      }

      throw jwtError;
    }
  } catch (error) {
    console.error('❌ Auth middleware error:', error.message);
    res.status(500).json({ 
      error: 'Server error',
      message: 'Authentication failed'
    });
  }
}

// ============================================
// VERIFY DISTRIBUTOR TOKEN
// ============================================
async function verifyDistributorToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'No token provided',
        message: 'Authorization header required'
      });
    }

    const token = authHeader.substring(7);

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      
      // Check if distributor exists
      const result = await pool.query(
        'SELECT id, email, full_name, phone, apartment_id FROM distributors WHERE id = $1',
        [decoded.userId]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ 
          error: 'Invalid token',
          message: 'Distributor not found'
        });
      }

      req.distributor = {
        id: decoded.userId,
        ...result.rows[0]
      };

      next();
    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError') {
        // Token expired - client needs to refresh
        return res.status(401).json({ 
          error: 'Token expired',
          message: 'Please log in again',
          code: 'TOKEN_EXPIRED'
        });
      }

      if (jwtError.name === 'JsonWebTokenError') {
        return res.status(401).json({ 
          error: 'Invalid token',
          message: 'Authentication failed'
        });
      }

      throw jwtError;
    }
  } catch (error) {
    console.error('❌ Distributor auth error:', error.message);
    res.status(500).json({ 
      error: 'Server error',
      message: 'Authentication failed'
    });
  }
}

// ============================================
// VERIFY USER OR DISTRIBUTOR TOKEN
// ============================================
async function verifyAnyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'No token provided',
        message: 'Authorization header required'
      });
    }

    const token = authHeader.substring(7);

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      
      if (decoded.userType === 'distributor') {
        // Check distributor
        const result = await pool.query(
          'SELECT id, email, full_name, phone, apartment_id FROM distributors WHERE id = $1',
          [decoded.userId]
        );

        if (result.rows.length === 0) {
          return res.status(401).json({ 
            error: 'Invalid token',
            message: 'Distributor not found'
          });
        }

        req.distributor = {
          id: decoded.userId,
          ...result.rows[0]
        };
        req.userType = 'distributor';
      } else {
        // Check user
        const result = await pool.query(
          'SELECT id, email, full_name, phone FROM users WHERE id = $1',
          [decoded.userId]
        );

        if (result.rows.length === 0) {
          return res.status(401).json({ 
            error: 'Invalid token',
            message: 'User not found'
          });
        }

        req.user = {
          id: decoded.userId,
          ...result.rows[0]
        };
        req.userType = 'user';
      }

      next();
    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError') {
        return res.status(401).json({ 
          error: 'Token expired',
          message: 'Please log in again',
          code: 'TOKEN_EXPIRED'
        });
      }

      if (jwtError.name === 'JsonWebTokenError') {
        return res.status(401).json({ 
          error: 'Invalid token',
          message: 'Authentication failed'
        });
      }

      throw jwtError;
    }
  } catch (error) {
    console.error('❌ Any auth error:', error.message);
    res.status(500).json({ 
      error: 'Server error',
      message: 'Authentication failed'
    });
  }
}

// ============================================
// REFRESH TOKEN ENDPOINT HELPER
// ============================================
async function refreshUserToken(userId) {
  try {
    // Verify user still exists
    const result = await pool.query(
      'SELECT id FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      throw new Error('User not found');
    }

    // Generate new token
    return generateToken(userId, 'user');
  } catch (error) {
    throw error;
  }
}

async function refreshDistributorToken(distributorId) {
  try {
    // Verify distributor still exists
    const result = await pool.query(
      'SELECT id FROM distributors WHERE id = $1',
      [distributorId]
    );

    if (result.rows.length === 0) {
      throw new Error('Distributor not found');
    }

    // Generate new token
    return generateToken(distributorId, 'distributor');
  } catch (error) {
    throw error;
  }
}

module.exports = {
  generateToken,
  verifyUserToken,
  verifyDistributorToken,
  verifyAnyToken,
  refreshUserToken,
  refreshDistributorToken,
};