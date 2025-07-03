// server.js - DETECCIÓN REAL SIN PATRONES
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cors = require('cors');

const app = express();
const PORT = 3001;

// Middleware
app.use(express.json());
app.use(cors());

// Variables globales
let clients = new Map();
let activeSessionId = null;
let messageCounters = new Map();
let savedSessions = new Set();

// 🆕 TRACKING REAL DE ENTREGAS
let messageTracking = new Map(); // messageId -> tracking data
let invalidNumbers = new Set(); // números confirmados como inválidos
let pendingVerifications = new Map(); // phone -> timeout

// AGREGAR ESTAS LÍNEAS DESPUÉS DE: let pendingVerifications = new Map();

const mysql = require('mysql2/promise');
const webhookHandler = require('./webhook-handler');

// 🆕 CONFIGURACIÓN DE BASE DE DATOS
const DB_CONFIG = {
    host: 'localhost',
    user: 'root',  // Ajusta según tu configuración
    password: '',  // Ajusta según tu configuración
    database: 'messagehub'
};

// 🆕 NUEVAS VARIABLES PARA RESPUESTAS
let receivedResponses = new Map(); // phone -> latest response
let realTimeUpdates = []; // Log de actualizaciones en tiempo real

console.log('🚀 Iniciando servidor WhatsApp con DETECCIÓN REAL...');

function getCurrentDate() {
    return new Date().toISOString().split('T')[0];
}

// 🆕 FUNCIÓN PARA CONECTAR A LA BASE DE DATOS
async function connectDB() {
    try {
        const connection = await mysql.createConnection(DB_CONFIG);
        return connection;
    } catch (error) {
        console.error('❌ Error conectando a la base de datos:', error.message);
        return null;
    }
}

// 🆕 FUNCIÓN PARA GUARDAR RESPUESTA RECIBIDA EN DB
async function saveResponseToDB(phone, responseText, messageId = null) {
    const connection = await connectDB();
    if (!connection) return false;
    
    try {
        const findQuery = `
            SELECT id, campaign_id 
            FROM message_logs 
            WHERE phone = ? 
            AND status IN ('sent', 'delivered')
            ORDER BY sent_at DESC 
            LIMIT 1
        `;
        
        const [rows] = await connection.execute(findQuery, [phone]);
        
        if (rows.length > 0) {
            const messageLogId = rows[0].id;
            
            const updateQuery = `
                UPDATE message_logs 
                SET response_received = 1,
                    response_text = ?,
                    response_at = NOW(),
                    replied_at = NOW()
                WHERE id = ?
            `;
            
            await connection.execute(updateQuery, [responseText, messageLogId]);
            
            console.log(`📨 Respuesta guardada en DB para ${phone}: ${responseText.substring(0, 50)}...`);
            addRealTimeUpdate('response_received', phone, `Respuesta: ${responseText.substring(0, 30)}...`);
            
            return true;
        }
        
        return false;
        
    } catch (error) {
        console.error(`❌ Error guardando respuesta para ${phone}:`, error.message);
        return false;
    } finally {
        await connection.end();
    }
}

// 🆕 FUNCIÓN PARA AGREGAR ACTUALIZACIONES EN TIEMPO REAL
function addRealTimeUpdate(type, phone, message, extra = {}) {
    const update = {
        timestamp: new Date().toISOString(),
        type: type,
        phone: phone,
        message: message,
        ...extra
    };
    
    realTimeUpdates.unshift(update);
    if (realTimeUpdates.length > 100) {
        realTimeUpdates = realTimeUpdates.slice(0, 100);
    }
    
    const emoji = {
        'sent': '📤',
        'delivered': '✅',
        'read': '👁️',
        'response_received': '📨',
        'invalid_detected': '❌',
        'error': '⚠️'
    };
    
    console.log(`${emoji[type] || '📊'} [TIEMPO REAL] ${phone}: ${message}`);
}

// 🆕 FUNCIÓN PARA PROCESAR RESPUESTA RECIBIDA
async function processReceivedResponse(phone, messageText, messageInfo) {
    console.log(`📨 RESPUESTA RECIBIDA de ${phone}: ${messageText}`);
    
    receivedResponses.set(phone, {
        text: messageText,
        timestamp: new Date().toISOString(),
        messageInfo: messageInfo
    });
    
    await saveResponseToDB(phone, messageText, messageInfo.id);
    addRealTimeUpdate('response_received', phone, messageText.substring(0, 50) + (messageText.length > 50 ? '...' : ''));
}

// 🆕 FUNCIÓN PARA VERIFICAR NÚMERO REAL EN WHATSAPP
async function verifyNumberInWhatsApp(client, phone) {
    try {
        console.log(`🔍 Verificando si ${phone} existe en WhatsApp...`);
        
        const cleanPhone = phone.replace(/[^0-9]/g, '');
        const chatId = cleanPhone + '@c.us';
        
        // MÉTODO 1: Verificar si el número está registrado en WhatsApp
        const numberId = await client.getNumberId(chatId);
        
        if (numberId === null) {
            console.log(`❌ ${phone} NO está registrado en WhatsApp`);
            return { exists: false, method: 'getNumberId', reason: 'No registrado en WhatsApp' };
        }
        
        // MÉTODO 2: Intentar obtener información del contacto
        try {
            const contact = await client.getContactById(chatId);
            if (contact && contact.isWAContact) {
                console.log(`✅ ${phone} confirmado como contacto de WhatsApp`);
                return { exists: true, method: 'getContactById', contact: contact };
            }
        } catch (contactError) {
            console.log(`⚠️ ${phone} - Error obteniendo contacto: ${contactError.message}`);
        }
        
        // MÉTODO 3: Si getNumberId devuelve algo pero getContact falla, es sospechoso
        console.log(`⚠️ ${phone} - Registrado pero sin contacto válido`);
        return { exists: false, method: 'suspicious', reason: 'Registrado pero inaccesible' };
        
    } catch (error) {
        console.log(`❌ Error verificando ${phone}: ${error.message}`);
        return { exists: false, method: 'error', reason: error.message };
    }
}

// 🆕 FUNCIÓN PARA MARCAR NÚMERO COMO INVÁLIDO CON RAZÓN REAL
function markNumberAsInvalid(phone, reason, method = 'auto') {
    invalidNumbers.add(phone);
    addRealTimeUpdate('invalid_detected', phone, reason, { method: method });
    console.log(`❌ NÚMERO INVÁLIDO DETECTADO: ${phone}`);
    console.log(`   📋 Razón: ${reason}`);
    console.log(`   🔧 Método: ${method}`);
    console.log(`   ⏰ Timestamp: ${new Date().toISOString()}`);
}
// 🆕 FUNCIÓN PARA ANALIZAR ENTREGA EN TIEMPO REAL
function analyzeDeliveryStatus(messageId, ackStatus, phone, sessionId) {
    const tracking = messageTracking.get(messageId);
    if (!tracking) return;
    
    const now = Date.now();
    const timeSinceSent = now - tracking.sentTime;
    const minutesElapsed = Math.floor(timeSinceSent / (1000 * 60));
    
    switch (ackStatus) {
        case 1: // Enviado al servidor WhatsApp
            console.log(`📤 [${sessionId}] ${phone}: Enviado al servidor (${minutesElapsed}min)`);
            addRealTimeUpdate('sent', phone, `Enviado al servidor (${minutesElapsed}min)`);
            tracking.serverTime = now;
            
            // Si después de 10 minutos sigue en estado "servidor", es problemático
            setTimeout(() => {
                const currentTracking = messageTracking.get(messageId);
                if (currentTracking && currentTracking.finalStatus === 1) {
                    console.log(`⚠️ [${sessionId}] ${phone}: STUCK en servidor después de 10min`);
                    markNumberAsInvalid(phone, 'Mensaje atascado en servidor WhatsApp por más de 10 minutos', 'timeout_server');
                }
            }, 10 * 60 * 1000); // 10 minutos
            break;
            
        case 2: // Entregado al dispositivo
            console.log(`✅ [${sessionId}] ${phone}: ENTREGADO al dispositivo (${minutesElapsed}min)`);
            addRealTimeUpdate('delivered', phone, `Entregado al dispositivo (${minutesElapsed}min)`);
            tracking.deliveredTime = now;
            tracking.deliveryTime = timeSinceSent;
            
            // Si se entregó, es un número válido
            if (invalidNumbers.has(phone)) {
                console.log(`🔄 [${sessionId}] ${phone}: Removiendo de inválidos - se entregó correctamente`);
                invalidNumbers.delete(phone);
            }
            break;
            
        case 3: // Leído por el usuario
            console.log(`👁️ [${sessionId}] ${phone}: LEÍDO por usuario (${minutesElapsed}min)`);
            addRealTimeUpdate('read', phone, `Mensaje leído por usuario (${minutesElapsed}min)`);
            tracking.readTime = now;
            break;
    }
    
    tracking.finalStatus = ackStatus;
    tracking.lastUpdate = now;
    messageTracking.set(messageId, tracking);
}

function loadSavedSessions() {
    try {
        const fs = require('fs');
        const sessionDirs = fs.readdirSync('.').filter(dir => {
            try {
                const stat = fs.statSync(dir);
                return stat.isDirectory() && dir.startsWith('.wwebjs_auth');
            } catch (e) {
                return false;
            }
        });
        
        sessionDirs.forEach(dir => {
            const match = dir.match(/\.wwebjs_auth[\/\\]session-messagehub-(.+)/);
            if (match) {
                const sessionId = match[1];
                savedSessions.add(sessionId);
                console.log(`📂 Sesión encontrada: ${sessionId}`);
            } else if (dir.includes('messagehub-')) {
                const sessionId = dir.split('messagehub-')[1];
                savedSessions.add(sessionId);
                console.log(`📂 Sesión encontrada: ${sessionId}`);
            }
        });
        
        if (savedSessions.size === 0) {
            savedSessions.add('principal');
            console.log('🆕 Creando sesión principal por defecto');
        }
        
        console.log(`📊 Total sesiones para cargar: ${savedSessions.size}`);
        
    } catch (error) {
        console.log('⚠️ Error cargando sesiones guardadas:', error.message);
        savedSessions.add('principal');
    }
}

function getMessageCount(sessionId) {
    const today = getCurrentDate();
    const counter = messageCounters.get(sessionId);
    
    if (!counter || counter.date !== today) {
        messageCounters.set(sessionId, { date: today, count: 0 });
        return 0;
    }
    
    return counter.count;
}

function incrementMessageCount(sessionId) {
    const today = getCurrentDate();
    const counter = messageCounters.get(sessionId);
    
    if (!counter || counter.date !== today) {
        messageCounters.set(sessionId, { date: today, count: 1 });
    } else {
        counter.count += 1;
        messageCounters.set(sessionId, counter);
    }
    
    const newCount = messageCounters.get(sessionId).count;
    console.log(`📊 [${sessionId}] Mensajes hoy: ${newCount}`);
    return newCount;
}

function createClient(sessionId) {
    console.log(`🔄 Creando cliente para sesión: ${sessionId}`);
    
    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: `messagehub-${sessionId}`
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        }
    });

    const sessionData = {
        client: client,
        isReady: false,
        qrCode: null,
        clientInfo: null,
        sessionId: sessionId
    };

    clients.set(sessionId, sessionData);
    savedSessions.add(sessionId);
    
    if (!messageCounters.has(sessionId)) {
        messageCounters.set(sessionId, { date: getCurrentDate(), count: 0 });
    }
    
    setupClientEvents(sessionId);
    
    return sessionData;
}

// 🆕 EVENTOS MEJORADOS PARA DETECCIÓN REAL
function setupClientEvents(sessionId) {
    const sessionData = clients.get(sessionId);
    if (!sessionData) return;
    
    const client = sessionData.client;

    client.on('qr', (qr) => {
        console.log(`\n📱 QR generado para sesión ${sessionId}:`);
        qrcode.generate(qr, { small: true });
        sessionData.qrCode = qr;
        sessionData.isReady = false;
        console.log(`⏳ Esperando escaneo para ${sessionId}...\n`);
    });

    client.on('ready', () => {
        console.log(`✅ Sesión ${sessionId} conectada y lista!`);
        sessionData.isReady = true;
        sessionData.qrCode = null;
        sessionData.clientInfo = client.info;
        
        console.log(`📱 ${sessionId} - Usuario: ${sessionData.clientInfo.pushname}`);
        console.log(`📞 ${sessionId} - Número: ${sessionData.clientInfo.wid.user}`);
        
        if (!activeSessionId) {
            activeSessionId = sessionId;
            console.log(`🎯 Sesión activa por defecto: ${sessionId}`);
        }
        // 🆕 AGREGAR WEBHOOK LISTENERS
            webhookHandler.addWebhookListeners(client, sessionId);
    });

    client.on('authenticated', () => {
        console.log(`🔐 Sesión ${sessionId} autenticada`);
    });

    client.on('auth_failure', (msg) => {
        console.error(`❌ Error autenticación ${sessionId}:`, msg);
        sessionData.isReady = false;
        sessionData.qrCode = null;
    });

    client.on('disconnected', (reason) => {
        console.log(`🔌 Sesión ${sessionId} desconectada:`, reason);
        sessionData.isReady = false;
        sessionData.clientInfo = null;
        
        if (activeSessionId === sessionId) {
            const availableSession = Array.from(clients.entries())
                .find(([id, data]) => id !== sessionId && data.isReady);
            
            if (availableSession) {
                activeSessionId = availableSession[0];
                console.log(`🔄 Cambiando sesión activa a: ${activeSessionId}`);
            } else {
                activeSessionId = null;
            }
        }
        
        setTimeout(() => {
            console.log(`🔄 Reconectando sesión ${sessionId}...`);
            client.initialize();
        }, 5000);
    });

    // 🆕 TRACKING REAL DE MENSAJES ENVIADOS
    client.on('message_create', async (message) => {
        if (message.fromMe) {
            const messageId = message.id.id;
            const phone = message.to.replace('@c.us', '');
            
            console.log(`📤 [${sessionId}] MENSAJE CREADO: ${messageId} -> ${phone}`);
            
            // Inicializar tracking
            messageTracking.set(messageId, {
                phone: phone,
                sessionId: sessionId,
                sentTime: Date.now(),
                body: message.body.substring(0, 50) + '...',
                finalStatus: 0,
                serverTime: null,
                deliveredTime: null,
                readTime: null
            });
        }
    });

    // 🆕 EVENTO CRÍTICO: ESTADOS DE ENTREGA REALES
    client.on('message_ack', async (message, ack) => {
        if (message.fromMe) {
            const messageId = message.id.id;
            const phone = message.to.replace('@c.us', '');
            
            console.log(`📊 [${sessionId}] ACK RECIBIDO: ${messageId} -> ${phone} (Estado: ${ack})`);
            
            analyzeDeliveryStatus(messageId, ack, phone, sessionId);
        }
    });

    // 🆕 DETECTAR ERRORES DE ENVÍO DIRECTOS
    client.on('message_revoke_everyone', async (after, before) => {
        if (before && before.fromMe) {
            const phone = before.to.replace('@c.us', '');
            console.log(`🔄 [${sessionId}] MENSAJE REVOCADO: ${phone} - Posible número inválido`);
            markNumberAsInvalid(phone, 'Mensaje revocado automáticamente', 'message_revoke');
        }
    });

    client.on('message', async (message) => {
        try {
            // Solo procesar mensajes recibidos (no enviados por nosotros)
            if (!message.fromMe && message.from.endsWith('@c.us')) {
                const fromPhone = message.from.replace('@c.us', '');
                const messageText = message.body;
                
                console.log(`📨 [${sessionId}] RESPUESTA RECIBIDA de +${fromPhone}: ${messageText}`);
                
                // Procesar la respuesta
                await processReceivedResponse('+' + fromPhone, messageText, message);
            }
        } catch (error) {
            console.error('❌ Error procesando mensaje recibido:', error);
        }
    });
}

function autoInitializeSessions() {
    console.log('🔄 Auto-inicializando sesiones guardadas...');
    
    let delay = 0;
    for (const sessionId of savedSessions) {
        setTimeout(() => {
            console.log(`🚀 Inicializando sesión: ${sessionId}`);
            const sessionData = createClient(sessionId);
            sessionData.client.initialize();
        }, delay);
        delay += 2000;
    }
}

// ==========================================
// 🆕 RUTAS API PARA DETECCIÓN REAL
// ==========================================

// ==========================================
// 🆕 RUTAS API PARA DETECCIÓN REAL + RESPUESTAS
// ==========================================

// 🆕 Verificar número con métodos reales de WhatsApp
app.post('/verify-number-real', async (req, res) => {
    try {
        const { phone, sessionId } = req.body;
        
        if (!phone) {
            return res.status(400).json({ success: false, error: 'phone requerido' });
        }
        
        const targetSessionId = sessionId || activeSessionId;
        if (!targetSessionId) {
            return res.status(400).json({ success: false, error: 'No hay sesión activa' });
        }
        
        const sessionData = clients.get(targetSessionId);
        if (!sessionData?.isReady) {
            return res.status(400).json({ success: false, error: 'Sesión no está lista' });
        }
        
        const cleanPhone = phone.replace(/[^0-9+]/g, '');
        
        console.log(`🔍 [${targetSessionId}] Verificación REAL iniciada para: ${cleanPhone}`);
        
        // Verificación real con WhatsApp
        const verification = await verifyNumberInWhatsApp(sessionData.client, cleanPhone);
        
        // Si no existe, marcarlo como inválido
        if (!verification.exists) {
            markNumberAsInvalid(cleanPhone, verification.reason, verification.method);
        }
        
        res.json({
            success: true,
            phone: cleanPhone,
            exists: verification.exists,
            method: verification.method,
            reason: verification.reason,
            isKnownInvalid: invalidNumbers.has(cleanPhone),
            sessionId: targetSessionId,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Error verificando número:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🆕 Obtener respuestas recibidas
app.get('/responses', (req, res) => {
    try {
        const responsesList = Array.from(receivedResponses.entries()).map(([phone, response]) => ({
            phone: phone,
            text: response.text,
            timestamp: response.timestamp,
            messageInfo: response.messageInfo
        }));
        
        res.json({
            success: true,
            responses: responsesList,
            total: responsesList.length,
            lastUpdate: new Date().toISOString()
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🆕 Obtener actualizaciones en tiempo real
app.get('/realtime-updates', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        
        res.json({
            success: true,
            updates: realTimeUpdates.slice(0, limit),
            total: realTimeUpdates.length,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🆕 Estadísticas de detección real CON RESPUESTAS
app.get('/detection-stats', (req, res) => {
    try {
        const invalidList = Array.from(invalidNumbers);
        const trackingStats = Array.from(messageTracking.values());
        const responsesList = Array.from(receivedResponses.entries()).map(([phone, response]) => ({
            phone: phone,
            text: response.text,
            timestamp: response.timestamp
        }));
        
        // Estadísticas de entrega
        const deliveryStats = {
            total: trackingStats.length,
            delivered: trackingStats.filter(t => t.finalStatus >= 2).length,
            stuckInServer: trackingStats.filter(t => t.finalStatus === 1).length,
            noResponse: trackingStats.filter(t => t.finalStatus === 0).length
        };
        
        // Estadísticas de tiempo de entrega
        const deliveredMessages = trackingStats.filter(t => t.deliveredTime);
        const avgDeliveryTime = deliveredMessages.length > 0 
            ? deliveredMessages.reduce((sum, t) => sum + t.deliveryTime, 0) / deliveredMessages.length
            : 0;
        
        res.json({
            success: true,
            invalidNumbers: invalidList,
            totalInvalid: invalidList.length,
            receivedResponses: responsesList,
            totalResponses: responsesList.length,
            deliveryStats: deliveryStats,
            averageDeliveryTime: Math.round(avgDeliveryTime / 1000), // segundos
            realTimeUpdates: realTimeUpdates.slice(0, 20), // Últimas 20 actualizaciones
            lastUpdate: new Date().toISOString()
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🆕 Obtener estadísticas de detección real
app.get('/detection-stats', (req, res) => {
    try {
        const invalidList = Array.from(invalidNumbers);
        const trackingStats = Array.from(messageTracking.values());
        
        // Estadísticas de entrega
        const deliveryStats = {
            total: trackingStats.length,
            delivered: trackingStats.filter(t => t.finalStatus >= 2).length,
            stuckInServer: trackingStats.filter(t => t.finalStatus === 1).length,
            noResponse: trackingStats.filter(t => t.finalStatus === 0).length
        };
        
        // Estadísticas de tiempo de entrega
        const deliveredMessages = trackingStats.filter(t => t.deliveredTime);
        const avgDeliveryTime = deliveredMessages.length > 0 
            ? deliveredMessages.reduce((sum, t) => sum + t.deliveryTime, 0) / deliveredMessages.length
            : 0;
        
        res.json({
            success: true,
            invalidNumbers: invalidList,
            totalInvalid: invalidList.length,
            deliveryStats: deliveryStats,
            averageDeliveryTime: Math.round(avgDeliveryTime / 1000), // segundos
            lastUpdate: new Date().toISOString()
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🆕 ENVÍO CON VERIFICACIÓN PREVIA REAL
app.post('/send-with-verification', async (req, res) => {
    try {
        const { phone, message, sessionId, skipVerification = false } = req.body;
        
        if (!phone || !message) {
            return res.status(400).json({ success: false, error: 'phone y message requeridos' });
        }
        
        const targetSessionId = sessionId || activeSessionId;
        if (!targetSessionId) {
            return res.status(400).json({ success: false, error: 'No hay sesión activa' });
        }
        
        const sessionData = clients.get(targetSessionId);
        if (!sessionData?.isReady) {
            return res.status(400).json({ success: false, error: 'Sesión no está lista' });
        }
        
        let cleanPhone = phone.replace(/[^0-9+]/g, '');
        if (!cleanPhone.startsWith('+')) {
            if (cleanPhone.startsWith('56')) {
                cleanPhone = '+' + cleanPhone;
            } else {
                cleanPhone = '+56' + cleanPhone;
            }
        }
        
        // Verificar si ya está en la lista de inválidos
        if (invalidNumbers.has(cleanPhone.replace('+', ''))) {
            return res.status(400).json({ 
                success: false, 
                error: 'Número confirmado como inválido por WhatsApp',
                phone: cleanPhone,
                suggestion: 'Este número fue detectado previamente como no válido'
            });
        }
        
        // Verificación previa opcional
        if (!skipVerification) {
            console.log(`🔍 [${targetSessionId}] Verificando ${cleanPhone} antes de enviar...`);
            const verification = await verifyNumberInWhatsApp(sessionData.client, cleanPhone);
            
            if (!verification.exists) {
                markNumberAsInvalid(cleanPhone.replace('+', ''), verification.reason, verification.method);
                return res.status(400).json({ 
                    success: false, 
                    error: 'Número no existe en WhatsApp',
                    phone: cleanPhone,
                    reason: verification.reason,
                    method: verification.method
                });
            }
        }
        
        const chatId = cleanPhone.substring(1) + '@c.us';
        
        console.log(`📤 [${targetSessionId}] Enviando a ${cleanPhone} (verificado)...`);
        
        try {
            const sentMessage = await sessionData.client.sendMessage(chatId, message);
            
            console.log(`✅ [${targetSessionId}] Enviado a ${cleanPhone}`);
            
            const messageCount = incrementMessageCount(targetSessionId);
            
            res.json({
                success: true,
                messageId: sentMessage.id.id,
                phone: cleanPhone,
                sessionId: targetSessionId,
                messagesCount: messageCount,
                verified: !skipVerification,
                timestamp: new Date().toISOString()
            });
            
        } catch (sendError) {
            console.log(`❌ [${targetSessionId}] Error enviando a ${cleanPhone}: ${sendError.message}`);
            
            // Si falla el envío, es muy probable que sea inválido
            markNumberAsInvalid(cleanPhone.replace('+', ''), sendError.message, 'send_error');
            
            res.status(500).json({ 
                success: false, 
                error: 'Error enviando mensaje',
                details: sendError.message,
                phone: cleanPhone,
                numberMarkedInvalid: true
            });
        }
        
    } catch (error) {
        console.error('❌ Error en envío con verificación:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// [RESTO DE RUTAS EXISTENTES - sin cambios]
app.get('/', (req, res) => {
    const sessionsHtml = Array.from(clients.entries()).map(([sessionId, data]) => {
        const status = data.isReady ? 'connected' : 'disconnected';
        const statusText = data.isReady ? '✅ Conectado' : (data.qrCode ? '📱 Esperando QR' : '🔄 Iniciando');
        const isActive = activeSessionId === sessionId ? ' (ACTIVA)' : '';
        const messageCount = getMessageCount(sessionId);
        
        return `
            <div class="session-card ${status}">
                <h3>📱 Sesión: ${sessionId}${isActive}</h3>
                <div class="status">${statusText}</div>
                <div class="message-counter">
                    📊 Mensajes hoy: <strong>${messageCount}</strong>
                </div>
                ${data.clientInfo ? `
                    <div class="info">
                        <strong>Usuario:</strong> ${data.clientInfo.pushname}<br>
                        <strong>Número:</strong> +${data.clientInfo.wid.user}
                    </div>
                ` : ''}
                ${data.qrCode ? `
                    <div class="qr-container">
                        <img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(data.qrCode)}" alt="QR ${sessionId}">
                    </div>
                ` : ''}
                <div class="session-actions">
                    ${data.isReady ? `
                        <button onclick="setActiveSession('${sessionId}')" ${activeSessionId === sessionId ? 'disabled' : ''}>
                            ${activeSessionId === sessionId ? '🎯 Activa' : '🔄 Activar'}
                        </button>
                        <button onclick="verifyNumberReal('${sessionId}')" class="verify-btn">🔍 Verificar Real</button>
                        <button onclick="resetCounter('${sessionId}')" class="reset-btn">🔄 Reset</button>
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');

    const invalidCount = invalidNumbers.size;

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>WhatsApp DETECCIÓN REAL - MessageHub</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
            .container { max-width: 1200px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .sessions-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin: 20px 0; }
            .session-card { border: 2px solid #ddd; border-radius: 10px; padding: 20px; text-align: center; }
            .session-card.connected { border-color: #28a745; background: #f8fff9; }
            .session-card.disconnected { border-color: #dc3545; background: #fff8f8; }
            .status { font-weight: bold; margin: 10px 0; }
            .connected .status { color: #28a745; }
            .disconnected .status { color: #dc3545; }
            .info { text-align: left; background: #f8f9fa; padding: 10px; border-radius: 5px; margin: 10px 0; }
            .qr-container { margin: 15px 0; }
            button { background: #007bff; color: white; border: none; padding: 8px 16px; border-radius: 5px; cursor: pointer; margin: 5px; }
            button:hover { background: #0056b3; }
            button:disabled { background: #6c757d; cursor: not-allowed; }
            .verify-btn { background: #17a2b8 !important; }
            .verify-btn:hover { background: #138496 !important; }
            .reset-btn { background: #ffc107 !important; color: #000 !important; }
            .message-counter { 
                background: #e3f2fd; 
                color: #1976d2; 
                padding: 8px; 
                border-radius: 5px; 
                margin: 10px 0; 
                font-weight: bold; 
            }
            .controls { text-align: center; margin: 20px 0; padding: 20px; background: #f8f9fa; border-radius: 10px; }
            .detection-summary { 
                background: #d4edda; 
                border: 1px solid #c3e6cb; 
                color: #155724; 
                padding: 10px; 
                border-radius: 5px; 
                margin: 10px 0; 
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🚀 WhatsApp DETECCIÓN REAL - Sin Patrones</h1>
            
            <div class="controls">
                <h3>🎯 Sesión Activa: ${activeSessionId || 'Ninguna'}</h3>
                <div class="detection-summary">
                    🔍 DETECCIÓN REAL ACTIVADA | 
                    ❌ Números inválidos detectados: <strong>${invalidCount}</strong>
                </div>
                <button onclick="verifyNumberReal()">🔍 Verificar Número</button>
                <button onclick="showDetectionStats()" style="background: #dc3545;">📊 Ver Estadísticas</button>
                <button onclick="sendWithVerification()" style="background: #28a745;">📱 Enviar Verificado</button>
                <button onclick="location.reload()">🔄 Actualizar</button>
            </div>
            
            <div class="sessions-grid">
                ${sessionsHtml || '<div class="session-card disconnected"><h3>📱 Sin sesiones</h3><p>Agrega un número para comenzar</p></div>'}
            </div>
            
            <h3>📡 Nuevos Endpoints (DETECCIÓN REAL):</h3>
            <div style="background: #e9ecef; padding: 10px; border-left: 4px solid #007bff; margin: 10px 0;">
                <strong>POST /verify-number-real</strong> - Verificación real con WhatsApp<br>
                <pre>{"phone": "+56222655410", "sessionId": "principal"}</pre>
            </div>
            <div style="background: #e9ecef; padding: 10px; border-left: 4px solid #007bff; margin: 10px 0;">
                <strong>POST /send-with-verification</strong> - Envío con verificación previa<br>
                <pre>{"phone": "+56912345678", "message": "Hola", "skipVerification": false}</pre>
            </div>
            <div style="background: #e9ecef; padding: 10px; border-left: 4px solid #007bff; margin: 10px 0;">
                <strong>GET /detection-stats</strong> - Estadísticas de detección real
            </div>
            
            <script>
                function verifyNumberReal(sessionId) {
                    const phone = prompt('Número a verificar REAL (ej: 56222655410):');
                    if (phone) {
                        fetch('/verify-number-real', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({phone: phone, sessionId: sessionId || '${activeSessionId}'})
                        })
                        .then(r => r.json())
                        .then(data => {
                            if (data.success) {
                                let result = data.exists ? '✅ NÚMERO VÁLIDO EN WHATSAPP' : '❌ NÚMERO NO EXISTE EN WHATSAPP';
                                result += '\\n\\nDetalles REALES:';
                                result += '\\n• Método: ' + data.method;
                                result += '\\n• Razón: ' + data.reason;
                                result += '\\n• Ya marcado como inválido: ' + (data.isKnownInvalid ? 'SÍ' : 'NO');
                                result += '\\n• Verificado con: ' + data.sessionId;
                                alert(result);
                                if (!data.exists) {
                                    location.reload(); // Actualizar para ver el número marcado
                                }
                            } else {
                                alert('❌ Error: ' + data.error);
                            }
                        })
                        .catch(e => alert('❌ Error: ' + e));
                    }
                }
                
                function showDetectionStats() {
                    fetch('/detection-stats')
                    .then(r => r.json())
                    .then(data => {
                        if (data.success) {
                            let message = '📊 ESTADÍSTICAS DE DETECCIÓN REAL\\n\\n';
                            message += '❌ Total números inválidos: ' + data.totalInvalid + '\\n\\n';
                            
                            if (data.invalidNumbers.length > 0) {
                                message += 'NÚMEROS CONFIRMADOS COMO INVÁLIDOS:\\n';
                                data.invalidNumbers.forEach(phone => {
                                    message += '• ' + phone + '\\n';
                                });
                                message += '\\n';
                            }
                            
                            message += 'ESTADÍSTICAS DE ENTREGA:\\n';
                            message += '• Total mensajes enviados: ' + data.deliveryStats.total + '\\n';
                            message += '• Entregados correctamente: ' + data.deliveryStats.delivered + '\\n';
                            message += '• Atascados en servidor: ' + data.deliveryStats.stuckInServer + '\\n';
                            message += '• Sin respuesta: ' + data.deliveryStats.noResponse + '\\n';
                            message += '• Tiempo promedio entrega: ' + data.averageDeliveryTime + ' segundos\\n\\n';
                            
                            if (data.totalInvalid === 0) {
                                message += '✅ No hay números inválidos detectados.';
                            }
                            
                            alert(message);
                        } else {
                            alert('❌ Error: ' + data.error);
                        }
                    })
                    .catch(e => alert('❌ Error: ' + e));
                }
                
                function sendWithVerification() {
                    const phone = prompt('Número destino:');
                    if (!phone) return;
                    
                    const message = prompt('Mensaje a enviar:');
                    if (!message) return;
                    
                    const verify = confirm('¿Verificar número antes de enviar?\\n\\nSÍ = Verificar con WhatsApp primero\\nNO = Enviar directamente');
                    
                    fetch('/send-with-verification', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            phone: phone,
                            message: message,
                            skipVerification: !verify
                        })
                    })
                    .then(r => r.json())
                    .then(data => {
                        if (data.success) {
                            let result = '✅ MENSAJE ENVIADO EXITOSAMENTE\\n\\n';
                            result += 'Número: ' + data.phone + '\\n';
                            result += 'Verificado previamente: ' + (data.verified ? 'SÍ' : 'NO') + '\\n';
                            result += 'ID del mensaje: ' + data.messageId + '\\n';
                            result += 'Mensajes enviados hoy: ' + data.messagesCount;
                            alert(result);
                            location.reload();
                        } else {
                            let error = '❌ ERROR ENVIANDO MENSAJE\\n\\n';
                            error += 'Error: ' + data.error + '\\n';
                            error += 'Número: ' + (data.phone || phone) + '\\n';
                            if (data.reason) {
                                error += 'Razón: ' + data.reason + '\\n';
                            }
                            if (data.numberMarkedInvalid) {
                                error += '\\n⚠️ El número fue marcado como INVÁLIDO automáticamente.';
                            }
                            alert(error);
                            if (data.numberMarkedInvalid) {
                                location.reload(); // Actualizar para ver el número marcado
                            }
                        }
                    })
                    .catch(e => alert('❌ Error: ' + e));
                }
                
                function setActiveSession(sessionId) {
                    fetch('/set-active-session', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({sessionId: sessionId})
                    })
                    .then(r => r.json())
                    .then(data => {
                        if (data.success) {
                            alert('✅ Sesión activa cambiada a: ' + sessionId);
                            location.reload();
                        } else {
                            alert('❌ Error: ' + data.error);
                        }
                    });
                }
                
                function resetCounter(sessionId) {
                    if (confirm('¿Reiniciar contador de mensajes para ' + sessionId + '?')) {
                        fetch('/reset-counter', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({sessionId: sessionId})
                        })
                        .then(r => r.json())
                        .then(data => {
                            alert(data.success ? '✅ Contador reiniciado' : '❌ Error: ' + data.error);
                            location.reload();
                        });
                    }
                }
                
                // Auto refresh cada 60 segundos para ver actualizaciones
                setTimeout(() => location.reload(), 60000);
            </script>
        </div>
    </body>
    </html>`;
    
    res.send(html);
});

// Rutas existentes sin cambios
app.get('/sessions', (req, res) => {
    const sessionsList = Array.from(clients.entries()).map(([sessionId, data]) => ({
        sessionId,
        isReady: data.isReady,
        isActive: activeSessionId === sessionId,
        messagesCount: getMessageCount(sessionId),
        clientInfo: data.clientInfo ? {
            name: data.clientInfo.pushname,
            number: data.clientInfo.wid.user
        } : null
    }));

    const totalMessagesToday = Array.from(messageCounters.values()).reduce((total, counter) => 
        counter.date === getCurrentDate() ? total + counter.count : total, 0);

    res.json({
        sessions: sessionsList,
        activeSession: activeSessionId,
        totalSessions: clients.size,
        date: getCurrentDate(),
        totalMessagesToday: totalMessagesToday
    });
});

app.get('/stats', (req, res) => {
    try {
        const today = getCurrentDate();
        const sessionStats = Array.from(clients.keys()).map(sessionId => ({
            sessionId,
            messagesCount: getMessageCount(sessionId),
            isReady: clients.get(sessionId)?.isReady || false
        }));
        
        const totalToday = sessionStats.reduce((total, session) => total + session.messagesCount, 0);
        
        res.json({
            date: today,
            totalToday,
            sessions: sessionStats,
            activeSession: activeSessionId
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/reset-counter', (req, res) => {
    try {
        const { sessionId } = req.body;
        
        if (!sessionId) {
            return res.status(400).json({ success: false, error: 'sessionId requerido' });
        }
        
        if (!clients.has(sessionId)) {
            return res.status(404).json({ success: false, error: 'Sesión no encontrada' });
        }
        
        messageCounters.set(sessionId, { date: getCurrentDate(), count: 0 });
        
        console.log(`🔄 Contador reiniciado para sesión: ${sessionId}`);
        
        res.json({ 
            success: true, 
            message: `Contador de ${sessionId} reiniciado`,
            newCount: 0
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/set-active-session', (req, res) => {
    try {
        const { sessionId } = req.body;
        
        if (!clients.has(sessionId)) {
            return res.status(404).json({ success: false, error: 'Sesión no encontrada' });
        }
        
        const sessionData = clients.get(sessionId);
        if (!sessionData.isReady) {
            return res.status(400).json({ success: false, error: 'Sesión no está lista' });
        }
        
        activeSessionId = sessionId;
        console.log(`🎯 Sesión activa cambiada a: ${sessionId}`);
        
        res.json({ success: true, activeSession: sessionId });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/status', (req, res) => {
    const activeSession = activeSessionId ? clients.get(activeSessionId) : null;
    
    res.json({
        ready: activeSession?.isReady || false,
        activeSession: activeSessionId,
        totalSessions: clients.size,
        readySessions: Array.from(clients.values()).filter(s => s.isReady).length,
        clientInfo: activeSession?.clientInfo ? {
            name: activeSession.clientInfo.pushname,
            number: activeSession.clientInfo.wid.user
        } : null
    });
});

// Ruta de envío regular (mantener para compatibilidad)
app.post('/send', async (req, res) => {
    try {
        if (!activeSessionId) {
            return res.status(400).json({ success: false, error: 'No hay sesión activa' });
        }
        
        const sessionData = clients.get(activeSessionId);
        if (!sessionData?.isReady) {
            return res.status(400).json({ success: false, error: 'Sesión activa no está lista' });
        }
        
        const { phone, message } = req.body;
        if (!phone || !message) {
            return res.status(400).json({ success: false, error: 'phone y message requeridos' });
        }
        
        let cleanPhone = phone.replace(/[^0-9+]/g, '');
        if (!cleanPhone.startsWith('+')) {
            if (cleanPhone.startsWith('56')) {
                cleanPhone = '+' + cleanPhone;
            } else {
                cleanPhone = '+56' + cleanPhone;
            }
        }
        
        // Verificar si ya está marcado como inválido
        if (invalidNumbers.has(cleanPhone.replace('+', ''))) {
            return res.status(400).json({ 
                success: false, 
                error: 'Número confirmado como inválido',
                phone: cleanPhone,
                suggestion: 'Use /send-with-verification para verificar antes de enviar'
            });
        }
        
        const chatId = cleanPhone.substring(1) + '@c.us';
        
        console.log(`📤 [${activeSessionId}] Enviando a ${cleanPhone}...`);
        
        try {
            const sentMessage = await sessionData.client.sendMessage(chatId, message);
            
            console.log(`✅ [${activeSessionId}] Enviado a ${cleanPhone}`);
            
            const messageCount = incrementMessageCount(activeSessionId);
            
            res.json({
                success: true,
                messageId: sentMessage.id.id,
                phone: cleanPhone,
                sessionId: activeSessionId,
                messagesCount: messageCount,
                timestamp: new Date().toISOString()
            });
            
        } catch (sendError) {
            console.log(`❌ [${activeSessionId}] Error enviando a ${cleanPhone}: ${sendError.message}`);
            markNumberAsInvalid(cleanPhone.replace('+', ''), sendError.message, 'send_error');
            
            res.status(500).json({ 
                success: false, 
                error: 'Error enviando mensaje - número marcado como inválido',
                details: sendError.message,
                phone: cleanPhone
            });
        }
        
    } catch (error) {
        console.error('❌ Error enviando:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});


// AGREGAR ESTAS RUTAS AL FINAL DE server.js, ANTES DE app.listen()

// 🆕 ENDPOINT PARA VERIFICAR ESTADO DE LECTURA DE MENSAJES
app.post('/check-message-read-status', async (req, res) => {
    try {
        const { phone, messageId } = req.body;
        
        if (!phone) {
            return res.status(400).json({ error: 'Teléfono requerido' });
        }

        // Obtener cliente activo
        const activeClient = getActiveClient();
        if (!activeClient || !activeClient.isReady) {
            return res.status(503).json({ 
                error: 'WhatsApp no conectado',
                ready: false 
            });
        }

        const client = activeClient.client;
        
        // Formatear número
        const formattedPhone = phone.replace('+', '') + '@c.us';
        
        try {
            // Obtener el chat
            const chat = await client.getChatById(formattedPhone);
            
            if (!chat) {
                return res.json({ 
                    read: false, 
                    reason: 'Chat no encontrado',
                    method: 'chat_lookup'
                });
            }

            // Si tenemos messageId específico, buscar ese mensaje
            if (messageId) {
                try {
                    const messages = await chat.fetchMessages({ limit: 50 });
                    const targetMessage = messages.find(msg => 
                        msg.fromMe && 
                        (msg.id.id === messageId || msg.body.includes(messageId))
                    );
                    
                    if (targetMessage) {
                        // Verificar ACK del mensaje específico
                        const ackStatus = targetMessage.ack;
                        const isRead = ackStatus === 4; // ACK 4 = leído
                        
                        console.log(`🔍 Verificando mensaje específico ${messageId} para ${phone}: ACK ${ackStatus} (Leído: ${isRead})`);
                        
                        return res.json({
                            read: isRead,
                            ack: ackStatus,
                            messageId: targetMessage.id.id,
                            method: 'specific_message_ack',
                            timestamp: Date.now()
                        });
                    }
                } catch (msgError) {
                    console.log(`⚠️ No se pudo encontrar mensaje específico: ${msgError.message}`);
                }
            }

            // Método alternativo: verificar últimos mensajes enviados por nosotros
            try {
                const messages = await chat.fetchMessages({ limit: 20 });
                const sentMessages = messages.filter(msg => msg.fromMe);
                
                if (sentMessages.length === 0) {
                    return res.json({ 
                        read: false, 
                        reason: 'No hay mensajes enviados en este chat',
                        method: 'no_sent_messages'
                    });
                }

                // Verificar el último mensaje enviado
                const lastSentMessage = sentMessages[0];
                const ackStatus = lastSentMessage.ack;
                const isRead = ackStatus === 4;
                
                console.log(`🔍 Verificando último mensaje para ${phone}: ACK ${ackStatus} (Leído: ${isRead})`);
                
                return res.json({
                    read: isRead,
                    ack: ackStatus,
                    messageId: lastSentMessage.id.id,
                    messagePreview: lastSentMessage.body.substring(0, 50),
                    method: 'last_message_ack',
                    timestamp: Date.now()
                });

            } catch (fetchError) {
                console.log(`⚠️ Error obteniendo mensajes: ${fetchError.message}`);
                
                return res.json({ 
                    read: false, 
                    reason: 'Error obteniendo historial de mensajes',
                    method: 'fetch_error',
                    error: fetchError.message
                });
            }

        } catch (chatError) {
            console.log(`⚠️ Error accediendo al chat ${phone}: ${chatError.message}`);
            
            return res.json({ 
                read: false, 
                reason: 'No se pudo acceder al chat',
                method: 'chat_error',
                error: chatError.message
            });
        }

    } catch (error) {
        console.error('❌ Error verificando estado de lectura:', error);
        res.status(500).json({ 
            error: 'Error interno del servidor',
            details: error.message 
        });
    }
});

// 🆕 ENDPOINT PARA VERIFICAR MÚLTIPLES ESTADOS DE LECTURA
app.post('/check-multiple-read-status', async (req, res) => {
    try {
        const { phones } = req.body;
        
        if (!phones || !Array.isArray(phones)) {
            return res.status(400).json({ error: 'Array de teléfonos requerido' });
        }

        const activeClient = getActiveClient();
        if (!activeClient || !activeClient.isReady) {
            return res.status(503).json({ 
                error: 'WhatsApp no conectado',
                ready: false 
            });
        }

        const results = [];
        
        for (const phone of phones) {
            try {
                // Usar el endpoint individual
                const checkResult = await checkSingleMessageStatus(activeClient.client, phone);
                results.push({
                    phone: phone,
                    ...checkResult
                });
                
                // Pausa entre verificaciones
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (error) {
                results.push({
                    phone: phone,
                    read: false,
                    error: error.message,
                    method: 'batch_error'
                });
            }
        }

        res.json({
            success: true,
            total: phones.length,
            results: results,
            timestamp: Date.now()
        });

    } catch (error) {
        console.error('❌ Error verificando estados múltiples:', error);
        res.status(500).json({ 
            error: 'Error interno del servidor',
            details: error.message 
        });
    }
});

// Función auxiliar para verificar un solo mensaje
async function checkSingleMessageStatus(client, phone) {
    const formattedPhone = phone.replace('+', '') + '@c.us';
    
    try {
        const chat = await client.getChatById(formattedPhone);
        const messages = await chat.fetchMessages({ limit: 10 });
        const sentMessages = messages.filter(msg => msg.fromMe);
        
        if (sentMessages.length === 0) {
            return { 
                read: false, 
                reason: 'No hay mensajes enviados',
                method: 'no_messages'
            };
        }

        const lastMessage = sentMessages[0];
        const isRead = lastMessage.ack === 4;
        
        return {
            read: isRead,
            ack: lastMessage.ack,
            messageId: lastMessage.id.id,
            method: 'message_ack'
        };

    } catch (error) {
        return { 
            read: false, 
            reason: error.message,
            method: 'error'
        };
    }
}

// ==========================================
// INICIALIZAR SERVIDOR
// ==========================================

loadSavedSessions();

app.listen(PORT, () => {
    console.log(`\n🌐 Servidor DETECCIÓN REAL iniciado en http://localhost:${PORT}`);
    console.log('🔍 DETECCIÓN REAL DE WHATSAPP ACTIVADA');
    console.log('📊 Métodos de detección:');
    console.log('   1. getNumberId() - Verificar registro en WhatsApp');
    console.log('   2. getContactById() - Verificar accesibilidad del contacto');
    console.log('   3. message_ack events - Tracking de estados de entrega');
    console.log('   4. send errors - Detección de errores directos');
    console.log('🚫 SIN PATRONES - Solo detección basada en respuestas reales de WhatsApp\n');
    
    setTimeout(() => {
        autoInitializeSessions();
    }, 2000);
});

process.on('SIGINT', async () => {
    console.log('\n🛑 Cerrando servidor...');
    for (const [sessionId, sessionData] of clients) {
        console.log(`🚪 Cerrando sesión: ${sessionId}`);
        if (sessionData.client) {
            await sessionData.client.destroy();
        }
    }
    process.exit(0);
});
