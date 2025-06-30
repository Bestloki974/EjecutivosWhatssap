// server.js - Servidor WhatsApp Web API Multi-Número CON CONTADORES
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cors = require('cors');

const app = express();
const PORT = 3001;

// Middleware
app.use(express.json());
app.use(cors());

// Variables globales para múltiples clientes
let clients = new Map(); // sessionId -> client data
let activeSessionId = null;
let messageCounters = new Map(); // sessionId -> { date: string, count: number }
let savedSessions = new Set(); // sessiones guardadas para auto-reconexión

console.log('🚀 Iniciando servidor WhatsApp Multi-Número...');

// Función para obtener fecha actual (YYYY-MM-DD)
function getCurrentDate() {
    return new Date().toISOString().split('T')[0];
}

// Función para cargar sesiones guardadas desde archivos
function loadSavedSessions() {
    try {
        const fs = require('fs');
        const path = require('path');
        
        // Buscar carpetas de sesiones existentes
        const sessionDirs = fs.readdirSync('.').filter(dir => {
            try {
                const stat = fs.statSync(dir);
                return stat.isDirectory() && dir.startsWith('.wwebjs_auth');
            } catch (e) {
                return false;
            }
        });
        
        // Extraer IDs de sesión de los nombres de carpeta
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
        
        // Si no hay sesiones guardadas, crear 'principal' por defecto
        if (savedSessions.size === 0) {
            savedSessions.add('principal');
            console.log('🆕 Creando sesión principal por defecto');
        }
        
        console.log(`📊 Total sesiones para cargar: ${savedSessions.size}`);
        
    } catch (error) {
        console.log('⚠️ Error cargando sesiones guardadas:', error.message);
        savedSessions.add('principal'); // Fallback
    }
}

// Función para auto-inicializar sesiones guardadas
function autoInitializeSessions() {
    console.log('🔄 Auto-inicializando sesiones guardadas...');
    
    let delay = 0;
    for (const sessionId of savedSessions) {
        setTimeout(() => {
            console.log(`🚀 Inicializando sesión: ${sessionId}`);
            const sessionData = createClient(sessionId);
            sessionData.client.initialize();
        }, delay);
        delay += 2000; // 2 segundos entre cada inicialización
    }
}

// Función para obtener contador de mensajes de una sesión
function getMessageCount(sessionId) {
    const today = getCurrentDate();
    const counter = messageCounters.get(sessionId);
    
    if (!counter || counter.date !== today) {
        // Reiniciar contador para el día actual
        messageCounters.set(sessionId, { date: today, count: 0 });
        return 0;
    }
    
    return counter.count;
}

// Función para incrementar contador de mensajes
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

// Función para crear un nuevo cliente
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

    // Datos de la sesión
    const sessionData = {
        client: client,
        isReady: false,
        qrCode: null,
        clientInfo: null,
        sessionId: sessionId
    };

    clients.set(sessionId, sessionData);
    
    // Guardar sesión para auto-reconexión futura
    savedSessions.add(sessionId);
    
    // Inicializar contador de mensajes
    if (!messageCounters.has(sessionId)) {
        messageCounters.set(sessionId, { date: getCurrentDate(), count: 0 });
    }
    
    setupClientEvents(sessionId);
    
    return sessionData;
}

// Función para configurar eventos del cliente
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
        
        // Si es la primera sesión, activarla por defecto
        if (!activeSessionId) {
            activeSessionId = sessionId;
            console.log(`🎯 Sesión activa por defecto: ${sessionId}`);
        }
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
        
        // Si era la sesión activa, cambiar a otra disponible
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
        
        // Intentar reconectar
        setTimeout(() => {
            console.log(`🔄 Reconectando sesión ${sessionId}...`);
            client.initialize();
        }, 5000);
    });

    client.on('message', async (message) => {
        console.log(`📨 [${sessionId}] Mensaje de ${message.from}: ${message.body.substring(0, 30)}...`);
    });
}

// ==========================================
// RUTAS DE LA API
// ==========================================

// Página principal
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
                        <button onclick="logoutSession('${sessionId}')" class="logout-btn">🚪 Cerrar</button>
                        <button onclick="resetCounter('${sessionId}')" class="reset-btn">🔄 Reset</button>
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');

    const totalMessagesToday = Array.from(messageCounters.values()).reduce((total, counter) => 
        counter.date === getCurrentDate() ? total + counter.count : total, 0);

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>WhatsApp Multi-Número - MessageHub</title>
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
            .logout-btn { background: #dc3545 !important; }
            .logout-btn:hover { background: #c82333 !important; }
            .reset-btn { background: #ffc107 !important; color: #000 !important; }
            .reset-btn:hover { background: #e0a800 !important; }
            .add-btn { background: #28a745 !important; }
            .add-btn:hover { background: #218838 !important; }
            .message-counter { 
                background: #e3f2fd; 
                color: #1976d2; 
                padding: 8px; 
                border-radius: 5px; 
                margin: 10px 0; 
                font-weight: bold; 
            }
            .controls { text-align: center; margin: 20px 0; padding: 20px; background: #f8f9fa; border-radius: 10px; }
            .endpoint { background: #e9ecef; padding: 10px; border-left: 4px solid #007bff; margin: 10px 0; }
            pre { background: #f8f9fa; padding: 10px; border-radius: 5px; overflow-x: auto; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🚀 WhatsApp Multi-Número - MessageHub</h1>
            
            <div class="controls">
                <h3>🎯 Sesión Activa: ${activeSessionId || 'Ninguna'}</h3>
                <div style="margin: 10px 0; font-size: 14px; color: #666;">
                    📅 Fecha: ${getCurrentDate()} | 
                    📊 Total mensajes hoy: <strong>${totalMessagesToday}</strong> |
                    💾 Sesiones guardadas: <strong>${savedSessions.size}</strong>
                </div>
                <button class="add-btn" onclick="addNewSession()">➕ Agregar Número</button>
                <button onclick="location.reload()">🔄 Actualizar</button>
                <button onclick="testSend()">📱 Enviar Prueba</button>
                <button onclick="showStats()" style="background: #17a2b8;">📈 Estadísticas</button>
                <button onclick="reconnectAll()" style="background: #6c757d;">🔄 Reconectar Todo</button>
            </div>
            
            <div class="sessions-grid">
                ${sessionsHtml || '<div class="session-card disconnected"><h3>📱 Sin sesiones</h3><p>Agrega un número para comenzar</p></div>'}
            </div>
            
            <h3>📡 API Endpoints:</h3>
            <div class="endpoint">
                <strong>POST /send</strong> - Enviar con sesión activa<br>
                <pre>{"phone": "+56912345678", "message": "Hola!"}</pre>
            </div>
            <div class="endpoint">
                <strong>POST /send-with-session</strong> - Enviar con sesión específica<br>
                <pre>{"sessionId": "numero1", "phone": "+56912345678", "message": "Hola!"}</pre>
            </div>
            <div class="endpoint">
                <strong>GET /stats</strong> - Estadísticas de mensajes por sesión
            </div>
            <div class="endpoint">
                <strong>POST /reset-counter</strong> - Reiniciar contador de una sesión<br>
                <pre>{"sessionId": "numero1"}</pre>
            </div>
            
            <script>
                function addNewSession() {
                    const sessionId = prompt('Nombre para la nueva sesión (ej: numero1, personal, empresa):');
                    if (sessionId && sessionId.trim()) {
                        fetch('/sessions', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({sessionId: sessionId.trim()})
                        })
                        .then(r => r.json())
                        .then(data => {
                            if (data.success) {
                                alert('✅ Nueva sesión creada: ' + sessionId);
                                setTimeout(() => location.reload(), 2000);
                            } else {
                                alert('❌ Error: ' + data.error);
                            }
                        })
                        .catch(e => alert('❌ Error: ' + e));
                    }
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
                
                function logoutSession(sessionId) {
                    if (confirm('¿Cerrar sesión de ' + sessionId + '?')) {
                        fetch('/logout-session', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({sessionId: sessionId})
                        })
                        .then(r => r.json())
                        .then(data => {
                            alert(data.success ? '✅ Sesión cerrada' : '❌ Error: ' + data.error);
                            setTimeout(() => location.reload(), 2000);
                        });
                    }
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
                
                function showStats() {
                    fetch('/stats')
                    .then(r => r.json())
                    .then(data => {
                        let statsText = '📊 ESTADÍSTICAS DE MENSAJES\\n\\n';
                        statsText += '📅 Fecha: ' + data.date + '\\n';
                        statsText += '📈 Total del día: ' + data.totalToday + '\\n\\n';
                        statsText += 'Por sesión:\\n';
                        data.sessions.forEach(session => {
                            statsText += '• ' + session.sessionId + ': ' + session.messagesCount + ' mensajes\\n';
                        });
                        alert(statsText);
                    })
                    .catch(e => alert('Error obteniendo estadísticas: ' + e));
                }
                
                function testSend() {
                    if (!${activeSessionId ? `'${activeSessionId}'` : 'null'}) {
                        alert('❌ No hay sesión activa');
                        return;
                    }
                    const phone = prompt('Número de prueba:');
                    if (phone) {
                        fetch('/send', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({
                                phone: phone,
                                message: '🚀 Prueba desde sesión: ${activeSessionId || 'N/A'}'
                            })
                        })
                        .then(r => r.json())
                        .then(data => {
                            if (data.success) {
                                alert('✅ Enviado! Contador: ' + data.messagesCount + ' mensajes hoy');
                                location.reload();
                            } else {
                                alert('❌ Error: ' + data.error);
                            }
                        });
                    }
                }
                
                function reconnectAll() {
                    if (confirm('¿Reconectar todas las sesiones guardadas? Esto puede tomar unos minutos.')) {
                        fetch('/reconnect-all', { method: 'POST' })
                        .then(r => r.json())
                        .then(data => {
                            alert(data.success ? '✅ Reconectando sesiones...' : '❌ Error: ' + data.error);
                            setTimeout(() => location.reload(), 3000);
                        });
                    }
                }
                
                // Auto refresh cada 60 segundos
                setTimeout(() => location.reload(), 60000);
            </script>
        </div>
    </body>
    </html>`;
    
    res.send(html);
});

// Listar sesiones
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

// Estadísticas de mensajes
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

// Reiniciar contador de una sesión
app.post('/reset-counter', (req, res) => {
    try {
        const { sessionId } = req.body;
        
        if (!sessionId) {
            return res.status(400).json({ success: false, error: 'sessionId requerido' });
        }
        
        if (!clients.has(sessionId)) {
            return res.status(404).json({ success: false, error: 'Sesión no encontrada' });
        }
        
        // Reiniciar contador
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

// Reconectar todas las sesiones guardadas
app.post('/reconnect-all', (req, res) => {
    try {
        console.log('🔄 Reconectando todas las sesiones guardadas...');
        
        // Recargar sesiones guardadas del sistema de archivos
        loadSavedSessions();
        
        // Reconectar cada sesión guardada
        let reconnected = 0;
        for (const sessionId of savedSessions) {
            if (!clients.has(sessionId)) {
                const sessionData = createClient(sessionId);
                setTimeout(() => {
                    sessionData.client.initialize();
                }, reconnected * 2000); // 2 segundos entre cada reconexión
                reconnected++;
            }
        }
        
        res.json({ 
            success: true, 
            message: `Reconectando ${reconnected} sesiones`,
            reconnectedCount: reconnected
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});


app.post('/sessions', (req, res) => {
    try {
        const { sessionId } = req.body;
        
        if (!sessionId) {
            return res.status(400).json({ success: false, error: 'sessionId requerido' });
        }
        
        if (clients.has(sessionId)) {
            return res.status(400).json({ success: false, error: 'Sesión ya existe' });
        }
        
        const sessionData = createClient(sessionId);
        console.log(`🆕 Nueva sesión creada: ${sessionId}`);
        
        // Inicializar cliente
        setTimeout(() => {
            sessionData.client.initialize();
        }, 1000);
        
        res.json({ success: true, sessionId, message: 'Sesión creada exitosamente' });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Cambiar sesión activa
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

// Cerrar sesión específica
app.post('/logout-session', async (req, res) => {
    try {
        const { sessionId } = req.body;
        
        if (!clients.has(sessionId)) {
            return res.status(404).json({ success: false, error: 'Sesión no encontrada' });
        }
        
        const sessionData = clients.get(sessionId);
        
        console.log(`🚪 Cerrando sesión: ${sessionId}`);
        
        if (sessionData.client) {
            await sessionData.client.logout();
            await sessionData.client.destroy();
        }
        
        clients.delete(sessionId);
        
        // Remover de sesiones guardadas si se cierra manualmente
        savedSessions.delete(sessionId);
        
        // Si era la sesión activa, cambiar a otra
        if (activeSessionId === sessionId) {
            const availableSession = Array.from(clients.entries())
                .find(([id, data]) => data.isReady);
            
            activeSessionId = availableSession ? availableSession[0] : null;
        }
        
        res.json({ success: true, message: 'Sesión cerrada exitosamente' });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Estado general
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

// Enviar mensaje con sesión activa
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
        
        // Formatear número
        let cleanPhone = phone.replace(/[^0-9+]/g, '');
        if (!cleanPhone.startsWith('+')) {
            if (cleanPhone.startsWith('56')) {
                cleanPhone = '+' + cleanPhone;
            } else {
                cleanPhone = '+56' + cleanPhone;
            }
        }
        
        const chatId = cleanPhone.substring(1) + '@c.us';
        
        console.log(`📤 [${activeSessionId}] Enviando a ${cleanPhone}...`);
        
        const sentMessage = await sessionData.client.sendMessage(chatId, message);
        
        console.log(`✅ [${activeSessionId}] Enviado a ${cleanPhone}`);
        
        // Incrementar contador de mensajes
        const messageCount = incrementMessageCount(activeSessionId);
        
        res.json({
            success: true,
            messageId: sentMessage.id.id,
            phone: cleanPhone,
            sessionId: activeSessionId,
            messagesCount: messageCount,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Error enviando:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Enviar mensaje con sesión específica
app.post('/send-with-session', async (req, res) => {
    try {
        const { sessionId, phone, message } = req.body;
        
        if (!sessionId || !phone || !message) {
            return res.status(400).json({ 
                success: false, 
                error: 'sessionId, phone y message requeridos' 
            });
        }
        
        const sessionData = clients.get(sessionId);
        if (!sessionData) {
            return res.status(404).json({ success: false, error: 'Sesión no encontrada' });
        }
        
        if (!sessionData.isReady) {
            return res.status(400).json({ success: false, error: 'Sesión no está lista' });
        }
        
        // Formatear número
        let cleanPhone = phone.replace(/[^0-9+]/g, '');
        if (!cleanPhone.startsWith('+')) {
            if (cleanPhone.startsWith('56')) {
                cleanPhone = '+' + cleanPhone;
            } else {
                cleanPhone = '+56' + cleanPhone;
            }
        }
        
        const chatId = cleanPhone.substring(1) + '@c.us';
        
        console.log(`📤 [${sessionId}] Enviando a ${cleanPhone}...`);
        
        const sentMessage = await sessionData.client.sendMessage(chatId, message);
        
        console.log(`✅ [${sessionId}] Enviado a ${cleanPhone}`);
        
        // Incrementar contador de mensajes
        const messageCount = incrementMessageCount(sessionId);
        
        res.json({
            success: true,
            messageId: sentMessage.id.id,
            phone: cleanPhone,
            sessionId: sessionId,
            messagesCount: messageCount,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error(`❌ Error enviando con sesión ${req.body.sessionId}:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==========================================
// INICIALIZAR SERVIDOR
// ==========================================

// Cargar sesiones guardadas del sistema de archivos
loadSavedSessions();

// Iniciar servidor Express
app.listen(PORT, () => {
    console.log(`\n🌐 Servidor Multi-Número iniciado en http://localhost:${PORT}`);
    console.log('📱 Auto-inicializando sesiones guardadas...\n');
    
    // Auto-inicializar todas las sesiones guardadas
    setTimeout(() => {
        autoInitializeSessions();
    }, 2000);
});

// Manejo de cierre limpio
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