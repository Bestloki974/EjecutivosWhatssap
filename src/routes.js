// src/routes.js
const express = require('express');
const router = express.Router();
const authController = require('./controllers/authController');
const sessionManager = require('./sessionManager');
const { verifyToken, requireRole } = require('./middleware/auth');
const database = require('./database');

// ==========================================
// 🔐 RUTAS DE AUTENTICACIÓN
// ==========================================
router.post('/auth/login', authController.login);
router.post('/auth/register', verifyToken, authController.register);
router.get('/auth/profile', verifyToken, authController.getProfile);
router.post('/auth/change-password', verifyToken, authController.changePassword);

// ==========================================
// 🏢 RUTAS DE EMPRESAS (Solo SuperAdmin)
// ==========================================

// Listar todas las empresas
router.get('/companies', verifyToken, requireRole(['superadmin']), async (req, res) => {
    try {
        const companies = await database.getAllCompanies();
        res.json({ success: true, companies });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Crear empresa
router.post('/companies', verifyToken, requireRole(['superadmin']), async (req, res) => {
    try {
        const { name, plan, max_sessions, max_users } = req.body;
        
        if (!name) {
            return res.status(400).json({ success: false, error: 'El nombre de la empresa es requerido' });
        }

        const companyId = await database.createCompany({ name, plan, max_sessions, max_users });
        res.json({ success: true, message: 'Empresa creada exitosamente', companyId });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Obtener empresa por ID
router.get('/companies/:id', verifyToken, requireRole(['superadmin']), async (req, res) => {
    try {
        const company = await database.getCompanyById(req.params.id);
        if (!company) {
            return res.status(404).json({ success: false, error: 'Empresa no encontrada' });
        }
        res.json({ success: true, company });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Actualizar empresa
router.put('/companies/:id', verifyToken, requireRole(['superadmin']), async (req, res) => {
    try {
        const { name, plan, status, max_sessions, max_users } = req.body;
        await database.updateCompany(req.params.id, { name, plan, status, max_sessions, max_users });
        res.json({ success: true, message: 'Empresa actualizada exitosamente' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Desactivar empresa
router.delete('/companies/:id', verifyToken, requireRole(['superadmin']), async (req, res) => {
    try {
        await database.deleteCompany(req.params.id);
        res.json({ success: true, message: 'Empresa desactivada exitosamente' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 👥 RUTAS DE USUARIOS
// ==========================================

// Listar usuarios (SuperAdmin ve todos, Admin ve solo los de su empresa)
router.get('/users', verifyToken, async (req, res) => {
    try {
        let users;
        
        if (req.user.role === 'superadmin') {
            users = await database.getAllUsers();
        } else if (req.user.role === 'admin') {
            users = await database.getUsersByCompany(req.user.company_id);
        } else {
            return res.status(403).json({ success: false, error: 'No tienes permisos para ver usuarios' });
        }
        
        res.json({ success: true, users });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Obtener usuario por ID
router.get('/users/:id', verifyToken, async (req, res) => {
    try {
        const user = await database.getUserById(req.params.id);
        
        if (!user) {
            return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
        }

        // Verificar permisos
        if (req.user.role === 'admin' && user.company_id !== req.user.company_id) {
            return res.status(403).json({ success: false, error: 'No tienes permisos para ver este usuario' });
        }
        
        if (req.user.role === 'executive' && user.id !== req.user.id) {
            return res.status(403).json({ success: false, error: 'No tienes permisos para ver este usuario' });
        }

        delete user.password;
        res.json({ success: true, user });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Actualizar usuario
router.put('/users/:id', verifyToken, async (req, res) => {
    try {
        const userId = req.params.id;
        const { full_name, status, password } = req.body;
        const user = await database.getUserById(userId);

        if (!user) {
            return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
        }

        // Verificar permisos
        if (req.user.role === 'admin') {
            if (user.company_id !== req.user.company_id || user.role !== 'executive') {
                return res.status(403).json({ success: false, error: 'Solo puedes editar ejecutivos de tu empresa' });
            }
        } else if (req.user.role === 'executive') {
            if (user.id !== req.user.id) {
                return res.status(403).json({ success: false, error: 'Solo puedes editar tu propio perfil' });
            }
        }

        const updateData = {};
        if (full_name) updateData.full_name = full_name;
        if (status && req.user.role !== 'executive') updateData.status = status;
        if (password) {
            const bcrypt = require('bcryptjs');
            updateData.password = bcrypt.hashSync(password, 10);
        }

        await database.updateUser(userId, updateData);
        res.json({ success: true, message: 'Usuario actualizado exitosamente' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Eliminar/Desactivar usuario
router.delete('/users/:id', verifyToken, async (req, res) => {
    try {
        const userId = req.params.id;
        const user = await database.getUserById(userId);

        if (!user) {
            return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
        }

        // No puede eliminarse a sí mismo
        if (user.id === req.user.id) {
            return res.status(400).json({ success: false, error: 'No puedes desactivar tu propia cuenta' });
        }

        // Verificar permisos
        if (req.user.role === 'admin') {
            if (user.company_id !== req.user.company_id || user.role !== 'executive') {
                return res.status(403).json({ success: false, error: 'Solo puedes desactivar ejecutivos de tu empresa' });
            }
        } else if (req.user.role !== 'superadmin') {
            return res.status(403).json({ success: false, error: 'No tienes permisos para desactivar usuarios' });
        }

        await database.deleteUser(userId);
        res.json({ success: true, message: 'Usuario desactivado exitosamente' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Cambiar estado del usuario (activar/desactivar)
router.put('/users/:id/status', verifyToken, async (req, res) => {
    try {
        const userId = req.params.id;
        const { status } = req.body;
        const user = await database.getUserById(userId);

        if (!user) {
            return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
        }

        if (!['active', 'inactive'].includes(status)) {
            return res.status(400).json({ success: false, error: 'Estado inválido' });
        }

        // No puede cambiarse a sí mismo
        if (user.id === req.user.id) {
            return res.status(400).json({ success: false, error: 'No puedes cambiar tu propio estado' });
        }

        // Verificar permisos
        if (req.user.role === 'admin') {
            if (user.company_id !== req.user.company_id || user.role !== 'executive') {
                return res.status(403).json({ success: false, error: 'Solo puedes gestionar ejecutivos de tu empresa' });
            }
        } else if (req.user.role !== 'superadmin') {
            return res.status(403).json({ success: false, error: 'No tienes permisos para cambiar el estado de usuarios' });
        }

        await database.updateUser(userId, { status });
        res.json({ success: true, message: `Usuario ${status === 'active' ? 'habilitado' : 'desactivado'} exitosamente` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Eliminar usuario PERMANENTEMENTE
router.delete('/users/:id/permanent', verifyToken, requireRole(['superadmin', 'admin']), async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        const user = await database.getUserById(userId);

        if (!user) {
            return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
        }

        // No puede eliminarse a sí mismo
        if (userId === req.user.id) {
            return res.status(400).json({ success: false, error: 'No puedes eliminar tu propia cuenta' });
        }

        // No permitir eliminar al superadmin
        if (user.role === 'superadmin') {
            return res.status(403).json({ success: false, error: 'No se puede eliminar un superadmin' });
        }

        // Si es admin, solo puede eliminar ejecutivos de su empresa
        if (req.user.role === 'admin') {
            if (user.company_id !== req.user.company_id || user.role !== 'executive') {
                return res.status(403).json({ success: false, error: 'Solo puedes eliminar ejecutivos de tu empresa' });
            }
        }

        // Eliminar permanentemente de la base de datos
        await database.pool.execute('DELETE FROM users WHERE id = ?', [userId]);
        res.json({ success: true, message: 'Usuario eliminado permanentemente' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 📱 RUTAS DE SESIONES WHATSAPP
// ==========================================

// Listar sesiones (filtrado por permisos)
router.get('/sessions', verifyToken, async (req, res) => {
    try {
        let sessions;
        
        if (req.user.role === 'superadmin') {
            sessions = await database.getAllSessions();
        } else if (req.user.role === 'admin') {
            sessions = await database.getSessionsByCompany(req.user.company_id);
        } else {
            // Ejecutivo: solo ve sesiones asignadas a él
            sessions = await database.getSessionsAssignedTo(req.user.id, req.user.company_id);
        }
        
        res.json({ success: true, sessions });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Asignar sesión a ejecutivo
router.post('/sessions/:sessionId/assign', verifyToken, requireRole(['superadmin', 'admin']), async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { userId } = req.body; // ID del ejecutivo a asignar (null para desasignar)
        
        // Verificar que la sesión existe
        const session = await database.getSessionById(sessionId);
        if (!session) {
            return res.status(404).json({ success: false, error: 'Sesión no encontrada' });
        }
        
        // Si es admin, verificar que la sesión pertenece a su empresa
        if (req.user.role === 'admin' && session.company_id !== req.user.company_id) {
            return res.status(403).json({ success: false, error: 'No tienes permisos sobre esta sesión' });
        }
        
        // Si se proporciona userId, verificar que el ejecutivo existe y pertenece a la misma empresa
        if (userId) {
            const targetUser = await database.getUserById(userId);
            if (!targetUser) {
                return res.status(404).json({ success: false, error: 'Usuario no encontrado' });
            }
            if (targetUser.role !== 'executive') {
                return res.status(400).json({ success: false, error: 'Solo se pueden asignar sesiones a ejecutivos' });
            }
            if (targetUser.company_id !== session.company_id) {
                return res.status(400).json({ success: false, error: 'El ejecutivo debe pertenecer a la misma empresa que la sesión' });
            }
        }
        
        // Asignar/desasignar
        await database.pool.execute(
            'UPDATE whatsapp_sessions SET assigned_to = ? WHERE id = ?',
            [userId || null, sessionId]
        );
        
        res.json({ 
            success: true, 
            message: userId ? 'Sesión asignada exitosamente' : 'Sesión desasignada exitosamente'
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Crear sesión (Solo SuperAdmin y Admin)
router.post('/sessions', verifyToken, requireRole(['superadmin', 'admin']), async (req, res) => {
    try {
        const { sessionName } = req.body;
        const companyId = req.user.role === 'superadmin' 
            ? (req.body.company_id || 1) 
            : req.user.company_id;

        if (!sessionName) {
            return res.status(400).json({ success: false, error: 'Nombre de sesión requerido' });
        }

        // Verificar si ya existe
        const existing = await database.getSessionByName(sessionName);
        if (existing) {
            return res.status(400).json({ success: false, error: 'Ya existe una sesión con ese nombre' });
        }

        await sessionManager.createSession(sessionName, companyId, req.user.id);
        
        res.json({ 
            success: true, 
            message: 'Sesión inicializada. Espera el código QR.',
            sessionName 
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Obtener QR de sesión
router.get('/sessions/:sessionName/qr', verifyToken, async (req, res) => {
    try {
        const { sessionName } = req.params;
        const session = sessionManager.getClient(sessionName);

        if (!session) {
            // Verificar si existe en DB y reconectar
            const dbSession = await database.getSessionByName(sessionName);
            if (dbSession) {
                return res.json({ status: 'disconnected', message: 'Sesión desconectada. Reconectando...' });
            }
            return res.status(404).json({ error: 'Sesión no encontrada' });
        }

        if (session.status === 'connected') {
            return res.json({ status: 'connected', message: 'Sesión conectada' });
        }

        if (!session.qr) {
            return res.json({ status: 'waiting', message: 'Esperando QR...' });
        }

        res.json({ success: true, qr: session.qr, status: 'qr_ready' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Cerrar sesión WhatsApp
router.post('/sessions/:sessionName/logout', verifyToken, requireRole(['superadmin', 'admin']), async (req, res) => {
    try {
        const { sessionName } = req.params;
        const success = await sessionManager.logoutSession(sessionName);
        
        if (success) {
            res.json({ success: true, message: 'Sesión cerrada correctamente' });
        } else {
            res.status(500).json({ success: false, error: 'No se pudo cerrar la sesión' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Regenerar sesión WhatsApp (elimina datos de autenticación y genera nuevo QR)
router.post('/sessions/:sessionName/regenerate', verifyToken, requireRole(['superadmin', 'admin']), async (req, res) => {
    try {
        const { sessionName } = req.params;
        const success = await sessionManager.regenerateSession(sessionName);
        
        if (success) {
            res.json({ success: true, message: 'Sesión regenerada. Escanea el nuevo QR.' });
        } else {
            res.status(500).json({ success: false, error: 'No se pudo regenerar la sesión' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Reconectar sesión
router.post('/sessions/:sessionName/reconnect', verifyToken, requireRole(['superadmin', 'admin']), async (req, res) => {
    try {
        const { sessionName } = req.params;
        const dbSession = await database.getSessionByName(sessionName);
        
        if (!dbSession) {
            return res.status(404).json({ success: false, error: 'Sesión no encontrada' });
        }

        await sessionManager.createSession(sessionName, dbSession.company_id, req.user.id);
        res.json({ success: true, message: 'Reconectando sesión...' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Eliminar sesión PERMANENTEMENTE
router.delete('/sessions/:sessionId', verifyToken, requireRole(['superadmin', 'admin']), async (req, res) => {
    try {
        const sessionId = parseInt(req.params.sessionId);
        
        // Obtener info de la sesión
        const session = await database.getSessionById(sessionId);
        if (!session) {
            return res.status(404).json({ success: false, error: 'Sesión no encontrada' });
        }

        // Si es admin, verificar que la sesión pertenece a su empresa
        if (req.user.role === 'admin' && session.company_id !== req.user.company_id) {
            return res.status(403).json({ success: false, error: 'No tienes permisos para eliminar esta sesión' });
        }

        // Primero cerrar la sesión de WhatsApp si está activa
        try {
            await sessionManager.logoutSession(session.session_name);
        } catch (e) {
            console.log('Sesión no estaba activa:', e.message);
        }

        // Eliminar mensajes de los chats de esta sesión
        await database.pool.execute(
            'DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE session_id = ?)',
            [sessionId]
        );

        // Eliminar chats de esta sesión
        await database.pool.execute(
            'DELETE FROM chats WHERE session_id = ?',
            [sessionId]
        );

        // Eliminar la sesión
        await database.pool.execute(
            'DELETE FROM whatsapp_sessions WHERE id = ?',
            [sessionId]
        );

        // Eliminar carpeta de autenticación
        const fs = require('fs');
        const path = require('path');
        const authPath = path.join(process.cwd(), '.wwebjs_auth', `session-${session.session_name}`);
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
        }

        res.json({ success: true, message: 'Sesión eliminada permanentemente' });
    } catch (error) {
        console.error('Error eliminando sesión:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 💬 RUTAS DE CHATS Y MENSAJES
// ==========================================

// Obtener chats (filtrado por rol y empresa)
router.get('/chats', verifyToken, async (req, res) => {
    try {
        let chats;
        const { session_id, company_id } = req.query;

        // Construir query base
        let query = `
            SELECT c.*, ws.session_name, ws.phone_number as session_phone, 
                   ws.company_id, co.name as company_name, u.full_name as assigned_name,
                   ws.assigned_to as session_assigned_to
            FROM chats c
            JOIN whatsapp_sessions ws ON c.session_id = ws.id
            LEFT JOIN companies co ON ws.company_id = co.id
            LEFT JOIN users u ON c.assigned_to = u.id
            WHERE 1=1
        `;
        const params = [];

        // Filtro por sesión específica
        if (session_id) {
            query += ' AND c.session_id = ?';
            params.push(session_id);
        }

        // Filtro por empresa (solo para superadmin, admin ya está filtrado por su empresa)
        if (req.user.role === 'superadmin') {
            if (company_id) {
                query += ' AND ws.company_id = ?';
                params.push(company_id);
            }
        } else if (req.user.role === 'admin') {
            // Admin solo ve chats de su empresa
            query += ' AND ws.company_id = ?';
            params.push(req.user.company_id);
        } else {
            // Ejecutivo: solo ve chats de las SESIONES que tiene asignadas
            query += ' AND ws.company_id = ? AND ws.assigned_to = ?';
            params.push(req.user.company_id, req.user.id);
        }

        query += ' ORDER BY c.last_message_time DESC LIMIT 100';

        const [rows] = await database.pool.execute(query, params);
        chats = rows;

        res.json({ success: true, chats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Obtener mensajes de un chat
router.get('/chats/:chatId/messages', verifyToken, async (req, res) => {
    try {
        const chatId = req.params.chatId;
        
        // Verificar que el usuario tiene acceso al chat
        const [chatRows] = await database.pool.execute(`
            SELECT c.*, ws.company_id, ws.assigned_to as session_assigned_to
            FROM chats c 
            JOIN whatsapp_sessions ws ON c.session_id = ws.id 
            WHERE c.id = ?
        `, [chatId]);

        if (chatRows.length === 0) {
            return res.status(404).json({ success: false, error: 'Chat no encontrado' });
        }

        const chat = chatRows[0];

        // Verificar permisos basados en SESIÓN asignada
        if (req.user.role === 'executive') {
            if (chat.session_assigned_to !== req.user.id) {
                return res.status(403).json({ success: false, error: 'No tienes acceso a este chat' });
            }
        } else if (req.user.role === 'admin' && chat.company_id !== req.user.company_id) {
            return res.status(403).json({ success: false, error: 'No tienes acceso a este chat' });
        }

        // Marcar como leído
        await database.markChatAsRead(chatId);

        const messages = await database.getChatMessages(chatId);
        res.json({ success: true, messages, chat });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Enviar mensaje
router.post('/chats/:chatId/send', verifyToken, async (req, res) => {
    try {
        const chatId = req.params.chatId;
        const { message } = req.body;

        if (!message) {
            return res.status(400).json({ success: false, error: 'Mensaje requerido' });
        }

        // Obtener info del chat con datos de la sesión
        const [chatRows] = await database.pool.execute(`
            SELECT c.*, ws.session_name, ws.company_id, ws.assigned_to as session_assigned_to
            FROM chats c 
            JOIN whatsapp_sessions ws ON c.session_id = ws.id 
            WHERE c.id = ?
        `, [chatId]);

        if (chatRows.length === 0) {
            return res.status(404).json({ success: false, error: 'Chat no encontrado' });
        }

        const chat = chatRows[0];

        // Verificar permisos basados en SESIÓN asignada (no chat individual)
        if (req.user.role === 'executive') {
            // Ejecutivo puede acceder si la SESIÓN está asignada a él
            if (chat.session_assigned_to !== req.user.id) {
                return res.status(403).json({ success: false, error: 'No tienes acceso a este chat' });
            }
        } else if (req.user.role === 'admin' && chat.company_id !== req.user.company_id) {
            return res.status(403).json({ success: false, error: 'No tienes acceso a este chat' });
        }

        // Enviar mensaje por WhatsApp
        const session = sessionManager.getClient(chat.session_name);
        if (!session || session.status !== 'connected') {
            return res.status(400).json({ success: false, error: 'La sesión de WhatsApp no está conectada' });
        }

        const sentMessage = await session.client.sendMessage(chat.remote_jid, message);
        
        // Guardar en DB
        await database.saveMessage(
            chat.session_id,
            chat.remote_jid,
            true,
            message,
            'chat',
            sentMessage.id._serialized
        );

        res.json({ success: true, message: 'Mensaje enviado', messageId: sentMessage.id._serialized });
    } catch (error) {
        console.error('Error enviando mensaje:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Iniciar nuevo chat con un número
router.post('/chats/new', verifyToken, async (req, res) => {
    try {
        const { phoneNumber, message, sessionId } = req.body;

        if (!phoneNumber || !message || !sessionId) {
            return res.status(400).json({ success: false, error: 'Número, mensaje y sesión son requeridos' });
        }

        // Limpiar número (solo dígitos)
        let cleanNumber = phoneNumber.replace(/\D/g, '');
        
        // Si empieza con 0, quitarlo
        if (cleanNumber.startsWith('0')) {
            cleanNumber = cleanNumber.substring(1);
        }
        
        // Si no tiene código de país, asumir Chile (56)
        if (cleanNumber.length <= 9) {
            cleanNumber = '56' + cleanNumber;
        }

        // Verificar que la sesión existe y el usuario tiene acceso
        const [sessionRows] = await database.pool.execute(`
            SELECT * FROM whatsapp_sessions WHERE id = ?
        `, [sessionId]);

        if (sessionRows.length === 0) {
            return res.status(404).json({ success: false, error: 'Sesión no encontrada' });
        }

        const sessionData = sessionRows[0];

        // Verificar permisos
        if (req.user.role === 'executive' && sessionData.assigned_to !== req.user.id) {
            return res.status(403).json({ success: false, error: 'No tienes acceso a esta sesión' });
        }
        if (req.user.role === 'admin' && sessionData.company_id !== req.user.company_id) {
            return res.status(403).json({ success: false, error: 'No tienes acceso a esta sesión' });
        }

        // Obtener cliente de WhatsApp
        const session = sessionManager.getClient(sessionData.session_name);
        if (!session || session.status !== 'connected') {
            return res.status(400).json({ success: false, error: 'La sesión de WhatsApp no está conectada' });
        }

        // Crear el JID para WhatsApp
        const remoteJid = `${cleanNumber}@c.us`;

        // Enviar mensaje
        const sentMessage = await session.client.sendMessage(remoteJid, message);

        // Crear o actualizar chat en DB
        const chat = await database.getOrCreateChat(sessionData.id, remoteJid, null);

        // Guardar mensaje
        await database.saveMessage(
            sessionData.id,
            remoteJid,
            true,
            message,
            'chat',
            sentMessage.id._serialized
        );

        res.json({ 
            success: true, 
            message: 'Mensaje enviado', 
            chatId: chat.id,
            phoneNumber: cleanNumber
        });
    } catch (error) {
        console.error('Error iniciando nuevo chat:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Asignar chat a ejecutivo
router.post('/chats/:chatId/assign', verifyToken, requireRole(['superadmin', 'admin']), async (req, res) => {
    try {
        const chatId = req.params.chatId;
        const { userId } = req.body;

        // Verificar que el chat existe
        const [chatRows] = await database.pool.execute(`
            SELECT c.*, ws.company_id 
            FROM chats c 
            JOIN whatsapp_sessions ws ON c.session_id = ws.id 
            WHERE c.id = ?
        `, [chatId]);

        if (chatRows.length === 0) {
            return res.status(404).json({ success: false, error: 'Chat no encontrado' });
        }

        const chat = chatRows[0];

        // Admin solo puede asignar chats de su empresa
        if (req.user.role === 'admin' && chat.company_id !== req.user.company_id) {
            return res.status(403).json({ success: false, error: 'No puedes asignar este chat' });
        }

        // Verificar que el usuario existe y es de la misma empresa
        if (userId) {
            const user = await database.getUserById(userId);
            if (!user || user.company_id !== chat.company_id) {
                return res.status(400).json({ success: false, error: 'Usuario inválido para asignar' });
            }
        }

        await database.assignChat(chatId, userId || null);
        res.json({ success: true, message: userId ? 'Chat asignado exitosamente' : 'Chat desasignado' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// 📊 RUTAS DE DASHBOARD
// ==========================================

// Estadísticas del dashboard
router.get('/dashboard/stats', verifyToken, async (req, res) => {
    try {
        const companyId = req.user.role === 'superadmin' ? null : req.user.company_id;
        const stats = await database.getDashboardStats(companyId);
        res.json({ success: true, stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
