// src/campaignProcessor.js - Procesador de campañas con distribución automática y compensación de carga
const { MessageMedia } = require('whatsapp-web.js');
const config = require('./config');
const logger = require('./logger');
const database = require('./database');
const utils = require('./utils');
const campaignFix = require('../campaign-fix');
const { pauseCampaign, isCampaignPaused } = require('./campaignPause');
const fs = require('fs');

// ===== Utilidades de Media (robustas) =====
const http = require('http');
const https = require('https');
const path = require('path');

function guessMimeFromExt(filename) {
  const lower = (filename || '').toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.mp4') || lower.endsWith('.mov')) return 'video/mp4';
  if (lower.endsWith('.doc') || lower.endsWith('.docx')) return 'application/msword';
  return 'application/octet-stream';
}

function robustFetchBuffer(fileUrl) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(fileUrl);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(robustFetchBuffer(res.headers.location));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
}

async function makeMessageMediaFromUrl(fileUrl, explicitMime) {
  let targetUrl = fileUrl;
  try {
    const u = new URL(fileUrl);
    if ((u.hostname === 'localhost' || u.hostname === '127.0.0.1')
        && /\/sistemasms\/uploads\//.test(u.pathname)
        && !/\/sistemasms\/backend\/uploads\//.test(u.pathname)) {
      u.pathname = u.pathname.replace('/sistemasms/uploads/', '/sistemasms/backend/uploads/');
      targetUrl = u.toString();
      console.log(`🔧 media_url corregida: ${targetUrl}`);
    }
  } catch (_e0) {
    // fileUrl no era URL válida, seguimos con lo que venga
  }

  try {
    const media = await MessageMedia.fromUrl(targetUrl, { unsafeMime: true });
    if (explicitMime && !media.mimetype) media.mimetype = explicitMime;
    return media;
  } catch (e1) {
    console.log(`⚠️ Falla MessageMedia.fromUrl -> ${e1.message}. Reintentando con descarga manual...`);
    try {
      const buf = await robustFetchBuffer(targetUrl);
      const b64 = buf.toString('base64');
      const fileName = path.basename(new URL(targetUrl).pathname || 'archivo');
      const mime = explicitMime || guessMimeFromExt(fileName);
      return new MessageMedia(mime, b64, fileName);
    } catch (e2) {
      // Fallback a disco local si es localhost (XAMPP)
      try {
        const u = new URL(targetUrl);
        if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
          const filename = path.basename(u.pathname || '');
          const candidates = [
            'C:\\xampp\\htdocs\\sistemasms\\backend\\uploads\\campaign-images\\' + filename,
            'C:\\xampp\\htdocs\\backend\\uploads\\campaign-images\\' + filename,
            'C:\\xampp\\htdocs\\sistemasms\\uploads\\campaign-images\\' + filename
          ];
          for (const p of candidates) {
            if (fs.existsSync(p)) {
              const buf2 = fs.readFileSync(p);
              const b64 = buf2.toString('base64');
              const mime = explicitMime || guessMimeFromExt(filename);
              console.log(`📄 Cargando imagen desde disco: ${p}`);
              return new MessageMedia(mime, b64, filename);
            }
          }
        }
      } catch (_e3) {}
      throw e1;
    }
  }
}

class CampaignProcessor {
    constructor(sessionManager) {
        this.sessionManager = sessionManager;
        this.campaignStatus = new Map();
        this.messageQueue = [];
        this.isProcessingQueue = false;
        this.queueProcessor = null;
        
        // 🆕 ESTRUCTURAS PARA DISTRIBUCIÓN AUTOMÁTICA CON COMPENSACIÓN
        this.activeWorkers = new Map(); // sessionId -> worker info
        this.campaignWorkers = new Map(); // campaignId -> worker details
        this.sessionQueues = new Map(); // sessionId -> cola de mensajes
        this.failedSessions = new Set(); // sesiones que han fallado
        this.activeCampaigns = new Map(); // campaignId -> campaign info
        this.campaignStats = new Map(); // campaignId -> estadísticas
        
        // Pausa / reanuda campañas
        this.pausedCampaigns = new Set();
        // Bind pause helpers (implemented in src/campaignPause.js)
        this.pauseCampaign = pauseCampaign.bind(this);
        this.isCampaignPaused = isCampaignPaused.bind(this);
    }

    // 🚀 NUEVA FUNCIÓN: DISTRIBUCIÓN AUTOMÁTICA CON COMPENSACIÓN DE CARGA
    async processDistributedCampaignAutomatic(contacts, campaignId, delaySeconds = 15, mediaData = null, selectedSessions = null) {
        try {
            const campaignName = `Campaña ${campaignId}`;
            
            // 🔄 Asegurar reanudación: si estaba pausada, quitar de la lista de pausadas
            if (this.pausedCampaigns && this.pausedCampaigns.has(String(campaignId))) {
                this.pausedCampaigns.delete(String(campaignId));
                logger?.info ? logger.info(`▶️ Reanudando campaña ${campaignId}: removida de pausedCampaigns`, campaignId) : console.log(`▶️ Reanudando campaña ${campaignId}: removida de pausedCampaigns`);
            }
            
            // Obtener sesiones disponibles
            let availableSessions = Array.from(this.sessionManager.clients.entries())
                .filter(([sessionId, sessionData]) => sessionData.isReady)
                .map(([sessionId, sessionData]) => ({
                    sessionId,
                    clientInfo: sessionData.clientInfo
                }));

            // Filtrar por sesiones seleccionadas si se especifica
            if (selectedSessions && Array.isArray(selectedSessions) && selectedSessions.length > 0) {
                availableSessions = availableSessions.filter(session => 
                    selectedSessions.includes(session.sessionId)
                );
            }

            if (availableSessions.length === 0) {
                throw new Error('No hay sesiones de WhatsApp conectadas');
            }

            // Limpiar sesiones fallidas de campañas anteriores
            this.failedSessions.clear();

            // Distribuir contactos equitativamente
            const distribution = this.distributeContactsAutomatically(contacts, availableSessions, campaignId);
            
            // Calcular estimación de tiempo
            const maxContactsPerSession = Math.max(...Array.from(distribution.values()).map(arr => arr.length));
            const estimatedSeconds = maxContactsPerSession * delaySeconds;
            const estimatedMinutes = Math.ceil(estimatedSeconds / 60);

            // 🔒 REGISTRAR CAMPAÑA ACTIVA PARA PREVENIR AUTO-LOGOUT
            campaignFix.registerActiveCampaign(campaignId);
            
            // 📊 MARCAR CAMPAÑA COMO 'SENDING' EN BASE DE DATOS
            try {
                // Leer estado actual en BD y respetar 'paused'
                const current = await database.getCampaignStatusFromDB(campaignId);
                if (current && current.status === 'paused') {
                    logger.info(`ℹ️ Campaña ${campaignId} está en estado 'paused' en BD — no se marcará como 'sending'`, campaignId);
                } else {
                    await database.updateCampaignStatus(campaignId, 'sending');
                    logger.info(`📊 Campaña ${campaignId} marcada como 'sending' en BD`, campaignId);
                }
            } catch (error) {
                logger.error(`❌ Error marcando campaña ${campaignId} como 'sending': ${error.message}`, campaignId);
            }
            
            // Registrar campaña activa
            this.activeCampaigns.set(campaignId, {
                name: campaignName,
                totalContacts: contacts.length,
                sessions: availableSessions.length,
                delaySeconds,
                mediaData,
                startTime: new Date(),
                distribution: distribution
            });

            // Inicializar estadísticas
            this.campaignStats.set(campaignId, {
                total: contacts.length,
                sent: 0,
                failed: 0,
                pending: contacts.length,
                completedSessions: 0
            });

            // Log de inicio
            logger.campaign(`🚀 Campaña distribuida ${campaignId} | sesiones=${availableSessions.length} | delay=${delaySeconds}s`);
            logger.campaign(`🚀 [${new Date().toLocaleTimeString()}] [CAMPAÑA ${campaignId}] MODO DISTRIBUIDO (paralelo ${delaySeconds}s por sesión)`, campaignId);

            // Inicializar colas por sesión
            for (const [sessionId, sessionContacts] of distribution.entries()) {
                this.sessionQueues.set(sessionId, [...sessionContacts]);
            }

            // Crear workers paralelos para cada sesión
            const workerPromises = [];
            for (const [sessionId, sessionContacts] of distribution.entries()) {
                if (sessionContacts.length > 0) {
                    const workerPromise = this.createSessionWorker(sessionId, campaignId, delaySeconds, mediaData);
                    workerPromises.push(workerPromise);
                }
            }

            // Ejecutar todos los workers en paralelo
            await Promise.all(workerPromises);

            // Verificar si la campaña se completó exitosamente
            const stats = this.campaignStats.get(campaignId);
            if (stats) {
                logger.campaign(`✅ [${new Date().toLocaleTimeString()}] 🎉 Campaña ${campaignId} completada (${stats.sent} enviados, ${stats.failed} fallidos)`, campaignId);
            }

            return {
                success: true,
                message: 'Campaña distribuida completada',
                totalContacts: contacts.length,
                sessions: availableSessions.length,
                estimated_time: `${estimatedMinutes} minutos`,
                distribution: Array.from(distribution.entries()).map(([sessionId, contacts]) => ({
                    sessionId: this.getSessionDisplayName(sessionId),
                    contacts_assigned: contacts.length
                }))
            };

        } catch (error) {
            logger.error(`Error en distribución automática de campaña ${campaignId}: ${error.message}`);
            throw error;
        }
    }

    // 🔄 CREAR WORKER INDIVIDUAL PARA UNA SESIÓN
    async createSessionWorker(sessionId, campaignId, delaySeconds, mediaData) {
        const sessionDisplayName = this.getSessionDisplayName(sessionId);
        
        try {
            // Verificar que la sesión sigue activa
            const sessionData = this.sessionManager.clients.get(sessionId);
            if (!sessionData || !sessionData.isReady || this.failedSessions.has(sessionId)) {
                logger.warn(`Sesión ${sessionDisplayName} no disponible, redistribuyendo contactos pendientes...`, campaignId);
                this.redistributeFromFailedSession(sessionId, campaignId); // ← REHABILITADO con conteo preservado
                return;
            }

            const queue = this.sessionQueues.get(sessionId) || [];
            const totalQueue = this.getTotalPendingContacts(campaignId);
            
            logger.info(`⏱ ${sessionDisplayName}: enviando | quedan ${queue.length} aquí / ${totalQueue} total`, campaignId);
            logger.info(`▶️ Worker ${sessionDisplayName} iniciado | cola: ${queue.length} | delay: ${delaySeconds}s`, campaignId);

            // Registrar worker activo
            this.activeWorkers.set(sessionId, {
                campaignId,
                startTime: new Date(),
                totalAssigned: queue.length,
                processed: 0
            });

            // Procesar mensajes con delay - INCLUYE CONTACTOS REDISTRIBUIDOS
            while (true) {
                // Obtener cola actualizada (puede incluir contactos redistribuidos)
                const currentQueue = this.sessionQueues.get(sessionId) || [];
                
                if (currentQueue.length === 0 || this.failedSessions.has(sessionId)) {
                    break;
                }

                // Check if campaign is paused
                if (this.isCampaignPaused && this.isCampaignPaused(campaignId)) {
                    logger.info(`⏸️ Campaign ${campaignId} is paused, stopping processing`, campaignId);
                    break;
                }
                
                // Verificar que la sesión sigue conectada
                const currentSessionData = this.sessionManager.clients.get(sessionId);
                if (!currentSessionData || !currentSessionData.isReady) {
                    logger.warn(`Sesión ${sessionDisplayName} desconectada durante envío`, campaignId);
                    await this.handleSessionFailure(sessionId, campaignId);
                    break;
                }

                const contact = currentQueue.shift();
                this.sessionQueues.set(sessionId, currentQueue);
                
                // ⚠️ VERIFICAR PAUSA ANTES DE ENVIAR (después de sacar de cola)
                if (this.isCampaignPaused && this.isCampaignPaused(campaignId)) {
                    logger.info(`⏸️ Campaign ${campaignId} pausada - No se enviará ${contact.phone}`, campaignId);
                    // Devolver contacto a la cola
                    currentQueue.unshift(contact);
                    this.sessionQueues.set(sessionId, currentQueue);
                    break;
                }
                
                logger.info(`📤 Worker ${sessionDisplayName} procesando contacto ${contact.phone} (quedan ${currentQueue.length})`, campaignId);

                try {
                    await this.sendSingleMessage(sessionId, contact, mediaData, campaignId);
                    this.updateCampaignStats(campaignId, 'sent');
                    
                    const worker = this.activeWorkers.get(sessionId);
                    if (worker) {
                        worker.processed++;
                    }

                } catch (error) {
                    logger.error(`Error enviando mensaje desde ${sessionDisplayName}: ${error.message}`, campaignId);
                    this.updateCampaignStats(campaignId, 'failed');
                    
                    // Si hay demasiados errores consecutivos, marcar sesión como fallida
                    if (error.message.includes('Session closed') || error.message.includes('not ready')) {
                        logger.warn(`Sesión ${sessionDisplayName} presenta errores, marcando como fallida`, campaignId);
                        await this.handleSessionFailure(sessionId, campaignId);
                        break;
                    }
                }

                // Aplicar delay solo si no es el último mensaje
                const updatedQueue = this.sessionQueues.get(sessionId) || [];
                if (updatedQueue.length > 0) {
                    await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
                    
                    // ⚠️ VERIFICAR PAUSA DESPUÉS DEL DELAY (crucial para pausas durante el delay)
                    if (this.isCampaignPaused && this.isCampaignPaused(campaignId)) {
                        logger.info(`⏸️ Campaign ${campaignId} pausada después de delay - Deteniendo worker ${sessionDisplayName}`, campaignId);
                        break;
                    }
                }
            }

            // Log de finalización del worker
            const remainingInSession = this.sessionQueues.get(sessionId)?.length || 0;
            const totalRemaining = this.getTotalPendingContacts(campaignId);
            
            if (remainingInSession === 0) {
                logger.info(`⏹️ Worker ${sessionDisplayName} detenido`, campaignId);
            } else {
                logger.info(`⏱ ${sessionDisplayName}: ${remainingInSession} pendientes | total restante: ${totalRemaining} | deteniendo worker...`, campaignId);
                logger.info(`⏹️ Worker ${sessionDisplayName} detenido`, campaignId);
            }

            // Limpiar worker
            this.activeWorkers.delete(sessionId);
            
            // NO verificar completitud aquí - esperar a que todos los workers terminen
            const remainingWorkers = Array.from(this.activeWorkers.values())
                .filter(worker => worker.campaignId === campaignId).length;
            
            if (remainingWorkers === 0) {
                // Solo verificar completitud cuando NO hay workers activos
                setTimeout(() => this.checkCampaignCompletion(campaignId), 1000);
            } else {
                logger.info(`⏳ Quedan ${remainingWorkers} workers activos para campaña ${campaignId}`, campaignId);
            }

        } catch (error) {
            logger.error(`Error en worker ${sessionDisplayName}: ${error.message}`, campaignId);
            await this.handleSessionFailure(sessionId, campaignId);
        }
    }

    // 📊 MANEJAR FALLA DE SESIÓN CON REDISTRIBUCIÓN INTELIGENTE (PRESERVA CONTEO DE ENVIADOS)
    async handleSessionFailure(sessionId, campaignId) {
        if (!this.failedSessions.has(sessionId)) {
            logger.warn(`🚨 Falla detectada en sesión ${this.getSessionDisplayName(sessionId)} - redistribuyendo pendientes`, campaignId);
            this.failedSessions.add(sessionId);
            
            // Redistribuir contactos pendientes
            const redistributionResult = this.redistributeFromFailedSession(sessionId, campaignId);
            
            // Limpiar worker fallido
            this.activeWorkers.delete(sessionId);
            
            // Verificar si hay sesiones que recibieron contactos redistribuidos
            if (redistributionResult && redistributionResult.redistributed > 0) {
                logger.info(`🔄 ${redistributionResult.redistributed} contactos redistribuidos a ${redistributionResult.activeSessions} sesiones`, campaignId);
                
                // Los workers existentes continuarán procesando automáticamente
                // porque ahora verifican la cola actualizada en cada iteración
                logger.info(`✅ Los workers activos procesarán automáticamente los contactos redistribuidos`, campaignId);
            } else {
                logger.warn(`⚠️ No se redistribuyeron contactos o no hay sesiones activas`, campaignId);
            }
            
            logger.info(`✅ Proceso de redistribución completado para ${this.getSessionDisplayName(sessionId)}`, campaignId);
        }
    }

    // 🔄 CREAR WORKERS PARA SESIONES QUE RECIBIERON REDISTRIBUCIÓN
    // ❌ FUNCIÓN DESHABILITADA: Los workers existentes ahora procesan automáticamente
    // los contactos redistribuidos verificando la cola actualizada en cada iteración
    async createWorkersForRedistribution(campaignId) {
        logger.info(`ℹ️ Workers de redistribución no necesarios - workers existentes procesan automáticamente`, campaignId);
        return;
    }

    // 📈 DISTRIBUCIÓN AUTOMÁTICA EQUITATIVA
    distributeContactsAutomatically(contacts, availableSessions, campaignId) {
        logger.campaign(`Distribuyendo ${contacts.length} contactos entre ${availableSessions.length} sesiones`, campaignId);
        
        // Verificar sesiones activas (excluir fallidas)
        const activeSessions = availableSessions.filter(session => {
            const isActive = this.sessionManager.clients.get(session.sessionId)?.isReady;
            const isFailed = this.failedSessions.has(session.sessionId);
            return isActive && !isFailed;
        });

        if (activeSessions.length === 0) {
            throw new Error('No hay sesiones activas disponibles');
        }

        // Calcular distribución equitativa
        const contactsPerSession = Math.floor(contacts.length / activeSessions.length);
        const remainder = contacts.length % activeSessions.length;
        
        const distribution = new Map();
        let currentIndex = 0;

        // Distribuir contactos
        activeSessions.forEach((session, index) => {
            const sessionId = session.sessionId;
            const baseCount = contactsPerSession + (index < remainder ? 1 : 0);
            
            const sessionContacts = contacts.slice(currentIndex, currentIndex + baseCount);
            currentIndex += baseCount;
            
            if (sessionContacts.length > 0) {
                distribution.set(sessionId, sessionContacts);
            }
        });

        // Log de distribución inicial
        const distributionLog = Array.from(distribution.entries())
            .map(([sessionId, contacts]) => `${this.getSessionDisplayName(sessionId)}: ${contacts.length}`)
            .join(' | ');
        
        logger.info(`Distribución inicial pareja → ${distributionLog}`);
        
        return distribution;
    }

    // 🔄 REDISTRIBUIR CONTACTOS PENDIENTES DE SESIÓN FALLIDA (PRESERVANDO CONTEO DE ENVIADOS)
    redistributeFromFailedSession(failedSessionId, campaignId) {
        const failedSessionName = this.getSessionDisplayName(failedSessionId);
        
        logger.warn(`🔄 REDISTRIBUYENDO contactos de sesión fallida: ${failedSessionName}`, campaignId);
        
        // Obtener contactos pendientes de la sesión fallida
        const failedQueue = this.sessionQueues.get(failedSessionId) || [];
        logger.info(`📦 Sesión ${failedSessionName} tenía ${failedQueue.length} contactos pendientes`, campaignId);
        
        if (failedQueue.length === 0) {
            logger.info(`✅ No hay contactos pendientes para redistribuir de ${failedSessionName}`, campaignId);
            return { redistributed: 0, reason: 'no_pending_contacts' };
        }

        // Obtener sesiones activas restantes
        const activeSessions = Array.from(this.sessionQueues.keys())
            .filter(sessionId => {
                const isActive = this.sessionManager.clients.get(sessionId)?.isReady;
                const isNotFailed = !this.failedSessions.has(sessionId);
                const isDifferent = sessionId !== failedSessionId;
                const isIncluded = isActive && isNotFailed && isDifferent;
                
                if (!isIncluded) {
                    logger.debug(`❌ ${this.getSessionDisplayName(sessionId)}: activa=${isActive}, sinFallos=${isNotFailed}, diferente=${isDifferent}`, campaignId);
                }
                
                return isIncluded;
            });

        logger.info(`🔍 Sesiones disponibles para redistribución: ${activeSessions.length}`, campaignId);
        activeSessions.forEach(sessionId => {
            const currentQueue = this.sessionQueues.get(sessionId)?.length || 0;
            logger.info(`  • ${this.getSessionDisplayName(sessionId)}: ${currentQueue} pendientes`, campaignId);
        });

        if (activeSessions.length === 0) {
            logger.error(`🚨 CRÍTICO: No hay sesiones activas para redistribuir ${failedQueue.length} contactos de ${failedSessionName}`, campaignId);
            return { redistributed: 0, reason: 'no_active_sessions' };
        }

        // Redistribuir equitativamente
        const contactsPerSession = Math.floor(failedQueue.length / activeSessions.length);
        const remainder = failedQueue.length % activeSessions.length;
        
        logger.info(`📊 Redistribución: ${contactsPerSession} por sesión, ${remainder} extras`, campaignId);
        
        let totalRedistributed = 0;
        let currentIndex = 0;
        
        activeSessions.forEach((sessionId, index) => {
            const count = contactsPerSession + (index < remainder ? 1 : 0);
            const redistributedContacts = failedQueue.slice(currentIndex, currentIndex + count);
            currentIndex += count;
            
            if (redistributedContacts.length > 0) {
                const existingQueue = this.sessionQueues.get(sessionId) || [];
                const newQueue = [...existingQueue, ...redistributedContacts];
                this.sessionQueues.set(sessionId, newQueue);
                
                totalRedistributed += redistributedContacts.length;
                
                logger.info(`➕ ${this.getSessionDisplayName(sessionId)}: +${redistributedContacts.length} contactos (total: ${newQueue.length})`, campaignId);
            }
        });

        // ✅ PRESERVAR CONTEO: Solo vaciar la cola, NO borrarla completamente
        // Esto mantiene el tracking de mensajes ya enviados pero limpia los pendientes
        this.sessionQueues.set(failedSessionId, []); // ← Vacía pero no borra la sesión
        
        // Log de nueva distribución completa
        const newDistributionLog = Array.from(this.sessionQueues.entries())
            .filter(([sessionId]) => activeSessions.includes(sessionId))
            .map(([sessionId, queue]) => `${this.getSessionDisplayName(sessionId)}: ${queue.length}`)
            .join(' | ');
        
        logger.info(`🎯 Nueva distribución → ${newDistributionLog}`, campaignId);
        logger.info(`✅ Redistribuidos ${totalRedistributed} contactos, conteo de ${failedSessionName} preservado`, campaignId);
        
        return { redistributed: totalRedistributed, activeSessions: activeSessions.length };
    }

    // 📱 ENVIAR MENSAJE INDIVIDUAL
    async sendSingleMessage(sessionId, contact, mediaData, campaignId) {
        const sessionData = this.sessionManager.clients.get(sessionId);
        if (!sessionData || !sessionData.isReady) {
            throw new Error('Session not ready');
        }

        const cleanPhone = utils.formatPhoneNumber(contact.phone);
        const chatId = cleanPhone.substring(1) + '@c.us';
        const sessionDisplayName = this.getSessionDisplayName(sessionId);

        try {
            let result;
            let mediaType = null;
            let mediaUrl = null;
            
            if (mediaData && mediaData.media_type && mediaData.media_type !== 'text' && mediaData.media_url) {
                // Envío con multimedia
                const media = await makeMessageMediaFromUrl(mediaData.media_url);
                const caption = mediaData.media_caption || contact.message;
                
                result = await sessionData.client.sendMessage(chatId, media, { caption });
                mediaType = mediaData.media_type;
                mediaUrl = mediaData.media_url;
                
                logger.info(`🖼️ [${new Date().toLocaleTimeString()}] MEDIA ENVIADA: ${contact.phone} (${contact.full_name})`, campaignId);
                
            } else {
                // Envío solo texto
                result = await sessionData.client.sendMessage(chatId, contact.message);
            }

            if (result?.to && global.__lidMapper) {
                const { normalizePhone, registerLidMapping } = global.__lidMapper;
                const normalizedLid = normalizePhone(result.to);
                if (normalizedLid && normalizedLid !== cleanPhone) {
                    registerLidMapping(normalizedLid, cleanPhone);
                }
            }

            // 💾 GUARDAR EN BASE DE DATOS (CRÍTICO PARA CONTEO CORRECTO)
            try {
                const messageId = result.id?.id || result.id || 'msg_' + Date.now();
                await database.saveMessage(
                    campaignId, 
                    contact.contact_id || contact.id, 
                    cleanPhone, 
                    contact.message, 
                    messageId,
                    mediaType,
                    mediaUrl
                );
                logger.info(`💾 [${sessionDisplayName}] Mensaje registrado en BD: ${contact.phone}`, campaignId);
            } catch (dbError) {
                logger.error(`❌ Error guardando en BD para ${contact.phone}: ${dbError.message}`, campaignId);
                // No fallar el envío por error de BD, pero log para debug
            }

            // Incrementar contador de mensajes
            this.sessionManager.incrementMessageCount(sessionId);
            
            logger.info(`📤 [${new Date().toLocaleTimeString()}] [${sessionDisplayName}] → ${contact.phone} (${contact.full_name})`, campaignId);
            
            return result;
            
        } catch (error) {
            logger.error(`❌ Error enviando a ${contact.phone} desde ${sessionDisplayName}: ${error.message}`, campaignId);
            
            // 💾 REGISTRAR FALLO EN BASE DE DATOS
            try {
                await database.updateMessageStatus(contact.contact_id || contact.id, campaignId, 'failed', error.message);
                logger.info(`💾 [${sessionDisplayName}] Fallo registrado en BD: ${contact.phone}`, campaignId);
            } catch (dbError) {
                logger.error(`❌ Error registrando fallo en BD: ${dbError.message}`, campaignId);
            }
            
            throw error;
        }
    }

    // 📊 ACTUALIZAR ESTADÍSTICAS DE CAMPAÑA
    updateCampaignStats(campaignId, type) {
        const stats = this.campaignStats.get(campaignId);
        if (stats) {
            if (type === 'sent') {
                stats.sent++;
                stats.pending--;
            } else if (type === 'failed') {
                stats.failed++;
                stats.pending--;
            }
            this.campaignStats.set(campaignId, stats);
        }
    }

    // 🎯 VERIFICAR COMPLETITUD DE CAMPAÑA (MEJORADO PARA REDISTRIBUCIÓN)
    async checkCampaignCompletion(campaignId) {
        const totalPending = this.getTotalPendingContacts(campaignId);
        const activeWorkersCount = Array.from(this.activeWorkers.values())
            .filter(worker => worker.campaignId === campaignId).length;

        logger.info(`🔍 Verificando completitud campaña ${campaignId}: ${totalPending} pendientes, ${activeWorkersCount} workers activos`, campaignId);

        if (totalPending === 0 && activeWorkersCount === 0) {
            // Esperar un momento para asegurar que no hay mensajes en tránsito
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Verificar nuevamente después del delay
            const finalPending = this.getTotalPendingContacts(campaignId);
            const finalWorkersCount = Array.from(this.activeWorkers.values())
                .filter(worker => worker.campaignId === campaignId).length;
            
            if (finalPending > 0 || finalWorkersCount > 0) {
                logger.info(`⏳ Campaña ${campaignId} aún en proceso: ${finalPending} pendientes, ${finalWorkersCount} workers`, campaignId);
                return;
            }
            
            // 📊 OBTENER CONTEO REAL DESDE BASE DE DATOS
            const stats = await this.getFinalCampaignStatsFromDB(campaignId);
            const campaignInfo = this.activeCampaigns.get(campaignId);
            const totalContacts = campaignInfo ? campaignInfo.totalContacts : 0;
            
            logger.campaign(`✅ [${new Date().toLocaleTimeString()}] 🎉 Campaña ${campaignId} completada (sin pendientes)`, campaignId);
            logger.campaign(`✅ [${new Date().toLocaleTimeString()}] 🎉 Campaña ${campaignId} completada (${stats.sent} enviados, ${stats.failed} fallidos)`, campaignId);
            
            // 📊 LOG DETALLADO DE ESTADÍSTICAS FINALES
            if (stats.sent + stats.failed < totalContacts) {
                const missing = totalContacts - (stats.sent + stats.failed);
                logger.warn(`⚠️ Discrepancia detectada: ${totalContacts} total, ${stats.sent + stats.failed} procesados, ${missing} faltantes`, campaignId);
                logger.warn(`🔍 Revisar si hay contactos que no se redistribuyeron correctamente`, campaignId);
            } else {
                logger.info(`✅ Conteo correcto: ${totalContacts} contactos = ${stats.sent} enviados + ${stats.failed} fallidos`, campaignId);
            }
            
            // 🔓 ACTUALIZAR ESTADO DE CAMPAÑA EN BASE DE DATOS
            try {
                const updateSuccess = await database.updateCampaignStatus(campaignId, 'completed', {
                    messages_sent: stats.sent,
                    messages_failed: stats.failed,
                    messages_delivered: stats.delivered || 0
                });
                
                if (updateSuccess) {
                    logger.info(`📊 Estado de campaña ${campaignId} actualizado a 'completed' en BD`, campaignId);
                } else {
                    logger.error(`❌ Error actualizando estado de campaña ${campaignId} en BD`, campaignId);
                }
            } catch (error) {
                logger.error(`❌ Error actualizando estado de campaña ${campaignId}: ${error.message}`, campaignId);
            }
            
            // 🔓 DESREGISTRAR CAMPAÑA COMPLETADA PARA PERMITIR AUTO-LOGOUT
            campaignFix.unregisterActiveCampaign(campaignId);
            
            // Limpiar datos de la campaña
            this.activeCampaigns.delete(campaignId);
            
            // Limpiar colas vacías
            for (const [sessionId, queue] of this.sessionQueues.entries()) {
                if (queue.length === 0) {
                    this.sessionQueues.delete(sessionId);
                }
            }
        } else {
            logger.info(`⏳ Campaña ${campaignId} en progreso: ${totalPending} pendientes, ${activeWorkersCount} workers activos`, campaignId);
        }
    }

    // 📊 OBTENER ESTADÍSTICAS FINALES DESDE BASE DE DATOS
    async getFinalCampaignStatsFromDB(campaignId) {
        try {
            // Contar mensajes enviados exitosamente
            const sentQuery = `
                SELECT COUNT(*) as sent_count 
                FROM message_logs 
                WHERE campaign_id = ? AND status IN ('sent', 'delivered', 'read')
            `;
            
            // Contar mensajes fallidos
            const failedQuery = `
                SELECT COUNT(*) as failed_count 
                FROM message_logs 
                WHERE campaign_id = ? AND status = 'failed'
            `;
            
            const connection = await database.connect();
            if (!connection) {
                logger.error(`No se pudo conectar a BD para estadísticas de campaña ${campaignId}`);
                return { sent: 0, failed: 0 };
            }
            
            const [sentResult] = await connection.execute(sentQuery, [campaignId]);
            const [failedResult] = await connection.execute(failedQuery, [campaignId]);
            
            const sent = sentResult[0]?.sent_count || 0;
            const failed = failedResult[0]?.failed_count || 0;
            
            logger.info(`📊 Estadísticas BD campaña ${campaignId}: ${sent} enviados, ${failed} fallidos`, campaignId);
            
            return { sent: parseInt(sent), failed: parseInt(failed) };
            
        } catch (error) {
            logger.error(`Error obteniendo estadísticas finales de campaña ${campaignId}: ${error.message}`);
            return { sent: 0, failed: 0 };
        }
    }

    // 📊 OBTENER TOTAL DE CONTACTOS PENDIENTES
    getTotalPendingContacts(campaignId) {
        return Array.from(this.sessionQueues.values())
            .reduce((total, queue) => total + queue.length, 0);
    }

    // 📱 OBTENER NOMBRE DISPLAY DE SESIÓN
    getSessionDisplayName(sessionId) {
        const sessionData = this.sessionManager.clients.get(sessionId);
        if (sessionData?.clientInfo?.wid?.user) {
            return sessionData.clientInfo.wid.user;
        }
        return sessionId;
    }

    // 📊 OBTENER ESTADO DE CAMPAÑA
    getCampaignStatus(campaignId) {
        const stats = this.campaignStats.get(campaignId);
        const campaignInfo = this.activeCampaigns.get(campaignId);
        
        if (!stats || !campaignInfo) {
            return null;
        }

        return {
            total_contacts: stats.total,
            processed: stats.sent + stats.failed,
            sent: stats.sent,
            failed: stats.failed,
            pending: stats.pending,
            start_time: campaignInfo.startTime,
            sessions: campaignInfo.sessions,
            active_workers: Array.from(this.activeWorkers.values())
                .filter(worker => worker.campaignId === campaignId).length
        };
    }

    // 🔄 PROCESAMIENTO DISTRIBUIDO HEREDADO (para compatibilidad)
    async processDistributedCampaign(distribution, campaignId, delaySeconds, userId, phpCallback, mediaData) {
        // Convertir distribución heredada a nuevo formato
        const contacts = [];
        for (const sessionGroup of distribution) {
            contacts.push(...sessionGroup.contacts);
        }

        // Usar el nuevo método automático
        return await this.processDistributedCampaignAutomatic(contacts, campaignId, delaySeconds, mediaData);
    }

    // 📊 OBTENER ESTADO DE LA COLA
    getQueueStatus() {
        return {
            globalQueue: this.messageQueue.length,
            isProcessing: this.isProcessingQueue,
            activeCampaigns: this.activeCampaigns.size,
            activeWorkers: this.activeWorkers.size,
            sessionQueues: Array.from(this.sessionQueues.entries()).map(([sessionId, queue]) => ({
                sessionId: this.getSessionDisplayName(sessionId),
                pending: queue.length
            }))
        };
    }

    // 🧹 LIMPIAR DATOS DE CAMPAÑAS COMPLETADAS
    cleanup() {
        // Limpiar campañas antiguas (más de 1 hora)
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        
        for (const [campaignId, campaignInfo] of this.activeCampaigns.entries()) {
            if (campaignInfo.startTime < oneHourAgo) {
                this.activeCampaigns.delete(campaignId);
                this.campaignStats.delete(campaignId);
                logger.info(`🧹 Limpieza: Datos de campaña ${campaignId} eliminados por antigüedad`);
            }
        }

        // Limpiar sesiones fallidas periódicamente
        this.failedSessions.clear();
    }
}

module.exports = CampaignProcessor;
