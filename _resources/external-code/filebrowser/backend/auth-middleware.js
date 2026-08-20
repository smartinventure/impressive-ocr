/**
 * Auth middleware placeholder for the file browser router.
 *
 * IMPORTANT — this stub deliberately FAILS CLOSED.
 *
 * `filesystem.js` can list, stat and create directories anywhere the server
 * process can reach, with no root-directory jail. That is intentional in the
 * original application (an admin-only backup tool that must be able to pick any
 * path on the host), but it means an unauthenticated mount is a full filesystem
 * disclosure. So until you replace these functions, every request is rejected.
 *
 * Replace with your project's real middleware, e.g.:
 *
 *   const { authenticateToken, requireAdmin } = require('../middleware/auth');
 *   module.exports = { authenticateToken, requireAdmin };
 *
 * Contract:
 *   authenticateToken(req, res, next) — verifies the caller, sets `req.user`,
 *     responds 401 otherwise.
 *   requireAdmin(req, res, next)      — responds 403 unless `req.user` is an
 *     administrator. Keep this: see the security notes in README.md.
 */

const NOT_CONFIGURED =
  "File browser auth is not configured. Replace backend/auth-middleware.js with your project's auth before mounting this router.";

const authenticateToken = (_req, res, _next) => {
  console.error(`[filebrowser] ${NOT_CONFIGURED}`);
  return res.status(501).json({
    success: false,
    error: NOT_CONFIGURED,
  });
};

const requireAdmin = (_req, res, _next) => {
  console.error(`[filebrowser] ${NOT_CONFIGURED}`);
  return res.status(501).json({
    success: false,
    error: NOT_CONFIGURED,
  });
};

module.exports = {
  authenticateToken,
  requireAdmin,
};
