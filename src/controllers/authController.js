// src/controllers/authController.js
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const database = require('../database');
const config = require('../config');

class AuthController {
    
    // Iniciar Sesión
    async login(req, res) {
        try {
            const { username, password } = req.body;

            if (!username || !password) {
                return res.status(400).json({ success: false, error: 'Usuario y contraseña requeridos' });
            }

            const user = await database.getUserByUsername(username);
            
            if (!user) {
                return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
            }

            // Verificar contraseña (soporta texto plano para desarrollo y hash para producción)
            const passwordIsValid = (password === user.password) || bcrypt.compareSync(password, user.password);
            if (!passwordIsValid) {
                return res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
            }

            // Actualizar último login
            await database.updateUser(user.id, { last_login: new Date() });

            // Generar Token (24 horas)
            const token = jwt.sign(
                { 
                    id: user.id, 
                    username: user.username, 
                    role: user.role, 
                    company_id: user.company_id 
                },
                config.JWT_SECRET,
                { expiresIn: 86400 } 
            );

            // Obtener nombre de empresa si aplica
            let companyName = null;
            if (user.company_id) {
                const company = await database.getCompanyById(user.company_id);
                companyName = company?.name;
            }

            res.json({
                success: true,
                token: token,
                user: {
                    id: user.id,
                    username: user.username,
                    full_name: user.full_name,
                    role: user.role,
                    company_id: user.company_id,
                    company_name: companyName
                }
            });

        } catch (error) {
            console.error('Login error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // Crear Usuario con validación de jerarquía
    async register(req, res) {
        try {
            const { username, password, full_name, role, company_id } = req.body;
            const requestUser = req.user;

            // Validaciones básicas
            if (!username || !password || !full_name || !role) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Todos los campos son requeridos (username, password, full_name, role)' 
                });
            }

            // Verificar que el usuario no exista
            const existingUser = await database.getUserByUsername(username);
            if (existingUser) {
                return res.status(400).json({ success: false, error: 'El nombre de usuario ya existe' });
            }

            // ==========================================
            // 🔒 VALIDACIÓN DE PERMISOS JERÁRQUICOS
            // ==========================================
            
            // SuperAdmin puede crear: admin, executive
            // Admin puede crear: solo executive de su empresa
            // Executive no puede crear usuarios

            if (requestUser.role === 'executive') {
                return res.status(403).json({ 
                    success: false, 
                    error: 'Los ejecutivos no pueden crear usuarios' 
                });
            }

            if (role === 'superadmin') {
                return res.status(403).json({ 
                    success: false, 
                    error: 'No se pueden crear usuarios superadmin' 
                });
            }

            if (role === 'admin' && requestUser.role !== 'superadmin') {
                return res.status(403).json({ 
                    success: false, 
                    error: 'Solo el SuperAdmin puede crear administradores de empresa' 
                });
            }

            if (role === 'executive' && requestUser.role === 'admin') {
                // Admin solo puede crear ejecutivos para SU empresa
                if (company_id && company_id !== requestUser.company_id) {
                    return res.status(403).json({ 
                        success: false, 
                        error: 'Solo puedes crear ejecutivos para tu propia empresa' 
                    });
                }
            }

            // Determinar company_id final
            let finalCompanyId = null;
            if (role === 'admin') {
                // Admin necesita company_id obligatorio
                if (!company_id) {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Se requiere company_id para crear un administrador de empresa' 
                    });
                }
                finalCompanyId = company_id;
            } else if (role === 'executive') {
                // Ejecutivo hereda company_id del admin que lo crea, o se especifica si es superadmin
                finalCompanyId = company_id || requestUser.company_id;
                if (!finalCompanyId) {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Se requiere company_id para crear un ejecutivo' 
                    });
                }
            }

            // Verificar que la empresa existe
            if (finalCompanyId) {
                const company = await database.getCompanyById(finalCompanyId);
                if (!company) {
                    return res.status(404).json({ 
                        success: false, 
                        error: 'La empresa especificada no existe' 
                    });
                }
            }

            // Encriptar contraseña
            const hashedPassword = bcrypt.hashSync(password, 10);

            // Crear usuario
            const userId = await database.createUser({
                company_id: finalCompanyId,
                username,
                password: hashedPassword,
                role,
                full_name
            });

            res.json({ 
                success: true, 
                message: 'Usuario creado exitosamente', 
                userId,
                user: {
                    id: userId,
                    username,
                    full_name,
                    role,
                    company_id: finalCompanyId
                }
            });

        } catch (error) {
            console.error('Register error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // Obtener perfil del usuario actual
    async getProfile(req, res) {
        try {
            const user = await database.getUserById(req.user.id);
            if (!user) {
                return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
            }
            
            // No devolver contraseña
            delete user.password;
            
            res.json({ success: true, user });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // Cambiar contraseña
    async changePassword(req, res) {
        try {
            const { currentPassword, newPassword } = req.body;
            const userId = req.user.id;

            if (!currentPassword || !newPassword) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Contraseña actual y nueva son requeridas' 
                });
            }

            const user = await database.getUserById(userId);
            
            // Verificar contraseña actual
            const passwordIsValid = (currentPassword === user.password) || bcrypt.compareSync(currentPassword, user.password);
            if (!passwordIsValid) {
                return res.status(401).json({ success: false, error: 'Contraseña actual incorrecta' });
            }

            // Actualizar contraseña
            const hashedPassword = bcrypt.hashSync(newPassword, 10);
            await database.updateUser(userId, { password: hashedPassword });

            res.json({ success: true, message: 'Contraseña actualizada exitosamente' });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    }
}

module.exports = new AuthController();
