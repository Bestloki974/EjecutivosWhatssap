// src/routes.js - Rutas principales con distribución automática mejorada
const express = require('express');
const qrcode = require('qrcode-terminal');
const config = require('./config');
const logger = require('./logger');
const database = require('./database');
const { pauseCampaign } = require('./campaignPause');

class Routes {
    constructor(sessionManager, campaignProcessor) {
        this.sessionManager = sessionManager;
        this.campaignProcessor = campaignProcessor;
        this.router = express.Router();
        this.setupRoutes();
    }

    setupRoutes() {
        // Ruta principal - Dashboard
        this.router.get('/', this.getDashboard.bind(this));
        
        // API de estado de WhatsApp
        this.router.get('/status', this.getStatus.bind(this));
        this.router.get('/sessions', this.getSessions.bind(this));
        
        // Gestión de sesiones
        this.router.post('/sessions', this.createSession.bind(this));
        this.router.post('/set-active-session', this.setActiveSession.bind(this));
        this.router.post('/logout-session', this.logoutSession.bind(this));
        this.router.post('/remove-session', this.removeSession.bind(this));
        this.router.post('/restart-session', this.restartSession.bind(this));
        this.router.post('/reconnect-session', this.reconnectSession.bind(this));
        this.router.post('/cleanup-folders', this.cleanupFolders.bind(this));
        this.router.get('/qr/:sessionId', this.getQR.bind(this));
        this.router.get('/available-sessions', this.getAvailableSessions.bind(this));
        
        // Envío de mensajes
        this.router.post('/send', this.sendMessage.bind(this));
        this.router.post('/send-campaign-distributed', this.sendCampaignDistributed.bind(this));
        this.router.post('/send-campaign-distributed-automatic', this.sendCampaignDistributedAutomatic.bind(this));
        
        // 🆕 NUEVO ENDPOINT PARA DISTRIBUCIÓN AUTOMÁTICA
        this.router.post('/send-campaign-distributed-automatic', this.sendCampaignDistributedAutomatic.bind(this));
        
        // 🔧 CORRECCIÓN DE ESTADOS
        this.router.post('/fix-message-states', this.fixMessageStates.bind(this));
        
        // Estadísticas
        this.router.get('/stats', this.getStats.bind(this));
        this.router.get('/campaign-status/:campaign_id', this.getCampaignStatus.bind(this));
        
        // Campaign control endpoints
        this.router.post('/pause-campaign/:campaignId', async (req, res) => {
            const { campaignId } = req.params;
            try {
                // Llamar pauseCampaign con el contexto correcto (campaignProcessor)
                await pauseCampaign.call(this.campaignProcessor, campaignId);
                res.json({ success: true, message: `Campaign ${campaignId} paused successfully` });
            } catch (error) {
                console.error(`Error pausing campaign ${campaignId}: ${error.message}`);
                res.status(500).json({ success: false, error: error.message });
            }
        });

        // Test endpoint
        this.router.get('/test-connection', this.testConnection.bind(this));
    }

    // 🆕 ENVÍO DE CAMPAÑA CON DISTRIBUCIÓN AUTOMÁTICA
    async sendCampaignDistributedAutomatic(req, res) {
        try {
            const { 
                campaign_id, 
                contacts, 
                delay_seconds = config.DEFAULT_DELAY,
                user_id,
                php_callback = false,
                media_type,
                media_url,
                media_caption,
                distribution_mode = 'automatic'
            } = req.body;
            
            if (!contacts || contacts.length === 0) {
                return res.status(400).json({ success: false, error: 'No hay contactos para enviar' });
            }
            
            // Obtener sesiones activas disponibles
            const availableSessions = Array.from(this.sessionManager.clients.entries())
                .filter(([sessionId, sessionData]) => sessionData.isReady)
                .map(([sessionId, sessionData]) => ({
                    sessionId,
                    clientInfo: sessionData.clientInfo,
                    isReady: sessionData.isReady,
                    messagesCount: this.sessionManager.getMessageCount(sessionId)
                }));
            
            if (availableSessions.length === 0) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'No hay números de WhatsApp conectados',
                    suggestion: 'Conecta al menos una sesión antes de enviar'
                });
            }
            
            logger.campaign(`🚀 DISTRIBUCIÓN AUTOMÁTICA: ${contacts.length} contactos entre ${availableSessions.length} sesiones`, campaign_id);
            
            // Preparar datos multimedia
            const mediaData = {
                media_type: media_type || 'text',
                media_url: media_url || null,
                media_caption: media_caption || null
            };
            
            // Calcular tiempo estimado por sesión
            const avgContactsPerSession = Math.ceil(contacts.length / availableSessions.length);
            const estimatedMinutesPerSession = Math.ceil((avgContactsPerSession * delay_seconds) / 60);
            const estimatedTotalMinutes = estimatedMinutesPerSession; // Paralelo
            
            // Respuesta inmediata al frontend
            const response = {
                success: true,
                message: `Distribución automática iniciada entre ${availableSessions.length} sesiones`,
                campaign_id: campaign_id,
                distribution_mode: 'automatic',
                total_contacts: contacts.length,
                sessions_count: availableSessions.length,
                sessions_info: availableSessions.map(session => ({
                    sessionId: session.sessionId,
                    name: session.clientInfo?.pushname || session.sessionId,
                    number: session.clientInfo?.wid?.user || 'N/A',
                    current_messages: session.messagesCount
                })),
                delay_between_messages: delay_seconds + ' segundos',
                estimated_time: estimatedTotalMinutes + ' minutos',
                avg_contacts_per_session: avgContactsPerSession,
                start_time: new Date().toISOString()
            };
            
            res.json(response);
            
            // 🔥 PROCESAR CAMPAÑA EN BACKGROUND CON DISTRIBUCIÓN AUTOMÁTICA
            setTimeout(async () => {
                try {
                    logger.campaign(`Iniciando procesamiento automático en background...`, campaign_id);
                    
                    // Usar el nuevo método de distribución automática
                    await this.campaignProcessor.processDistributedCampaignAutomatic(
                        contacts, 
                        campaign_id, 
                        delay_seconds, 
                        mediaData
                    );
                    
                    // Actualizar estado de PHP callback si es necesario
                    if (php_callback) {
                        await this.campaignProcessor.updateCampaignStatusPHP(campaign_id, 'completed');
                    }
                    
                    logger.success(`✅ Campaña automática ${campaign_id} completada exitosamente`);
                    
                } catch (error) {
                    logger.error(`❌ Error en procesamiento automático de campaña ${campaign_id}: ${error.message}`);
                    
                    if (php_callback) {
                        await this.campaignProcessor.updateCampaignStatusPHP(campaign_id, 'completed_with_errors');
                    }
                }
            }, 1000);
            
        } catch (error) {
            logger.error(`Error en distribución automática: ${error.message}`);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // 🆕 OBTENER SESIONES DISPONIBLES PARA DISTRIBUCIÓN
    getAvailableSessions(req, res) {
        try {
            const sessions = [];
            
            for (const [sessionId, sessionData] of this.sessionManager.clients.entries()) {
                const messageCount = this.sessionManager.getMessageCount(sessionId);
                sessions.push({
                    sessionId: sessionId,
                    isReady: sessionData.isReady,
                    clientInfo: sessionData.clientInfo,
                    isActive: sessionId === this.sessionManager.activeSessionId,
                    messagesCount: messageCount,
                    lastActivity: sessionData.lastActivity,
                    status: sessionData.isReady ? 'connected' : 'disconnected'
                });
            }
            
            // Ordenar: sesiones listas primero, luego por menor cantidad de mensajes
            sessions.sort((a, b) => {
                if (a.isReady !== b.isReady) return b.isReady - a.isReady;
                return a.messagesCount - b.messagesCount;
            });
            
            res.json({
                success: true,
                sessions: sessions,
                totalSessions: sessions.length,
                readySessions: sessions.filter(s => s.isReady).length,
                defaultSession: this.sessionManager.activeSessionId
            });
            
        } catch (error) {
            logger.error(`Error obteniendo sesiones: ${error.message}`);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // Dashboard principal
    getDashboard(req, res) {
        const sessionsHtml = Array.from(this.sessionManager.clients.entries()).map(([sessionId, data]) => {
            const status = data.isReady ? 'connected' : 'disconnected';
            const statusText = data.isReady ? '✅ Conectado' : (data.qrCode ? '📱 Esperando QR' : '🔄 Iniciando');
            const isActive = this.sessionManager.activeSessionId === sessionId ? ' (ACTIVA)' : '';
            const messageCount = this.sessionManager.getMessageCount(sessionId);
            
            return `
                <div class="session-card ${status}">
                    <h3>📱 Sesión: ${sessionId}${isActive}</h3>
                    <div class="status">${statusText}</div>
                    <div class="message-counter">📊 Mensajes hoy: <strong>${messageCount}</strong></div>
                    ${data.clientInfo ? `
                        <div class="info">
                            <strong>Usuario:</strong> ${data.clientInfo.pushname}<br>
                            <strong>Número:</strong> +${data.clientInfo.wid.user}
                        </div>
                    ` : ''}
                    <div class="session-actions">
                        ${data.isReady ? `
                            <button onclick="setActiveSession('${sessionId}')" ${this.sessionManager.activeSessionId === sessionId ? 'disabled' : ''}>
                                ${this.sessionManager.activeSessionId === sessionId ? '🎯 Activa' : '🔄 Activar'}
                            </button>
                            <button onclick="logoutSession('${sessionId}')" class="logout-btn">🚪 Cerrar</button>
                            <button onclick="restartSession('${sessionId}')" class="restart-btn">⚡ Reiniciar</button>
                            <button onclick="removeSession('${sessionId}')" class="remove-btn">🗑️ Eliminar</button>
                        ` : data.qrCode ? `
                            <button onclick="showQR('${sessionId}')" style="background: #f39c12;">📱 Ver QR</button>
                            <button onclick="reconnectSession('${sessionId}')" style="background: #3498db;">🔄 Reconectar</button>
                            <button onclick="restartSession('${sessionId}')" class="restart-btn">⚡ Reiniciar</button>
                            <button onclick="removeSession('${sessionId}')" class="remove-btn">🗑️ Eliminar</button>
                        ` : `
                            <button onclick="restartSession('${sessionId}')" class="restart-btn">⚡ Reiniciar</button>
                            <button onclick="reconnectSession('${sessionId}')" style="background: #3498db;">🔄 Reconectar</button>
                            <button onclick="removeSession('${sessionId}')" class="remove-btn">🗑️ Eliminar</button>
                        `}
                    </div>
                </div>
            `;
        }).join('');

        const totalMessagesToday = Array.from(this.sessionManager.messageCounters.values())
            .reduce((total, counter) => 
                counter.date === this.sessionManager.getCurrentDate() ? total + counter.count : total, 0);

        // 🆕 ESTADÍSTICAS DE DISTRIBUCIÓN AUTOMÁTICA
        const queueStatus = this.campaignProcessor.getQueueStatus();
        const distributionStats = queueStatus.active_workers > 0 ? `
            <div class="distribution-status">
                <h4>🚀 Distribución Automática Activa</h4>
                <div>⚡ Workers activos: <strong>${queueStatus.active_workers}</strong></div>
                <div>📋 Contactos pendientes: <strong>${queueStatus.pending_contacts}</strong></div>
                <div>❌ Sesiones fallidas: <strong>${queueStatus.failed_sessions}</strong></div>
            </div>
        ` : '';

        const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>WhatsApp Multi-Número - MessageHub DISTRIBUIDO</title>
            <meta charset="utf-8">
            <style>
                body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
                .container { max-width: 1200px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; }
                .sessions-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin: 20px 0; }
                .session-card { border: 2px solid #ddd; border-radius: 10px; padding: 20px; text-align: center; }
                .session-card.connected { border-color: #28a745; background: #f8fff9; }
                .session-card.disconnected { border-color: #dc3545; background: #fff8f8; }
                .status { font-weight: bold; margin: 10px 0; }
                .connected .status { color: #28a745; }
                .disconnected .status { color: #dc3545; }
                .info { text-align: left; background: #f8f9fa; padding: 10px; border-radius: 5px; margin: 10px 0; }
                button { background: #007bff; color: white; border: none; padding: 8px 16px; border-radius: 5px; cursor: pointer; margin: 5px; }
                button:hover { background: #0056b3; }
                button:disabled { background: #6c757d; cursor: not-allowed; }
                .logout-btn { background: #dc3545 !important; }
                .logout-btn:hover { background: #c82333 !important; }
                .restart-btn { background: #ffc107 !important; color: #000 !important; }
                .restart-btn:hover { background: #e0a800 !important; }
                .remove-btn { background: #e74c3c !important; }
                .remove-btn:hover { background: #c0392b !important; }
                .add-btn { background: #28a745 !important; }
                .add-btn:hover { background: #218838 !important; }
                .test-btn { background: #17a2b8 !important; }
                .test-btn:hover { background: #138496 !important; }
                .message-counter { background: #e3f2fd; color: #1976d2; padding: 8px; border-radius: 5px; margin: 10px 0; font-weight: bold; }
                .controls { text-align: center; margin: 20px 0; padding: 20px; background: #f8f9fa; border-radius: 10px; }
                .distribution-status { background: #d1ecf1; border: 1px solid #bee5eb; color: #0c5460; padding: 15px; border-radius: 5px; margin: 15px 0; text-align: left; }
                .distribution-status h4 { margin: 0 0 10px 0; }
                .new-feature { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; padding: 10px; border-radius: 5px; margin: 10px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🚀 WhatsApp Multi-Número - MessageHub DISTRIBUIDO</h1>
                
                <div class="new-feature">
                    <strong>🆕 NUEVO:</strong> Distribución automática con compensación de carga entre sesiones. 
                    Los mensajes se distribuyen equitativamente y si una sesión falla, se redistribuye automáticamente.
                </div>
                
                <div class="controls">
                    <h3>🎯 Sesión Activa: ${this.sessionManager.activeSessionId || 'Ninguna'}</h3>
                    <div>📊 Total mensajes hoy: <strong>${totalMessagesToday}</strong></div>
                    <div>📱 Sesiones conectadas: <strong>${Array.from(this.sessionManager.clients.values()).filter(s => s.isReady).length}</strong></div>
                    ${distributionStats}
                    <button class="add-btn" onclick="addNewSession()">➕ Agregar Número</button>
                    <button onclick="location.reload()">🔄 Actualizar</button>
                    <button onclick="testSend()">📱 Enviar Prueba</button>
                    <button class="test-btn" onclick="testDistribution()">🚀 Test Distribución</button>
                    <button onclick="showStats()" style="background: #17a2b8;">📈 Estadísticas</button>
                    <button onclick="cleanupFolders()" style="background: #e74c3c;">🗑️ Limpiar Carpetas</button>
                </div>
                
                <div class="sessions-grid">
                    ${sessionsHtml || '<div class="session-card disconnected"><h3>📱 Sin sesiones</h3></div>'}
                </div>
                
                <script>
                    function addNewSession() {
                        const sessionId = prompt('Nombre para la nueva sesión (ej: numero2, personal, empresa):');
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
                    
                    function testDistribution() {
                        if (confirm('🚀 ¿Probar distribución automática?\\n\\nEsto enviará un mensaje de prueba distribuido entre todas las sesiones conectadas.')) {
                            const testContacts = [
                                {contact_id: 1, full_name: 'Test 1', phone: '56912345678', message: '🚀 Test distribución automática - Mensaje 1'},
                                {contact_id: 2, full_name: 'Test 2', phone: '56987654321', message: '🚀 Test distribución automática - Mensaje 2'},
                                {contact_id: 3, full_name: 'Test 3', phone: '56555666777', message: '🚀 Test distribución automática - Mensaje 3'}
                            ];
                            
                            fetch('/send-campaign-distributed-automatic', {
                                method: 'POST',
                                headers: {'Content-Type': 'application/json'},
                                body: JSON.stringify({
                                    campaign_id: 'TEST_' + Date.now(),
                                    contacts: testContacts,
                                    delay_seconds: 5,
                                    distribution_mode: 'automatic'
                                })
                            })
                            .then(r => r.json())
                            .then(data => {
                                if (data.success) {
                                    alert('✅ Distribución de prueba iniciada\\n\\n' +
                                        'Contactos: ' + data.total_contacts + '\\n' +
                                        'Sesiones: ' + data.sessions_count + '\\n' +
                                        'Tiempo estimado: ' + data.estimated_time);
                                    setTimeout(() => location.reload(), 3000);
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
                    
                    function restartSession(sessionId) {
                        if (confirm('🔄 ¿Reiniciar sesión ' + sessionId + '?\\n\\nEsto forzará un reinicio completo.')) {
                            showLoading('Reiniciando ' + sessionId + '...');
                            
                            fetch('/restart-session', {
                                method: 'POST',
                                headers: {'Content-Type': 'application/json'},
                                body: JSON.stringify({sessionId: sessionId})
                            })
                            .then(r => r.json())
                            .then(data => {
                                hideLoading();
                                if (data.success) {
                                    alert('✅ ' + data.message);
                                    setTimeout(() => location.reload(), 4000);
                                } else {
                                    alert('❌ Error: ' + data.error);
                                }
                            })
                            .catch(e => {
                                hideLoading();
                                alert('❌ Error: ' + e);
                            });
                        }
                    }
                    
                    function removeSession(sessionId) {
                        if (confirm('⚠️ ¿ELIMINAR completamente la sesión ' + sessionId + '?\\n\\nEsto NO se puede deshacer.')) {
                            showLoading('Eliminando ' + sessionId + '...');
                            
                            fetch('/remove-session', {
                                method: 'POST',
                                headers: {'Content-Type': 'application/json'},
                                body: JSON.stringify({sessionId: sessionId})
                            })
                            .then(r => r.json())
                            .then(data => {
                                hideLoading();
                                if (data.success) {
                                    alert('✅ ' + data.message);
                                    location.reload();
                                } else {
                                    alert('❌ Error: ' + data.error);
                                }
                            })
                            .catch(e => {
                                hideLoading();
                                alert('❌ Error: ' + e);
                            });
                        }
                    }
                    
                    function reconnectSession(sessionId) {
                        if (confirm('¿Reconectar ' + sessionId + '? Se generará un nuevo QR.')) {
                            showLoading('Reconectando ' + sessionId + '...');
                            
                            fetch('/reconnect-session', {
                                method: 'POST',
                                headers: {'Content-Type': 'application/json'},
                                body: JSON.stringify({sessionId: sessionId})
                            })
                            .then(r => r.json())
                            .then(data => {
                                hideLoading();
                                if (data.success) {
                                    alert('✅ ' + data.message);
                                    setTimeout(() => location.reload(), 3000);
                                } else {
                                    alert('❌ Error: ' + data.error);
                                }
                            })
                            .catch(e => {
                                hideLoading();
                                alert('❌ Error: ' + e);
                            });
                        }
                    }
                    
                    function showQR(sessionId) {
                        showLoading('Obteniendo QR de ' + sessionId + '...');
                        
                        fetch('/qr/' + sessionId)
                        .then(r => r.json())
                        .then(data => {
                            hideLoading();
                            if (data.success) {
                                const modal = document.createElement('div');
                                modal.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 1000;';
                                
                                modal.innerHTML = '<div style="background: white; padding: 30px; border-radius: 10px; text-align: center;"><h3>📱 QR para ' + sessionId + '</h3><img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(data.qrCode) + '" alt="QR ' + sessionId + '" style="margin: 20px 0;"><br><button onclick="this.parentElement.parentElement.remove()" style="background: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer;">Cerrar</button></div>';
                                
                                document.body.appendChild(modal);
                            } else {
                                alert('❌ ' + data.error);
                            }
                        })
                        .catch(e => {
                            hideLoading();
                            alert('❌ Error: ' + e);
                        });
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
                            if (data.queueStatus) {
                                statsText += '\\n🚀 DISTRIBUCIÓN AUTOMÁTICA:\\n';
                                statsText += '• Workers activos: ' + data.queueStatus.active_workers + '\\n';
                                statsText += '• Contactos pendientes: ' + data.queueStatus.pending_contacts + '\\n';
                                statsText += '• Sesiones fallidas: ' + data.queueStatus.failed_sessions + '\\n';
                                statsText += '• Campañas activas: ' + data.queueStatus.campaigns_active + '\\n';
                            }
                            alert(statsText);
                        })
                        .catch(e => alert('Error obteniendo estadísticas: ' + e));
                    }
                    
                    function cleanupFolders() {
                        if (confirm('🗑️ ¿Limpiar carpetas huérfanas del sistema de archivos?\\n\\nEsto eliminará carpetas de sesiones que ya no están en uso.')) {
                            showLoading('Limpiando carpetas...');
                            
                            fetch('/cleanup-folders', { method: 'POST' })
                            .then(r => r.json())
                            .then(data => {
                                hideLoading();
                                if (data.success) {
                                    alert('✅ Limpieza completada:\\n\\n📁 Total carpetas: ' + (data.total_folders || 'N/A') + '\\n🗑️ Eliminadas: ' + (data.folders_removed || 0) + '\\n📊 Sesiones activas: ' + (data.active_sessions || 'N/A'));
                                    if (data.folders_removed > 0) {
                                        setTimeout(() => location.reload(), 2000);
                                    }
                                } else {
                                    alert('❌ Error: ' + data.error);
                                }
                            })
                            .catch(e => {
                                hideLoading();
                                alert('❌ Error: ' + e);
                            });
                        }
                    }
                    
                    function testSend() {
                        const phone = prompt('Número de prueba:');
                        if (phone) {
                            fetch('/send', {
                                method: 'POST',
                                headers: {'Content-Type': 'application/json'},
                                body: JSON.stringify({
                                    phone: phone,
                                    message: '🚀 Prueba desde MessageHub Distribuido!'
                                })
                            }).then(r => r.json()).then(data => {
                                alert(data.success ? '✅ Enviado!' : '❌ Error: ' + data.error);
                                location.reload();
                            });
                        }
                    }
                    
                    function showLoading(message) {
                        const loading = document.getElementById('loading') || document.createElement('div');
                        loading.id = 'loading';
                        loading.style.cssText = 'position: fixed; top: 20px; right: 20px; background: #007bff; color: white; padding: 15px; border-radius: 5px; z-index: 999;';
                        loading.textContent = message;
                        document.body.appendChild(loading);
                    }

                    function hideLoading() {
                        const loading = document.getElementById('loading');
                        if (loading) loading.remove();
                    }
                    
                    // Auto refresh cada 60 segundos
                    setTimeout(() => location.reload(), 60000);
                </script>
            </div>
        </body>
        </html>`;
        
        res.send(html);
    }

    // ===== MÉTODOS EXISTENTES MANTENIDOS =====

    // Estado de WhatsApp
    async getStatus(req, res) {
        const activeSession = this.sessionManager.activeSessionId ? 
            this.sessionManager.clients.get(this.sessionManager.activeSessionId) : null;
        
        res.json({
            ready: activeSession?.isReady || false,
            activeSession: this.sessionManager.activeSessionId,
            totalSessions: this.sessionManager.clients.size,
            readySessions: Array.from(this.sessionManager.clients.values()).filter(s => s.isReady).length,
            clientInfo: activeSession?.clientInfo ? {
                name: activeSession.clientInfo.pushname,
                number: activeSession.clientInfo.wid.user
            } : null
        });
    }

    // Lista de sesiones
    getSessions(req, res) {
        const sessionsList = Array.from(this.sessionManager.clients.entries()).map(([sessionId, data]) => ({
            sessionId,
            isReady: data.isReady,
            isActive: this.sessionManager.activeSessionId === sessionId,
            messagesCount: this.sessionManager.getMessageCount(sessionId),
            clientInfo: data.clientInfo ? {
                name: data.clientInfo.pushname,
                number: data.clientInfo.wid.user
            } : null
        }));

        res.json({
            sessions: sessionsList,
            activeSession: this.sessionManager.activeSessionId,
            totalSessions: this.sessionManager.clients.size
        });
    }

    // Crear nueva sesión
    createSession(req, res) {
        try {
            const { sessionId } = req.body;
            
            if (!sessionId) {
                return res.status(400).json({ success: false, error: 'sessionId requerido' });
            }
            
            if (this.sessionManager.clients.has(sessionId)) {
                return res.status(400).json({ success: false, error: 'Sesión ya existe' });
            }
            
            const sessionData = this.sessionManager.createClient(sessionId);
            logger.session(`Nueva sesión creada: ${sessionId}`, sessionId);
            
            setTimeout(() => {
                sessionData.client.initialize();
            }, 1000);
            
            res.json({ success: true, sessionId, message: 'Sesión creada exitosamente' });
            
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // Establecer sesión activa
    setActiveSession(req, res) {
        try {
            const { sessionId } = req.body;
            
            if (!this.sessionManager.clients.has(sessionId)) {
                return res.status(404).json({ success: false, error: 'Sesión no encontrada' });
            }
            
            const sessionData = this.sessionManager.clients.get(sessionId);
            if (!sessionData.isReady) {
                return res.status(400).json({ success: false, error: 'Sesión no está lista' });
            }
            
            this.sessionManager.activeSessionId = sessionId;
            logger.session(`Sesión activa cambiada a: ${sessionId}`, sessionId);
            
            res.json({ success: true, activeSession: sessionId });
            
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // Cerrar sesión
    async logoutSession(req, res) {
        try {
            const { sessionId } = req.body;
            
            if (!this.sessionManager.clients.has(sessionId)) {
                return res.status(404).json({ success: false, error: 'Sesión no encontrada' });
            }
            
            const sessionData = this.sessionManager.clients.get(sessionId);
            
            if (sessionData.client) {
                await sessionData.client.logout();
                await sessionData.client.destroy();
            }
            
            this.sessionManager.clients.delete(sessionId);
            this.sessionManager.savedSessions.delete(sessionId);
            
            if (this.sessionManager.activeSessionId === sessionId) {
                const availableSession = Array.from(this.sessionManager.clients.entries())
                    .find(([id, data]) => data.isReady);
                
                this.sessionManager.activeSessionId = availableSession ? availableSession[0] : null;
            }
            
            res.json({ success: true, message: 'Sesión cerrada exitosamente' });
            
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // Remover sesión completamente
    async removeSession(req, res) {
        try {
            const { sessionId } = req.body;
            
            if (!sessionId) {
                return res.status(400).json({ success: false, error: 'sessionId requerido' });
            }
            
            await this.sessionManager.cleanupClient(sessionId);
            
            this.sessionManager.savedSessions.delete(sessionId);
            this.sessionManager.messageCounters.delete(sessionId);
            
            if (this.sessionManager.activeSessionId === sessionId) {
                const availableSession = Array.from(this.sessionManager.clients.entries())
                    .find(([id, data]) => data.isReady);
                this.sessionManager.activeSessionId = availableSession ? availableSession[0] : null;
            }
            
            res.json({ 
                success: true, 
                message: `Sesión ${sessionId} eliminada exitosamente`,
                newActiveSession: this.sessionManager.activeSessionId
            });
            
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // Obtener QR de sesión específica
    getQR(req, res) {
        try {
            const { sessionId } = req.params;
            const sessionData = this.sessionManager.clients.get(sessionId);
            
            if (!sessionData) {
                return res.status(404).json({ success: false, error: 'Sesión no encontrada' });
            }
            
            if (sessionData.isReady) {
                return res.json({ 
                    success: false, 
                    error: 'Sesión ya está conectada',
                    isConnected: true
                });
            }
            
            if (!sessionData.qrCode) {
                return res.json({ 
                    success: false, 
                    error: 'QR no disponible. Sesión iniciando...',
                    isGenerating: true
                });
            }
            
            res.json({
                success: true,
                qrCode: sessionData.qrCode,
                sessionId: sessionId,
                status: 'waiting_scan'
            });
            
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // Envío simple de mensaje
    async sendMessage(req, res) {
        const { phone, message, sessionId } = req.body;
        
        try {
            const targetSessionId = sessionId || this.sessionManager.activeSessionId;
            if (!targetSessionId) {
                return res.status(400).json({ success: false, error: 'No hay sesión activa' });
            }
            
            const sessionData = this.sessionManager.clients.get(targetSessionId);
            if (!sessionData?.isReady) {
                return res.status(400).json({ success: false, error: 'Sesión no está lista' });
            }
            
            const cleanPhone = this.formatPhone(phone);
            const chatId = cleanPhone.substring(1) + '@c.us';
            
            const result = await sessionData.client.sendMessage(chatId, message);
            const messageCount = this.sessionManager.incrementMessageCount(targetSessionId);
            
            res.json({ 
                success: true, 
                messageId: result.id._serialized,
                messagesCount: messageCount,
                sessionId: targetSessionId
            });
            
        } catch (error) {
            logger.error(`Error enviando mensaje: ${error.message}`);
            res.json({ success: false, error: error.message });
        }
    }

    // Envío de campaña distribuida (método existente)
    async sendCampaignDistributed(req, res) {
        try {
            const { 
                campaign_id, 
                contacts, 
                delay_seconds = config.DEFAULT_DELAY,
                user_id,
                php_callback = false,
                media_type,
                media_url,
                media_caption
            } = req.body;
            
            if (!contacts || contacts.length === 0) {
                return res.status(400).json({ success: false, error: 'No hay contactos para enviar' });
            }
            
            // Obtener sesiones activas disponibles
            const availableSessions = Array.from(this.sessionManager.clients.entries())
                .filter(([sessionId, sessionData]) => sessionData.isReady)
                .map(([sessionId]) => sessionId);
            
            if (availableSessions.length === 0) {
                return res.status(400).json({ success: false, error: 'No hay números de WhatsApp conectados' });
            }
            
            logger.campaign(`Distribuyendo ${contacts.length} contactos entre ${availableSessions.length} números`, campaign_id);
            
            // Distribuir contactos entre sesiones
            const contactsPerSession = Math.ceil(contacts.length / availableSessions.length);
            const distribution = [];
            
            for (let i = 0; i < availableSessions.length; i++) {
                const sessionId = availableSessions[i];
                const startIndex = i * contactsPerSession;
                const endIndex = Math.min(startIndex + contactsPerSession, contacts.length);
                const sessionContacts = contacts.slice(startIndex, endIndex);
                
                if (sessionContacts.length > 0) {
                    distribution.push({
                        sessionId: sessionId,
                        contacts: sessionContacts,
                        count: sessionContacts.length
                    });
                }
            }
            
            // Calcular tiempo estimado
            const estimatedMinutes = Math.ceil((contacts.length * delay_seconds) / 60);
            
            // Respuesta inmediata
            res.json({
                success: true,
                message: 'Distribución iniciada',
                campaign_id: campaign_id,
                total_contacts: contacts.length,
                available_numbers: availableSessions.length,
                distribution: distribution.map(d => ({
                    sessionId: d.sessionId,
                    contacts_assigned: d.count
                })),
                delay_between_messages: delay_seconds + ' segundos',
                estimated_time: estimatedMinutes + ' minutos'
            });
            
            // Preparar datos multimedia
            const mediaData = {
                media_type: media_type || 'text',
                media_url: media_url || null,
                media_caption: media_caption || null
            };
            
            // Procesar campaña en background
            setTimeout(() => {
                this.campaignProcessor.processDistributedCampaign(
                    distribution, 
                    campaign_id, 
                    delay_seconds, 
                    user_id, 
                    php_callback, 
                    mediaData
                );
            }, 1000);
            
        } catch (error) {
            logger.error(`Error en distribución de campaña: ${error.message}`);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // Estadísticas
    getStats(req, res) {
        try {
            const today = this.sessionManager.getCurrentDate();
            const sessionStats = Array.from(this.sessionManager.clients.keys()).map(sessionId => ({
                sessionId,
                messagesCount: this.sessionManager.getMessageCount(sessionId),
                isReady: this.sessionManager.clients.get(sessionId)?.isReady || false
            }));
            
            const totalToday = sessionStats.reduce((total, session) => total + session.messagesCount, 0);
            
            res.json({
                date: today,
                totalToday,
                sessions: sessionStats,
                activeSession: this.sessionManager.activeSessionId,
                queueStatus: this.campaignProcessor.getQueueStatus()
            });
            
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // Estado de campaña
    getCampaignStatus(req, res) {
        const campaign_id = req.params.campaign_id;
        const campaignInfo = this.campaignProcessor.getCampaignStatus(campaign_id);
        
        if (!campaignInfo) {
            return res.status(404).json({ success: false, error: 'Campaña no encontrada' });
        }
        
        res.json({
            success: true,
            campaign_id: campaign_id,
            total_contacts: campaignInfo.total_contacts,
            processed: campaignInfo.processed,
            failed: campaignInfo.failed,
            progress_percentage: Math.round((campaignInfo.processed / campaignInfo.total_contacts) * 100),
            elapsed_time: Math.floor((new Date() - campaignInfo.start_time) / 1000) + ' segundos'
        });
    }

    // Envío de campaña con distribución automática y compensación de carga
    async sendCampaignDistributedAutomatic(req, res) {
        try {
            const { 
                campaign_id, 
                campaign_name,
                contacts, 
                delay_seconds = 15,
                user_id,
                media_type,
                media_url,
                media_caption,
                sessions
            } = req.body;
            
            if (!contacts || contacts.length === 0) {
                return res.status(400).json({ success: false, error: 'No hay contactos para enviar' });
            }
            
            // Sesiones conectadas
            let availableSessions = Array.from(this.sessionManager.clients.entries())
                .filter(([sessionId, sessionData]) => sessionData.isReady)
                .map(([sessionId]) => sessionId);

            // Filtrar por sesiones específicas si se proporcionan
            if (Array.isArray(sessions) && sessions.length > 0) {
                const wanted = new Set(sessions);
                availableSessions = availableSessions.filter(sid => wanted.has(sid));
            }
            
            if (availableSessions.length === 0) {
                return res.status(400).json({ success: false, error: 'No hay números de WhatsApp conectados' });
            }
            
            logger.campaign(`🚀 Distribución automática: ${contacts.length} contactos entre ${availableSessions.length} sesiones`, campaign_id);
            
            // Preparar datos de multimedia
            const mediaData = {
                media_type: media_type || 'text',
                media_url: media_url || null,
                media_caption: media_caption || null
            };
            
            // Calcular estimación de tiempo
            const contactsPerSession = Math.ceil(contacts.length / availableSessions.length);
            const estimatedSeconds = contactsPerSession * delay_seconds;
            const estimatedMinutes = Math.ceil(estimatedSeconds / 60);
            
            // Respuesta inmediata
            res.status(202).json({
                success: true,
                message: 'Campaña con distribución automática iniciada',
                campaign_id,
                campaign_name: campaign_name || `Campaña ${campaign_id}`,
                sessions_count: availableSessions.length,
                total_contacts: contacts.length,
                delay_seconds,
                estimated_time: `${estimatedMinutes} minutos`,
                mode: 'automatic_distribution',
                load_balancing: true
            });
            
            // Procesar en background
            setTimeout(() => {
                this.campaignProcessor.processDistributedCampaignAutomatic(
                    contacts, 
                    campaign_id, 
                    delay_seconds, 
                    mediaData,
                    sessions
                ).catch(error => {
                    logger.error(`Error en distribución automática de campaña ${campaign_id}: ${error.message}`);
                });
            }, 500);
            
        } catch (error) {
            logger.error(`Error en distribución automática: ${error.message}`);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // Test de conexión
    testConnection(req, res) {
        res.json({ 
            success: true, 
            message: 'WhatsApp server working!',
            timestamp: new Date().toISOString(),
            config: {
                campaign_mode: config.CAMPAIGN_MODE,
                default_delay: config.DEFAULT_DELAY
            }
        });
    }

    // Reiniciar sesión atascada
    restartSession(req, res) {
        try {
            const { sessionId } = req.body;
            
            if (!sessionId) {
                return res.status(400).json({ success: false, error: 'sessionId requerido' });
            }
            
            const sessionData = this.sessionManager.clients.get(sessionId);
            if (!sessionData) {
                return res.status(404).json({ success: false, error: 'Sesión no encontrada' });
            }
            
            logger.session(`Reiniciando sesión atascada: ${sessionId}`, sessionId);
            
            // Destruir cliente actual
            if (sessionData.client) {
                try {
                    sessionData.client.removeAllListeners();
                    sessionData.client.destroy();
                } catch (error) {
                    logger.warn(`Error destruyendo cliente: ${error.message}`, sessionId);
                }
            }
            
            // Resetear estado
            sessionData.isReady = false;
            sessionData.qrCode = null;
            sessionData.clientInfo = null;
            
            // Recrear cliente
            const newSessionData = this.sessionManager.createClient(sessionId);
            
            // Inicializar después de un delay
            setTimeout(() => {
                logger.session(`Inicializando sesión reiniciada: ${sessionId}`, sessionId);
                newSessionData.client.initialize();
            }, 2000);
            
            res.json({ 
                success: true, 
                message: `Sesión ${sessionId} reiniciada. Esperando nueva conexión...`,
                sessionId: sessionId
            });
            
        } catch (error) {
            logger.error(`Error reiniciando sesión: ${error.message}`);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // Reconectar sesión específica con QR
    reconnectSession(req, res) {
        try {
            const { sessionId } = req.body;
            
            if (!sessionId) {
                return res.status(400).json({ success: false, error: 'sessionId requerido' });
            }
            
            logger.session(`Reconectando sesión específica: ${sessionId}`, sessionId);
            
            // Limpiar sesión existente si existe
            if (this.sessionManager.clients.has(sessionId)) {
                const existingData = this.sessionManager.clients.get(sessionId);
                if (existingData.client) {
                    try {
                        existingData.client.removeAllListeners();
                        existingData.client.destroy();
                    } catch (error) {
                        logger.warn(`Error limpiando sesión ${sessionId}: ${error.message}`, sessionId);
                    }
                }
            }
            
            // Crear nueva sesión
            const sessionData = this.sessionManager.createClient(sessionId);
            logger.success(`Sesión ${sessionId} recreada, inicializando...`, sessionId);
            
            // Inicializar con delay
            setTimeout(() => {
                sessionData.client.initialize();
            }, 1000);
            
            res.json({ 
                success: true, 
                message: `Reconectando sesión ${sessionId}. Nuevo QR generándose...`,
                sessionId: sessionId
            });
            
        } catch (error) {
            logger.error(`Error reconectando sesión: ${error.message}`);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // Limpiar carpetas huérfanas
    async cleanupFolders(req, res) {
        try {
            const fs = require('fs');
            const path = require('path');
            
            const authDir = '.wwebjs_auth';
            
            if (!fs.existsSync(authDir)) {
                return res.json({ 
                    success: true, 
                    message: 'No existe carpeta .wwebjs_auth',
                    folders_removed: 0,
                    total_folders: 0,
                    active_sessions: this.sessionManager.clients.size
                });
            }
            
            // Leer todas las carpetas de sesiones
            const allFolders = fs.readdirSync(authDir).filter(dir => {
                try {
                    const fullPath = path.join(authDir, dir);
                    return fs.statSync(fullPath).isDirectory() && dir.startsWith('session-');
                } catch (e) {
                    return false;
                }
            });
            
            // Obtener sesiones activas
            const activeSessions = Array.from(this.sessionManager.clients.keys());
            const savedSessionsArray = Array.from(this.sessionManager.savedSessions);
            
            logger.info(`Análisis de carpetas: ${allFolders.length} total, ${activeSessions.length} activas, ${savedSessionsArray.length} guardadas`);
            
            // Identificar carpetas huérfanas
            const orphanedFolders = allFolders.filter(folder => {
                const sessionId = folder.replace('session-', '');
                const isActive = activeSessions.includes(sessionId);
                const isSaved = savedSessionsArray.includes(sessionId);
                
                if (!isActive && !isSaved) {
                    logger.debug(`Carpeta huérfana detectada: ${folder} (ID: ${sessionId})`);
                    return true;
                }
                
                return false;
            });
            
            let removedCount = 0;
            const removedFolders = [];
            const blockedFolders = [];
            
            logger.info(`Procesando ${orphanedFolders.length} carpetas huérfanas...`);
            
            // Eliminar carpetas huérfanas
            for (const folder of orphanedFolders) {
                try {
                    const folderPath = path.join(authDir, folder);
                    const sessionId = folder.replace('session-', '');
                    
                    logger.debug(`Eliminando carpeta huérfana: ${folder}...`);
                    
                    // Usar la función de eliminación del sessionManager
                    const success = await this.sessionManager.deleteSessionFolderWithRetry(sessionId, 2);
                    
                    if (success) {
                        removedCount++;
                        removedFolders.push(folder);
                        logger.success(`Eliminada: ${folder}`);
                    } else {
                        blockedFolders.push(folder);
                        logger.warn(`Bloqueada: ${folder}`);
                    }
                    
                } catch (error) {
                    blockedFolders.push(folder);
                    logger.error(`Error eliminando ${folder}: ${error.message}`);
                }
            }
            
            // Preparar respuesta detallada
            let message = `Limpieza completada`;
            if (blockedFolders.length > 0) {
                message += `. ${blockedFolders.length} carpetas bloqueadas por Chrome`;
            }
            
            const response = {
                success: true,
                message: message,
                total_folders: allFolders.length,
                active_sessions: activeSessions.length,
                orphaned_folders: orphanedFolders.length,
                folders_removed: removedCount,
                folders_blocked: blockedFolders.length,
                removed_folders: removedFolders,
                blocked_folders: blockedFolders,
                recommendation: blockedFolders.length > 0 ? 
                    "Cierra todas las ventanas de Chrome y ejecuta limpieza nuevamente" : null
            };
            
            logger.info(`Resultado de limpieza: ${removedCount} eliminadas, ${blockedFolders.length} bloqueadas`);
            
            res.json(response);
            
        } catch (error) {
            logger.error(`Error en limpieza de carpetas: ${error.message}`);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // Utilidades
    formatPhone(phone) {
        let cleanPhone = phone.replace(/[^0-9+]/g, '');
        if (!cleanPhone.startsWith('+')) {
            if (cleanPhone.startsWith('56')) {
                cleanPhone = '+' + cleanPhone;
            } else {
                cleanPhone = '+56' + cleanPhone;
            }
        }
        return cleanPhone;
    }
    
    // 🔧 CORREGIR ESTADOS DE MENSAJES
    async fixMessageStates(req, res) {
        try {
            const database = require('./database');
            const campaignFix = require('../campaign-fix');
            
            logger.info('🔧 Iniciando corrección de estados de mensajes...');
            
            // Ejecutar corrección desde database.js
            const dbFixed = await database.fixMessageStates();
            
            // Ejecutar corrección desde campaign-fix.js
            const campaignFixed = await campaignFix.fixMessageStates();
            
            res.json({
                success: true,
                message: 'Estados de mensajes corregidos',
                database_fix: dbFixed,
                campaign_fix: campaignFixed,
                timestamp: new Date().toISOString()
            });
            
        } catch (error) {
            logger.error(`Error en corrección de estados: ${error.message}`);
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
}

module.exports = Routes;