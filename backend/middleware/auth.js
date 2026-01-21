/**
 * Middleware de Autenticação - ACERTIVE
 */

const jwt = require('jsonwebtoken');

/**
 * Middleware de autenticação básica
 */
function auth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!token) return res.status(401).json({ success: false, message: "Token não enviado." });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    return next();
  } catch (err) {
    console.error("[AUTH] erro:", err.message);
    return res.status(401).json({ success: false, message: "Token inválido ou expirado." });
  }
}

/**
 * Middleware de autenticação para administradores
 */
function authAdmin(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!token) return res.status(401).json({ success: false, message: "Token não enviado." });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    if (payload.nivel !== 'admin') {
      return res.status(403).json({ success: false, message: "Acesso negado. Apenas administradores." });
    }
    return next();
  } catch (err) {
    console.error("[AUTH ADMIN] erro:", err.message);
    return res.status(401).json({ success: false, message: "Token inválido ou expirado." });
  }
}

module.exports = { auth, authAdmin };
