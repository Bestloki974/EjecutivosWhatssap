// src/database.js
const mysql = require('mysql2/promise');
const config = require('./config');

class Database {
    constructor() {
        this.pool = mysql.createPool(config.DB_CONFIG);
        console.log('✅ Base de datos configurada (Pool)');
    }

    // ==========================================
    // 👤 USUARIOS
    // ==========================================
    
    async getUserByUsername(username) {
        const [rows] = await this.pool.execute(
            'SELECT * FROM users WHERE username = ? AND status = "active"', 
            [username]
        );
        return rows[0];
    }

    async getUserById(userId) {
        const [rows] = await this.pool.execute(
            'SELECT u.*, c.name as company_name FROM users u LEFT JOIN companies c ON u.company_id = c.id WHERE u.id = ?',
            [userId]
        );
        return rows[0];
    }

    async createUser(userData) {
        const { company_id, username, password, role, full_name } = userData;
        const [result] = await this.pool.execute(
            'INSERT INTO users (company_id, username, password, role, full_name) VALUES (?, ?, ?, ?, ?)',
            [company_id, username, password, role, full_name]
        );
        return result.insertId;
    }

    async updateUser(userId, userData) {
        const fields = [];
        const values = [];
        
        for (const [key, value] of Object.entries(userData)) {
            if (value !== undefined && key !== 'id') {
                fields.push(`${key} = ?`);
                values.push(value);
            }
        }
        
        if (fields.length === 0) return false;
        
        values.push(userId);
        await this.pool.execute(
            `UPDATE users SET ${fields.join(', ')} WHERE id = ?`,
            values
        );
        return true;
    }

    async deleteUser(userId) {
        await this.pool.execute('UPDATE users SET status = "inactive" WHERE id = ?', [userId]);
        return true;
    }

    // Obtener todos los usuarios (SuperAdmin)
    async getAllUsers() {
        const [rows] = await this.pool.execute(`
            SELECT u.id, u.username, u.full_name, u.role, u.company_id, u.status, u.created_at,
                   c.name as company_name
            FROM users u
            LEFT JOIN companies c ON u.company_id = c.id
            ORDER BY u.created_at DESC
        `);
        return rows;
    }

    // Obtener usuarios de una empresa (Admin de empresa)
    async getUsersByCompany(companyId) {
        const [rows] = await this.pool.execute(`
            SELECT id, company_id, username, full_name, role, status, created_at
            FROM users 
            WHERE company_id = ? AND role = 'executive'
            ORDER BY created_at DESC
        `, [companyId]);
        return rows;
    }

    // ==========================================
    // 🏢 EMPRESAS
    // ==========================================

    async createCompany(companyData) {
        const { name, plan, max_sessions, max_users } = companyData;
        const [result] = await this.pool.execute(
            'INSERT INTO companies (name, plan, max_sessions, max_users) VALUES (?, ?, ?, ?)',
            [name, plan || 'basic', max_sessions || 1, max_users || 5]
        );
        return result.insertId;
    }

    async getAllCompanies() {
        const [rows] = await this.pool.execute(`
            SELECT c.*, 
                   (SELECT COUNT(*) FROM users WHERE company_id = c.id) as user_count,
                   (SELECT COUNT(*) FROM whatsapp_sessions WHERE company_id = c.id) as session_count
            FROM companies c
            ORDER BY c.created_at DESC
        `);
        return rows;
    }

    async getCompanyById(companyId) {
        const [rows] = await this.pool.execute('SELECT * FROM companies WHERE id = ?', [companyId]);
        return rows[0];
    }

    async updateCompany(companyId, companyData) {
        const fields = [];
        const values = [];
        
        for (const [key, value] of Object.entries(companyData)) {
            if (value !== undefined && key !== 'id') {
                fields.push(`${key} = ?`);
                values.push(value);
            }
        }
        
        if (fields.length === 0) return false;
        
        values.push(companyId);
        await this.pool.execute(
            `UPDATE companies SET ${fields.join(', ')} WHERE id = ?`,
            values
        );
        return true;
    }

    async deleteCompany(companyId) {
        await this.pool.execute('UPDATE companies SET status = "inactive" WHERE id = ?', [companyId]);
        return true;
    }

    // ==========================================
    // 📱 SESIONES WHATSAPP
    // ==========================================

    async saveSession(sessionName, companyId, status) {
        const [rows] = await this.pool.execute(
            'SELECT id FROM whatsapp_sessions WHERE session_name = ?', 
            [sessionName]
        );

        if (rows.length > 0) {
            await this.pool.execute(
                'UPDATE whatsapp_sessions SET status = ?, last_activity = NOW() WHERE session_name = ?',
                [status, sessionName]
            );
            return rows[0].id;
        } else {
            const [res] = await this.pool.execute(
                'INSERT INTO whatsapp_sessions (company_id, session_name, status) VALUES (?, ?, ?)',
                [companyId, sessionName, status]
            );
            return res.insertId;
        }
    }

    async getSessionByName(sessionName) {
        const [rows] = await this.pool.execute(
            'SELECT * FROM whatsapp_sessions WHERE session_name = ?',
            [sessionName]
        );
        return rows[0];
    }

    async getSessionsByCompany(companyId) {
        const [rows] = await this.pool.execute(`
            SELECT ws.*, c.name as company_name,
                   u.full_name as assigned_name, u.username as assigned_username
            FROM whatsapp_sessions ws
            LEFT JOIN companies c ON ws.company_id = c.id
            LEFT JOIN users u ON ws.assigned_to = u.id
            WHERE ws.company_id = ? 
            ORDER BY ws.last_activity DESC
        `, [companyId]);
        return rows;
    }

    async getAllSessions() {
        const [rows] = await this.pool.execute(`
            SELECT ws.*, c.name as company_name,
                   u.full_name as assigned_name, u.username as assigned_username
            FROM whatsapp_sessions ws
            LEFT JOIN companies c ON ws.company_id = c.id
            LEFT JOIN users u ON ws.assigned_to = u.id
            ORDER BY ws.last_activity DESC
        `);
        return rows;
    }

    async getSessionsAssignedTo(userId, companyId) {
        const [rows] = await this.pool.execute(`
            SELECT ws.*, c.name as company_name,
                   u.full_name as assigned_name, u.username as assigned_username
            FROM whatsapp_sessions ws
            LEFT JOIN companies c ON ws.company_id = c.id
            LEFT JOIN users u ON ws.assigned_to = u.id
            WHERE ws.assigned_to = ? AND ws.company_id = ?
            ORDER BY ws.last_activity DESC
        `, [userId, companyId]);
        return rows;
    }

    async getSessionById(sessionId) {
        const [rows] = await this.pool.execute(`
            SELECT ws.*, c.name as company_name
            FROM whatsapp_sessions ws
            LEFT JOIN companies c ON ws.company_id = c.id
            WHERE ws.id = ?
        `, [sessionId]);
        return rows[0];
    }

    // ==========================================
    // 💬 CHATS Y MENSAJES
    // ==========================================

    async getOrCreateChat(sessionId, remoteJid, contactName = null) {
        // Extraer el número del JID (sin @c.us, @s.whatsapp.net, @lid, etc.)
        const phoneNumber = remoteJid.split('@')[0];
        const jidType = remoteJid.split('@')[1]; // 'c.us', 'lid', 's.whatsapp.net'
        
        // PRIMERO: Buscar chat exacto
        let [chats] = await this.pool.execute(
            'SELECT * FROM chats WHERE session_id = ? AND remote_jid = ? LIMIT 1',
            [sessionId, remoteJid]
        );
        
        // Si no existe exacto, buscar por número similar (diferentes sufijos)
        if (chats.length === 0) {
            [chats] = await this.pool.execute(
                `SELECT * FROM chats WHERE session_id = ? AND (
                    remote_jid LIKE ? OR
                    remote_jid LIKE ?
                ) ORDER BY 
                    CASE WHEN remote_jid LIKE '%@lid' THEN 0 ELSE 1 END,
                    id ASC 
                LIMIT 1`,
                [sessionId, `${phoneNumber}@%`, `%:${phoneNumber}@%`]
            );
        }

        // Si no existe, crear nuevo
        if (chats.length === 0) {
            const [res] = await this.pool.execute(
                'INSERT INTO chats (session_id, remote_jid, contact_name) VALUES (?, ?, ?)',
                [sessionId, remoteJid, contactName]
            );
            return { id: res.insertId, session_id: sessionId, remote_jid: remoteJid, contact_name: contactName };
        }
        
        // PREFERIR @lid: Si el JID actual es @c.us y el guardado es @lid, NO actualizar (mantener @lid)
        // Solo actualizar si el guardado es @c.us y el nuevo es @lid (actualizar a @lid)
        const savedJid = chats[0].remote_jid;
        if (remoteJid.includes('@lid') && !savedJid.includes('@lid')) {
            await this.pool.execute(
                'UPDATE chats SET remote_jid = ? WHERE id = ?',
                [remoteJid, chats[0].id]
            );
            chats[0].remote_jid = remoteJid;
        }
        
        // Actualizar nombre del contacto si cambió
        if (contactName && chats[0].contact_name !== contactName) {
            await this.pool.execute(
                'UPDATE chats SET contact_name = ? WHERE id = ?',
                [contactName, chats[0].id]
            );
            chats[0].contact_name = contactName;
        }
        
        return chats[0];
    }

    async saveMessage(sessionId, remoteJid, fromMe, body, type = 'chat', whatsappId, contactName = null) {
        const chat = await this.getOrCreateChat(sessionId, remoteJid, contactName);
        
        // Verificar si el mensaje ya existe
        const [existing] = await this.pool.execute(
            'SELECT id FROM messages WHERE whatsapp_id = ?',
            [whatsappId]
        );
        
        if (existing.length > 0) return chat.id;

        // Insertar mensaje
        await this.pool.execute(
            'INSERT INTO messages (chat_id, whatsapp_id, from_me, body, type) VALUES (?, ?, ?, ?, ?)',
            [chat.id, whatsappId, fromMe, body, type]
        );

        // Actualizar último mensaje del chat
        await this.pool.execute(
            'UPDATE chats SET last_message_body = ?, last_message_time = NOW(), unread_count = unread_count + ? WHERE id = ?',
            [body, fromMe ? 0 : 1, chat.id]
        );
        
        return chat.id;
    }

    // Obtener chats por sesión (con filtros según rol)
    async getChatsBySession(sessionId, userId = null, role = null) {
        let query = `
            SELECT c.*, 
                   u.full_name as assigned_name,
                   (SELECT COUNT(*) FROM messages WHERE chat_id = c.id) as message_count
            FROM chats c
            LEFT JOIN users u ON c.assigned_to = u.id
            WHERE c.session_id = ?
        `;
        const params = [sessionId];

        // Si es ejecutivo, solo ve sus chats asignados
        if (role === 'executive' && userId) {
            query += ' AND c.assigned_to = ?';
            params.push(userId);
        }

        query += ' ORDER BY c.last_message_time DESC';
        
        const [rows] = await this.pool.execute(query, params);
        return rows;
    }

    // Obtener todos los chats de una empresa
    async getChatsByCompany(companyId, userId = null, role = null) {
        let query = `
            SELECT c.*, 
                   ws.session_name,
                   ws.phone_number as session_phone,
                   u.full_name as assigned_name
            FROM chats c
            JOIN whatsapp_sessions ws ON c.session_id = ws.id
            LEFT JOIN users u ON c.assigned_to = u.id
            WHERE ws.company_id = ?
        `;
        const params = [companyId];

        if (role === 'executive' && userId) {
            query += ' AND c.assigned_to = ?';
            params.push(userId);
        }

        query += ' ORDER BY c.last_message_time DESC';
        
        const [rows] = await this.pool.execute(query, params);
        return rows;
    }

    // Obtener historial de mensajes de un chat
    async getChatMessages(chatId, limit = 100) {
        // LIMIT no funciona bien como parámetro en prepared statements
        // Usamos parseInt para asegurar que es un número válido
        const safeLimit = parseInt(limit) || 100;
        const [rows] = await this.pool.execute(`
            SELECT * FROM messages 
            WHERE chat_id = ?
            ORDER BY timestamp ASC
            LIMIT ${safeLimit}
        `, [chatId]);
        return rows;
    }

    // Asignar chat a un ejecutivo
    async assignChat(chatId, userId) {
        await this.pool.execute(
            'UPDATE chats SET assigned_to = ? WHERE id = ?',
            [userId, chatId]
        );
        return true;
    }

    // Marcar chat como leído
    async markChatAsRead(chatId) {
        await this.pool.execute(
            'UPDATE chats SET unread_count = 0 WHERE id = ?',
            [chatId]
        );
        return true;
    }

    // Obtener estadísticas del dashboard
    async getDashboardStats(companyId = null) {
        let companyFilter = companyId ? 'WHERE ws.company_id = ?' : '';
        let params = companyId ? [companyId] : [];

        const [sessionStats] = await this.pool.execute(`
            SELECT 
                COUNT(*) as total_sessions,
                SUM(CASE WHEN status = 'connected' THEN 1 ELSE 0 END) as connected_sessions
            FROM whatsapp_sessions ws
            ${companyFilter}
        `, params);

        companyFilter = companyId ? 'WHERE company_id = ?' : '';
        const [userStats] = await this.pool.execute(`
            SELECT 
                COUNT(*) as total_users,
                SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) as admin_count,
                SUM(CASE WHEN role = 'executive' THEN 1 ELSE 0 END) as executive_count
            FROM users
            ${companyFilter}
        `, params);

        const chatFilter = companyId ? 'WHERE ws.company_id = ?' : '';
        const [chatStats] = await this.pool.execute(`
            SELECT 
                COUNT(*) as total_chats,
                SUM(c.unread_count) as total_unread
            FROM chats c
            JOIN whatsapp_sessions ws ON c.session_id = ws.id
            ${chatFilter}
        `, params);

        return {
            sessions: sessionStats[0],
            users: userStats[0],
            chats: chatStats[0]
        };
    }
}

module.exports = new Database();
