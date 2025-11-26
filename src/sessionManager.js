// src/sessionManager.js - Gestión de sesiones de WhatsApp
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const config = require('./config');
const logger = require('./logger');
const database = require('./database');
const campaignFix = require('../campaign-fix');

class SessionManager {
    constructor() {
        this.clients = new Map();
        this.activeSessionId = null;
        this.messageCounters = new Map();
        this.savedSessions = new Set();
        this.sessionHealth = new Map();
        this.pendingVerifications = new Map();
    }
    
    getCurrentDate() {
        return new Date().toISOString().split('T')[0];
    }
    
    getMessageCount(sessionId) {
        const today = this.getCurrentDate();
        const counter = this.messageCounters.get(sessionId);
        
        if (!counter || counter.date !== today) {
            this.messageCounters.set(sessionId, { date: today, count: 0 });
            return 0;
        }
        
        return counter.count;
    }
    
    incrementMessageCount(sessionId) {
        const today = this.getCurrentDate();
        const counter = this.messageCounters.get(sessionId);
        
        if (!counter || counter.date !== today) {
            this.messageCounters.set(sessionId, { date: today, count: 1 });
        } else {
            counter.count += 1;
            this.messageCounters.set(sessionId, counter);
        }
        
        const newCount = this.messageCounters.get(sessionId).count;
        logger.debug(`Mensajes hoy: ${newCount}`, sessionId);
        return newCount;
    }
    
    createClient(sessionId = 'principal') {
        logger.info(`Creando cliente para sesión: ${sessionId}`);
        
        const client = new Client({
            authStrategy: new LocalAuth({
                clientId: sessionId,
                dataPath: '.wwebjs_auth'
            }),
            puppeteer: {
                headless: true,
                args: config.PUPPETEER_ARGS,
                timeout: config.WHATSAPP_CONFIG.timeout,
                protocolTimeout: config.WHATSAPP_CONFIG.protocolTimeout,
                executablePath: undefined // Usar Chrome/Chromium por defecto
            },
            webVersionCache: config.WHATSAPP_CONFIG.webVersionCache,
            qrMaxRetries: config.WHATSAPP_CONFIG.qrMaxRetries,
            restartOnAuthFail: config.WHATSAPP_CONFIG.restartOnAuthFail,
            takeoverOnConflict: config.WHATSAPP_CONFIG.takeoverOnConflict,
            takeoverTimeoutMs: config.WHATSAPP_CONFIG.takeoverTimeoutMs
        });

        const sessionData = {
            client: client,
            isReady: false,
            qrCode: null,
            clientInfo: null,
            sessionId: sessionId,
            createdAt: new Date().toISOString(),
            lastActivity: new Date().toISOString()
        };

        this.clients.set(sessionId, sessionData);
        this.savedSessions.add(sessionId);
        
        if (!this.messageCounters.has(sessionId)) {
            this.messageCounters.set(sessionId, { date: this.getCurrentDate(), count: 0 });
        }
        
        this.setupClientEvents(sessionId);
        
        return sessionData;
    }
    
    setupClientEvents(sessionId) {
        const sessionData = this.clients.get(sessionId);
        if (!sessionData) return;
        
        const client = sessionData.client;

        client.on('error', (error) => {
            logger.error(`Error crítico en sesión: ${error.message}`, sessionId);
            
            if (error.message.includes('EBUSY') || error.message.includes('resource busy')) {
                logger.warn('Archivo bloqueado detectado - no reintentando', sessionId);
                sessionData.isReady = false;
                return;
            }
            
            if (error.message.includes('Protocol error') || error.message.includes('Execution context was destroyed')) {
                logger.info('Reintentando conexión en 30 segundos...', sessionId);
                setTimeout(() => {
                    this.cleanupClient(sessionId);
                    const newSessionData = this.createClient(sessionId);
                    newSessionData.client.initialize();
                }, 30000);
            }
        });

        client.on('qr', (qr) => {
            logger.info('QR generado, esperando escaneo...', sessionId);
            if (config.LOGGING.level === 'DEBUG') {
                qrcode.generate(qr, { small: true });
            }
            sessionData.qrCode = qr;
            sessionData.isReady = false;
        });

        client.on('ready', () => {
            logger.session('Sesión conectada y lista!', sessionId);
            sessionData.isReady = true;
            sessionData.qrCode = null;
            sessionData.clientInfo = client.info;
            sessionData.lastActivity = new Date().toISOString();
            
            logger.info(`Usuario: ${sessionData.clientInfo.pushname}`, sessionId);
            logger.info(`Número: ${sessionData.clientInfo.wid.user}`, sessionId);
            
            if (!this.activeSessionId) {
                this.activeSessionId = sessionId;
                logger.info(`Sesión activa por defecto: ${sessionId}`);
            }
        });

        client.on('authenticated', () => {
            logger.info('Sesión autenticada', sessionId);
        });

        client.on('auth_failure', (msg) => {
            logger.error(`Error autenticación: ${msg}`, sessionId);
            sessionData.isReady = false;
            sessionData.qrCode = null;
        });

        client.on('disconnected', (reason) => {
            logger.warn(`Sesión desconectada: ${reason}`, sessionId);
            sessionData.isReady = false;
            sessionData.clientInfo = null;
            
            if (this.activeSessionId === sessionId) {
                const availableSession = Array.from(this.clients.entries())
                    .find(([id, data]) => id !== sessionId && data.isReady);
                
                if (availableSession) {
                    this.activeSessionId = availableSession[0];
                    logger.info(`Cambiando sesión activa a: ${this.activeSessionId}`);
                } else {
                    this.activeSessionId = null;
                }
            }
            
            if (reason === 'LOGOUT') {
                // Mantener sesión visible en interfaz (aparecerá en rojo)
                logger.warn(`⚠️ Sesión ${sessionId} desconectada por logout. Manteniendo visible en interfaz.`);
                logger.info('💡 Para reconectar, usa la interfaz web: http://localhost:3001');
                sessionData.isReady = false;
                sessionData.clientInfo = null;
                sessionData.qrCode = null;
                return;
            }
            
            if (reason !== 'NAVIGATION') {
                setTimeout(() => {
                    logger.info('Reconectando sesión...', sessionId);
                    try {
                        client.initialize();
                    } catch (error) {
                        logger.error(`Error en reconexión: ${error.message}`, sessionId);
                    }
                }, 5000);
            }
        });

        client.on('message', async (message) => {
            if (!message.fromMe && message.body.length > 0) {
                const senderPhone = message.from.replace('@c.us', '');
                logger.debug(`Mensaje recibido de ${senderPhone}: ${message.body.substring(0, 30)}...`, sessionId);
                await this.processReceivedResponse(senderPhone, message.body, message);
            }
        });
    }
    
    async processReceivedResponse(phone, messageText, messageInfo) {
        const formattedPhone = phone.startsWith('+') ? phone : '+' + phone;
        
        const savedToDB = await database.saveResponse(formattedPhone, messageText, messageInfo.id);
        
        if (savedToDB) {
            logger.success(`Respuesta guardada en BD para ${formattedPhone}`);
            await database.updateMessageStatus(formattedPhone, 'read', messageInfo.id);
        } else {
            logger.warn(`No se pudo guardar respuesta en BD para ${formattedPhone}`);
        }
    }
    
    getActiveClient() {
        if (!this.activeSessionId) return null;
        
        const sessionData = this.clients.get(this.activeSessionId);
        if (!sessionData || !sessionData.isReady) return null;
        
        return sessionData;
    }
    
    async cleanupClient(sessionId) {
        const sessionData = this.clients.get(sessionId);
        
        logger.info('Iniciando limpieza COMPLETA de cliente', sessionId);
        
        if (sessionData && sessionData.client) {
            try {
                sessionData.client.removeAllListeners();
                
                if (sessionData.isReady) {
                    logger.info('Cerrando sesión activa...', sessionId);
                    try {
                        await sessionData.client.logout();
                    } catch (logoutError) {
                        logger.warn(`Error en logout: ${logoutError.message}`, sessionId);
                    }
                }
                
                logger.info('Destruyendo cliente...', sessionId);
                await sessionData.client.destroy();
                
                logger.info('Esperando 3 segundos para que Chrome libere archivos...', sessionId);
                await new Promise(resolve => setTimeout(resolve, 3000));
                
            } catch (error) {
                logger.warn(`Error limpiando cliente: ${error.message}`, sessionId);
            }
        }
        
        this.clients.delete(sessionId);
        
        if (this.pendingVerifications.has(sessionId)) {
            clearTimeout(this.pendingVerifications.get(sessionId));
            this.pendingVerifications.delete(sessionId);
        }
        
        await this.deleteSessionFolderWithRetry(sessionId, 3);
    }
    
    async deleteSessionFolderWithRetry(sessionId, maxRetries = 3) {
        const fs = require('fs');
        const path = require('path');
        
        const authDir = '.wwebjs_auth';
        const sessionFolder = `session-${sessionId}`;
        const sessionPath = path.join(authDir, sessionFolder);
        
        if (!fs.existsSync(sessionPath)) {
            logger.debug(`Carpeta ${sessionPath} no existe (ya eliminada)`);
            return true;
        }
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                logger.debug(`Intento ${attempt}/${maxRetries} eliminando ${sessionPath}...`);
                
                fs.rmSync(sessionPath, { recursive: true, force: true });
                
                logger.success(`Carpeta ${sessionPath} eliminada exitosamente`);
                return true;
                
            } catch (error) {
                logger.warn(`Intento ${attempt} falló: ${error.message}`);
                
                if (error.code === 'EBUSY' || error.code === 'ENOTEMPTY') {
                    if (attempt < maxRetries) {
                        const waitTime = attempt * 2000;
                        logger.info(`Archivo ocupado, esperando ${waitTime/1000}s antes del siguiente intento...`);
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                    } else {
                        logger.error(`Carpeta ${sessionPath} tiene archivos bloqueados por Chrome`);
                        return false;
                    }
                } else {
                    logger.error(`Error inesperado eliminando ${sessionPath}: ${error.message}`);
                    return false;
                }
            }
        }
        
        return false;
    }
    
    loadSavedSessions() {
        try {
            const fs = require('fs');
            const path = require('path');
            
            const authDir = '.wwebjs_auth';
            
            if (!fs.existsSync(authDir)) {
                logger.info('No existe carpeta .wwebjs_auth, creando sesión principal');
                this.savedSessions.add('principal');
                return;
            }
            
            const sessionDirs = fs.readdirSync(authDir).filter(dir => {
                try {
                    const fullPath = path.join(authDir, dir);
                    const stat = fs.statSync(fullPath);
                    return stat.isDirectory() && dir.startsWith('session-');
                } catch (e) {
                    return false;
                }
            });
            
            sessionDirs.forEach(dir => {
                let sessionId = null;
                
                if (dir.startsWith('session-messagehub-')) {
                    sessionId = dir.replace('session-messagehub-', '');
                } else if (dir.startsWith('session-')) {
                    sessionId = dir.replace('session-', '');
                }
                
                if (sessionId) {
                    this.savedSessions.add(sessionId);
                    logger.debug(`Sesión encontrada: ${sessionId}`);
                }
            });
            
            if (this.savedSessions.size === 0) {
                this.savedSessions.add('principal');
                logger.info('Creando sesión principal por defecto');
            }
            
            logger.info(`Total sesiones para cargar: ${this.savedSessions.size}`);
            
        } catch (error) {
            logger.warn(`Error cargando sesiones guardadas: ${error.message}`);
            this.savedSessions.add('principal');
        }
    }
    
    autoInitializeSessions() {
        logger.info('Auto-inicializando sesiones guardadas...');
        
        const sessionArray = Array.from(this.savedSessions);
        let currentIndex = 0;
        
        const initializeNext = () => {
            if (currentIndex >= sessionArray.length) {
                logger.success('Todas las sesiones inicializadas');
                return;
            }
            
            const sessionId = sessionArray[currentIndex];
            logger.info(`Inicializando sesión ${currentIndex + 1}/${sessionArray.length}: ${sessionId}`);
            
            try {
                const sessionData = this.createClient(sessionId);
                sessionData.client.initialize();
                
                setTimeout(() => {
                    currentIndex++;
                    initializeNext();
                }, 3000);
                
            } catch (error) {
                logger.error(`Error inicializando ${sessionId}: ${error.message}`);
                currentIndex++;
                setTimeout(initializeNext, 2000);
            }
        };
        
        initializeNext();
    }
}

module.exports = SessionManager;
