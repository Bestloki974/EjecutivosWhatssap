// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const config = require('../config');

// Middleware para verificar token
const verifyToken = (req, res, next) => {
    const token = req.headers['x-access-token'] || req.headers['authorization'];

    if (!token) {
        return res.status(403).json({ success: false, error: 'Se requiere un token para autenticación' });
    }

    // Limpiar "Bearer " si viene en el header
    const cleanToken = token.toString().replace('Bearer ', '');

    try {
        const decoded = jwt.verify(cleanToken, config.JWT_SECRET);
        req.user = decoded; // Guardamos los datos del usuario en la petición
        next();
    } catch (err) {
        return res.status(401).json({ success: false, error: 'Token inválido o expirado' });
    }
};

// Middleware para verificar Rol
const requireRole = (roles) => {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ 
                success: false, 
                error: 'No tienes permisos para realizar esta acción' 
            });
        }
        next();
    };
};

module.exports = {
    verifyToken,
    requireRole
};