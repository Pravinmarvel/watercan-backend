const jwt = require('jsonwebtoken');

// ✅ SECURITY: Validate JWT_SECRET exists on startup
if (!process.env.JWT_SECRET || process.env.JWT_SECRET === '') {
  console.error('❌ FATAL: JWT_SECRET environment variable is required');
  console.error('Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('❌ Token verification error:', err.message);
      }
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

function authenticateDistributor(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, distributor) => {
    if (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('❌ Distributor token error:', err.message);
      }
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.distributor = distributor;
    next();
  });
}

module.exports = { authenticateToken, authenticateDistributor, JWT_SECRET };