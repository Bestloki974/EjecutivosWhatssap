// src/sessionManager.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const config = require('./config');
const database = require('./database');

class SessionManager {
    constructor() {
        this.clients = new Map();
    }

    // Inicializar todas las sesiones guardadas en la DB al arrancar
    async initializeSavedSessions() {
        console.log('🔄 Cargando sesiones desde la base de datos...');
        try {
            const sessions = await database.getAllSessions();
            
            if (sessions.length === 0) {
                console.log('ℹ️ No hay sesiones guardadas para reconectar.');
                return;
            }

            console.log(`📱 Encontradas ${sessions.length} sesiones. Reconectando...`);
            
            for (const session of sessions) {
                try {
                    console.log(`🔄 Reconectando sesión: ${session.session_name}`);
                    await this.createSession(session.session_name, session.company_id, session.user_id);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                } catch (err) {
                    console.error(`❌ Error reconectando ${session.session_name}:`, err.message);
                }
            }
            
            console.log('✅ Proceso de reconexión iniciado.');
        } catch (error) {
            console.error('Error cargando sesiones:', error);
        }
    }

    // Extraer número para mostrar (NO modifica el JID original)
    extractDisplayPhone(jid, contact = null) {
        // Si tenemos el contacto con número, usarlo para mostrar
        if (contact) {
            if (contact.number) {
                return contact.number;
            }
            if (contact.id && contact.id.user && !contact.id.user.includes(':')) {
                return contact.id.user;
            }
        }
        
        // Extraer solo el número del JID para mostrar
        if (jid) {
            return jid.replace(/@.*$/, '');
        }
        
        return null;
    }

    // Crear o recuperar un cliente de WhatsApp
    async createSession(sessionName, companyId, userId = null) {
        // Evitar crear múltiples clientes para la misma sesión
        if (this.clients.has(sessionName)) {
            const existing = this.clients.get(sessionName);
            if (existing.status === 'connected' || existing.status === 'initializing') {
                console.log(`⚠️ Sesión ${sessionName} ya está activa`);
                return existing;
            }
        }

        console.log(`📱 Iniciando sesión: ${sessionName} (Empresa: ${companyId})`);

        const client = new Client({
            authStrategy: new LocalAuth({
                clientId: sessionName,
                dataPath: '.wwebjs_auth'
            }),
            puppeteer: config.WHATSAPP.puppeteer
        });

        // Guardar referencia en memoria
        this.clients.set(sessionName, {
            client,
            companyId,
            userId,
            qr: null,
            status: 'initializing'
        });

        // Eventos del Cliente
        client.on('qr', async (qr) => {
            console.log(`📲 QR Recibido para ${sessionName}`);
            const sessionData = this.clients.get(sessionName);
            if (sessionData) {
                sessionData.qr = qr;
                sessionData.status = 'qr_ready';
            }
            
            await database.pool.execute(
                'UPDATE whatsapp_sessions SET qr_code = ?, status = "connecting" WHERE session_name = ?',
                [qr, sessionName]
            );

            // Notificar al frontend
            if (global.io) {
                global.io.to(`company_${companyId}`).emit('qr_update', { sessionName, qr });
            }
        });

        client.on('ready', async () => {
            console.log(`✅ Sesión lista: ${sessionName}`);
            const sessionData = this.clients.get(sessionName);
            if (sessionData) {
                sessionData.qr = null;
                sessionData.status = 'connected';
            }
            
            const info = client.info;
            const phone = info.wid.user;
            const pushName = info.pushname;

            await database.pool.execute(
                'UPDATE whatsapp_sessions SET status = "connected", qr_code = NULL, phone_number = ?, push_name = ? WHERE session_name = ?',
                [phone, pushName, sessionName]
            );

            // Notificar al frontend
            if (global.io) {
                global.io.to(`company_${companyId}`).emit('session_connected', { sessionName, phone });
            }
        });

        // Evento para TODOS los mensajes (enviados y recibidos)
        client.on('message_create', async (msg) => {
            try {
                const dbSession = await database.getSessionByName(sessionName);
                if (!dbSession) return;

                // Determinar el JID del chat (remoto) - USAR EL ORIGINAL
                const chatJid = msg.fromMe ? msg.to : msg.from;
                
                // Ignorar mensajes de grupos por ahora
                if (chatJid.includes('@g.us')) return;

                // Obtener info del contacto para mostrar
                let contactName = null;
                let displayPhone = null;
                
                try {
                    const chat = await msg.getChat();
                    contactName = chat.name || null;
                    displayPhone = this.extractDisplayPhone(chatJid, null);
                } catch (e) {
                    try {
                        const contact = await msg.getContact();
                        contactName = contact.pushname || contact.name || null;
                        displayPhone = this.extractDisplayPhone(chatJid, contact);
                    } catch (e2) {}
                }

                console.log(`📩 ${msg.fromMe ? '➡️ Enviado' : '⬅️ Recibido'}: "${msg.body?.substring(0, 30)}..." | JID: ${chatJid}`);

                // Guardar mensaje con el JID ORIGINAL (necesario para enviar)
                const chatId = await database.saveMessage(
                    dbSession.id,
                    chatJid,  // Usar JID original, NO modificado
                    msg.fromMe,
                    msg.body,
                    msg.type || 'chat',
                    msg.id._serialized,
                    contactName
                );

                // Emitir evento por Socket.IO para actualización en tiempo real
                if (global.io) {
                    const messageData = {
                        chatId,
                        sessionId: dbSession.id,
                        companyId: dbSession.company_id,
                        remoteJid: chatJid,
                        displayPhone,
                        contactName,
                        fromMe: msg.fromMe,
                        body: msg.body,
                        type: msg.type || 'chat',
                        timestamp: new Date().toISOString()
                    };

                    // Emitir a la empresa
                    global.io.to(`company_${dbSession.company_id}`).emit('new_message', messageData);
                    
                    // Emitir al chat específico
                    global.io.to(`chat_${chatId}`).emit('chat_message', messageData);
                }
            } catch (error) {
                console.error('Error procesando mensaje:', error.message);
            }
        });

        client.on('disconnected', async (reason) => {
            console.log(`❌ Sesión desconectada: ${sessionName}`, reason);
            this.clients.delete(sessionName);
            
            await database.pool.execute(
                'UPDATE whatsapp_sessions SET status = "disconnected" WHERE session_name = ?',
                [sessionName]
            );

            if (global.io) {
                global.io.to(`company_${companyId}`).emit('session_disconnected', { sessionName, reason });
            }
        });

        client.on('auth_failure', async (msg) => {
            console.error(`❌ Fallo de autenticación: ${sessionName}`, msg);
            this.clients.delete(sessionName);
        });

        // Inicializar
        client.initialize();
        
        // Registrar en DB si no existe
        await database.saveSession(sessionName, companyId, 'connecting');

        return this.clients.get(sessionName);
    }

    getClient(sessionName) {
        return this.clients.get(sessionName);
    }
    
    async logoutSession(sessionName) {
        const session = this.clients.get(sessionName);
        if (session && session.client) {
            try {
                await session.client.logout();
                await session.client.destroy();
            } catch (e) {
                console.error('Error cerrando sesión:', e.message);
            }
            this.clients.delete(sessionName);
            await database.pool.execute(
                'UPDATE whatsapp_sessions SET status = "disconnected", qr_code = NULL WHERE session_name = ?',
                [sessionName]
            );
            return true;
        }
        return false;
    }

    async regenerateSession(sessionName) {
        const fs = require('fs');
        const path = require('path');
        
        try {
            // 1. Primero cerrar la sesión si está activa
            const session = this.clients.get(sessionName);
            if (session && session.client) {
                try {
                    await session.client.logout();
                    await session.client.destroy();
                } catch (e) {
                    console.log('Sesión no estaba conectada:', e.message);
                }
                this.clients.delete(sessionName);
            }

            // 2. Eliminar carpeta de autenticación local
            const authPath = path.join(process.cwd(), '.wwebjs_auth', `session-${sessionName}`);
            if (fs.existsSync(authPath)) {
                fs.rmSync(authPath, { recursive: true, force: true });
                console.log(`🗑️ Carpeta de autenticación eliminada: ${authPath}`);
            }

            // 3. Actualizar estado en DB
            await database.pool.execute(
                'UPDATE whatsapp_sessions SET status = "disconnected", qr_code = NULL WHERE session_name = ?',
                [sessionName]
            );

            console.log(`🔄 Sesión ${sessionName} regenerada. Lista para nuevo QR.`);
            return true;
        } catch (error) {
            console.error('Error regenerando sesión:', error);
            return false;
        }
    }
}

module.exports = new SessionManager();
