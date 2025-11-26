// server.js - DETECCIÓN REAL SIN PATRONES
"use strict";

const express = require('express');
const { Client, LocalAuth, MessageAck, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cors = require('cors');
const mysql = require('mysql2/promise');
const webhookHandler = require('./webhook-handler');
// === Integración de envío DISTRIBUIDO ===
// Intentamos cargar campaignProcessor y routes desde raíz o /src
let CampaignProcessor = null;
let Routes = null;
try { CampaignProcessor = require('./campaignProcessor'); } catch (e1) {
  try { CampaignProcessor = require('./campaignProcessor.js'); } catch (e1b) {
    try { CampaignProcessor = require('./src/campaignProcessor'); } catch (e1c) {}
  }
}
try { Routes = require('./routes'); } catch (e2) {
  try { Routes = require('./routes.js'); } catch (e2b) {
    try { Routes = require('./src/routes'); } catch (e2c) {}
  }
}


const app = express();
const PORT = 3001;

// Middleware con límite aumentado para campañas grandes (hasta 5000 contactos)
app.use(express.json({ limit: '100mb' })); // Límite para soportar campañas de hasta 5000 usuarios
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(cors());
process.on('uncaughtException', e=>{const m=(e&&e.message)||''; if(m.includes('EBUSY')&&m.includes('chrome_debug.log')){console.log('⚠️ Ignorando EBUSY chrome_debug.log'); return;} console.error(e);});
process.on('unhandledRejection', r=>{const m=(r&&r.message)||''; if(m.includes('EBUSY')&&m.includes('chrome_debug.log')){console.log('⚠️ Ignorando EBUSY chrome_debug.log (promise)'); return;} console.error(r);});

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
  if (lower.endsWith('.mp4')) return 'video/mp4';
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
          // follow redirect
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
// Normaliza URL cuando viene sin /backend/ desde localhost
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
            'C:\\\\xampp\\\\htdocs\\\\sistemasms\\\\backend\\\\uploads\\\\campaign-images\\\\' + filename,
            'C:\\\\xampp\\\\htdocs\\\\backend\\\\uploads\\\\campaign-images\\\\' + filename,
            'C:\\\\xampp\\\\htdocs\\\\sistemasms\\\\uploads\\\\campaign-images\\\\' + filename
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




// ================================
// ICONOS Y NORMALIZACIÓN DE TEXTO
// ================================
const ICONS = {
  info: 'ℹ️', ok: '✅', err: '❌', warn: '⚠️',
  send: '📤', delivered: '📬', read: '👁️', stats: '📊',
  invalid: '⛔', phone: '📱', session: '📳', qr: '📲',
  reconnect: '🔄', disconnect: '🔌', auth: '🔐', logout: '🚪',
  link: '🔗', bulb: '💡', rocket: '🚀', broom: '🧹', trash: '🗑️', target: '🎯'
};

function normalizeAccents(s) {
  return s
    .replace(/Ã±/g, 'ñ').replace(/Ã‘/g, 'Ñ')
    .replace(/Ã¡/g, 'á').replace(/Ã©/g, 'é').replace(/Ã­/g, 'í')
    .replace(/Ã³/g, 'ó').replace(/Ãº/g, 'ú')
    .replace(/Â¿/g, '¿').replace(/Â¡/g, '¡').replace(/Â·/g, '·')
    .replace(/â€‹/g, '')
    .replace(/â€“/g, '–').replace(/â€”/g, '—')
    .replace(/â€˜/g, '‘').replace(/â€™/g, '’')
    .replace(/â€œ/g, '“').replace(/â€/g, '”')
    .replace(/Â /g, ' ');
}
function normalizeEmojis(s) {
  return s
    .replace(/ðŸš€/g, '🚀').replace(/ðŸ“±/g, '📱').replace(/ðŸ“Š/g, '📊')
    .replace(/âœ…/g, '✅').replace(/âš ?ï¸/g, '⚠️').replace(/âŒ/g, '❌')
    .replace(/ðŸ”„/g, '🔄').replace(/ðŸ’¡/g, '💡').replace(/ðŸ“¤/g, '📤')
    .replace(/ðŸ‘ï¸/g, '👁️').replace(/ðŸ“¨/g, '📩').replace(/ðŸ”/g, '🔍')
    .replace(/ðŸ”Œ/g, '🔌').replace(/ðŸ”/g, '🔐').replace(/ðŸ“ž/g, '📞')
    .replace(/ðŸŽ¯/g, '🎯').replace(/ðŸ—‘ï¸/g, '🗑️').replace(/ðŸ—‚ï¸/g, '🧹')
    .replace(/ðŸšª/g, '🚪');
}
function fixEncoding(s) { return normalizeEmojis(normalizeAccents(s)); }

// Parchea los logs para limpiar mojibake automáticamente
const _log = console.log.bind(console);
const _err = console.error.bind(console);
console.log = (...args) => _log(...args.map(a => (typeof a === 'string' ? fixEncoding(a) : a)));
console.error = (...args) => _err(...args.map(a => (typeof a === 'string' ? fixEncoding(a) : a)));

// ================================
// Variables globales
// ================================
let clients = new Map();
let activeSessionId = null;
let messageCounters = new Map();
let savedSessions = new Set();

// Tracking
let loadBalancer = null;

// Tracking de entregas/lecturas y respuesta
let messageTracking = new Map();      // messageId -> tracking data
let invalidNumbers = new Set();       // números confirmados como inválidos (guardar sin '+')
let pendingVerifications = new Map(); // phone -> timeout

// Mapeo entre números @lid y números reales (necesario para ack/respuestas)
let lidToRealPhone = new Map();       // ej. 252058896699621 -> +56966090302
let realPhoneToLid = new Map();       // ej. +56966090302 -> 252058896699621

function normalizePhone(phone) {
  if (!phone) return null;
  let cleaned = phone.trim();
  cleaned = cleaned.replace(/@c\.us$|@lid$|@g\.us$|@s\.whatsapp\.net$|@[a-z\.]+$/i, '');
  cleaned = cleaned.replace(/[^\d\+]/g, '');
  if (cleaned && !cleaned.startsWith('+')) {
    cleaned = '+' + cleaned;
  }
  return cleaned;
}

function registerLidMapping(lidNumber, realPhone) {
  const normalizedReal = normalizePhone(realPhone);
  if (!lidNumber || !normalizedReal) return;

  const lidKey = lidNumber.replace(/[^\d]/g, '');

  if (lidToRealPhone.get(lidKey) === normalizedReal) return;

  lidToRealPhone.set(lidKey, normalizedReal);
  lidToRealPhone.set('+' + lidKey, normalizedReal);
  realPhoneToLid.set(normalizedReal, lidKey);
  realPhoneToLid.set(normalizedReal.replace(/^\+/, ''), lidKey);

  console.log(`${ICONS.link} Mapeo LID registrado: ${lidKey} <-> ${normalizedReal}`);
}

function translateFromLid(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  if (lidToRealPhone.has(normalized)) return lidToRealPhone.get(normalized);

  const lidKey = normalized.replace(/^\+/, '');
  if (lidToRealPhone.has(lidKey)) return lidToRealPhone.get(lidKey);

  return normalized;
}

global.__lidMapper = {
  registerLidMapping,
  translateFromLid,
  normalizePhone,
  lidToRealPhone,
  realPhoneToLid
};

// DB
const DB_CONFIG = {
    host: 'localhost',
  user: 'root',
  password: '',
    database: 'messagehub'
};

// Respuestas y feed en tiempo real
let receivedResponses = new Map(); // phone -> latest response
let realTimeUpdates = [];          // logs de tiempo real

// ================================
// Utils
// ================================
function getCurrentDate() {
  return new Date().toISOString().split('T')[0];
}

// Validar y procesar URLs de multimedia
async function validateMediaUrl(media_url, media_type = 'image') {
  if (!media_url) return { valid: false, error: 'URL de media no proporcionada' };
  
  try {
    // Validar que sea una URL válida
    const url = new URL(media_url);
    
    // Validar protocolos permitidos
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { valid: false, error: 'Protocolo de URL no permitido. Solo HTTP/HTTPS.' };
    }
    
    // Validar extensiones de archivo para imágenes
    if (media_type === 'image') {
      const validExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
      const hasValidExtension = validExtensions.some(ext => 
        url.pathname.toLowerCase().endsWith(ext)
      );
      
      if (!hasValidExtension) {
        console.log(`${ICONS.warn} URL sin extensión de imagen válida: ${media_url}`);
        // No fallar, solo advertir - WhatsApp puede manejar URLs sin extensión
      }
    }
    
    return { valid: true, url: media_url };
  } catch (error) {
    return { valid: false, error: `URL inválida: ${error.message}` };
  }
}

function addRealTimeUpdate(type, phone, message, extra = {}) {
  if (phone) {
    const translated = translateFromLid(phone);
    if (translated) {
      if (translated !== normalizePhone(phone)) {
        registerLidMapping(phone, translated);
      }
      phone = translated;
    }
  }

  const update = {
    timestamp: new Date().toISOString(),
    type, phone, message, ...extra
  };
  realTimeUpdates.unshift(update);
  if (realTimeUpdates.length > 100) realTimeUpdates = realTimeUpdates.slice(0, 100);

  const icon = {
    'sent': ICONS.send,
    'delivered': ICONS.delivered,
    'read': ICONS.read,
    'response_received': '📩',
    'invalid_detected': ICONS.invalid,
    'error': ICONS.err
  }[type] || ICONS.info;

  console.log(`${icon} [TIEMPO REAL] ${phone}: ${message}`);
}

function markNumberAsInvalid(phone, reason, method = 'auto') {
  const key = phone.replace('+','');
  invalidNumbers.add(key);
  addRealTimeUpdate('invalid_detected', phone, reason, { method });
  console.log(`${ICONS.invalid} NÚMERO INVÁLIDO DETECTADO: ${phone}`);
  console.log(`   📨 Razón: ${reason}`);
  console.log(`   🔧 Método: ${method}`);
  console.log(`   ⏰ Timestamp: ${new Date().toISOString()}`);
}

// ================================
// DB helpers
// ================================
async function connectDB() {
  try {
    const connection = await mysql.createConnection(DB_CONFIG);
    return connection;
    } catch (error) {
    console.error(`${ICONS.err} Error conectando a la base de datos:`, error.message);
    return null;
  }
}

async function updateCampaignStats(campaignId) {
    const connection = await connectDB();
    if (!connection) return;
    
    try {
        const statsQuery = `
            UPDATE campaigns SET
                total_delivered = (
                    SELECT COUNT(*) FROM message_logs 
          WHERE campaign_id = ? AND status IN ('delivered','read')
                ),
                total_read = (
                    SELECT COUNT(*) FROM message_logs 
                    WHERE campaign_id = ? AND status = 'read'
                ),
                total_replied = (
                    SELECT COUNT(*) FROM message_logs 
                    WHERE campaign_id = ? AND response_received = 1
                )
            WHERE id = ?
        `;
        await connection.execute(statsQuery, [campaignId, campaignId, campaignId, campaignId]);
    } catch (error) {
    console.error(`${ICONS.err} Error actualizando estadísticas de campaña ${campaignId}:`, error.message);
    } finally {
        await connection.end();
    }
}

async function updateMessageStatusInDB(phone, newStatus, messageId = null) {
  if (newStatus !== 'read' && newStatus !== 'delivered') return false;

  const connection = await connectDB();
  if (!connection) return false;

  try {
    // Normalizar teléfono: limpiar de sufijos @c.us, @lid, etc.
    let cleanPhone = phone.replace(/@c\.us$|@lid$|@g\.us$|@[a-z\.]+$/i, '');
    if (!cleanPhone.startsWith('+')) {
      cleanPhone = '+' + cleanPhone;
    }

    const translatedPhone = translateFromLid(cleanPhone);
    if (translatedPhone !== cleanPhone) {
      registerLidMapping(cleanPhone, translatedPhone);
    }
    cleanPhone = translatedPhone;

    const findQuery = `
      SELECT id, status, campaign_id
      FROM message_logs
      WHERE (phone = ? OR phone = ?)
        AND status IN ('sent','delivered')
      ORDER BY sent_at DESC
      LIMIT 1
    `;
    const phonePlus = cleanPhone.startsWith('+') ? cleanPhone : '+' + cleanPhone;
    const phoneNoPlus = phonePlus.slice(1);
    let [rows] = await connection.execute(findQuery, [phonePlus, phoneNoPlus]);
    let foundById = false;

    // Si no encontramos por teléfono, intentar buscar por external_message_id (messageId)
    if ((!rows || rows.length === 0) && messageId) {
      const [byIdRows] = await connection.execute(
        `SELECT id, status, campaign_id FROM message_logs WHERE external_message_id = ? LIMIT 1`,
        [messageId]
      );
      if (byIdRows && byIdRows.length > 0) {
        rows = byIdRows;
        foundById = true;
        console.log(`${ICONS.info} Mensaje localizado por external_message_id=${messageId}`);
      }
    }

    if (!rows || rows.length === 0) {
      console.log(`${ICONS.warn} No se encontró mensaje para actualizar: ${phonePlus}` + (messageId ? ` (tried messageId=${messageId})` : ''));
      return false;
    }

    const { id: logId, status: current, campaign_id: campaignId } = rows[0];
    const rank = { sent: 1, delivered: 2, read: 3 };
    if (rank[newStatus] <= rank[current]) {
      console.log(`${ICONS.warn} Estado ${newStatus} no supera a ${current} para ${phonePlus}`);
      return false;
    }

    if (newStatus === 'read') {
      await connection.execute(
        `UPDATE message_logs
         SET status='read',
             delivery_status='read',
             read_at = NOW()
         WHERE id = ? AND read_at IS NULL`,
        [logId]
      );
    } else if (newStatus === 'delivered') {
      await connection.execute(
        `UPDATE message_logs
         SET status='delivered',
             delivery_status='delivered',
             delivered_at = NOW()
         WHERE id = ?`,
        [logId]
      );
    }

    await updateCampaignStats(campaignId);
    addRealTimeUpdate(newStatus, phonePlus, `Estado actualizado a ${newStatus}`);
    console.log(`${ICONS.ok} Estado actualizado en DB: ${phonePlus} -> ${newStatus}`);
    return true;
    } catch (error) {
    console.error(`${ICONS.err} Error actualizando estado en DB para ${phone}:`, error.message);
    return false;
  } finally {
    await connection.end();
  }
}

async function saveResponseToDB(phone, responseText, messageId = null, incomingMessage = null) {
    const connection = await connectDB();
    if (!connection) return false;
    
    try {
        // Normalizar teléfono: limpiar de sufijos @c.us, @lid, etc.
        let cleanPhone = phone.replace(/@c\.us$|@lid$|@g\.us$|@s\.whatsapp\.net$|@[a-z\.]+$/i, '');
        if (!cleanPhone.startsWith('+')) {
            cleanPhone = '+' + cleanPhone;
        }
        const originalPhone = cleanPhone;

        const translatedPhone = translateFromLid(cleanPhone);
        if (translatedPhone !== cleanPhone) {
            registerLidMapping(cleanPhone, translatedPhone);
        }
        cleanPhone = translatedPhone;

        console.log(`🔍 Buscando mensaje para vincular respuesta de ${cleanPhone} (messageId=${messageId})...`);

        const findQuery = `
            SELECT ml.id, ml.campaign_id, ml.phone, c.campaign_name, ml.response_received
            FROM message_logs ml
            LEFT JOIN campaigns c ON ml.campaign_id = c.id
            WHERE (ml.phone = ? OR ml.phone = ?)
            AND ml.status IN ('sent','delivered','read')
            AND ml.response_received = 0
            ORDER BY ml.sent_at DESC 
            LIMIT 1
        `;
    let [rows] = await connection.execute(findQuery, [cleanPhone, originalPhone]);
    
    // Debug: si no encontramos, verificar si existe pero ya tiene respuesta
    if ((!rows || rows.length === 0) && cleanPhone) {
        const [debugRows] = await connection.execute(
            `SELECT ml.id, ml.phone, ml.status, ml.response_received, ml.sent_at 
             FROM message_logs ml 
             WHERE ml.phone IN (?, ?)
             ORDER BY ml.sent_at DESC LIMIT 1`,
            [cleanPhone, originalPhone]
        );
        if (debugRows && debugRows.length > 0) {
            const dbg = debugRows[0];
            console.log(`   🔎 Mensaje encontrado en BD pero no vinculado:`);
            console.log(`      • phone: ${dbg.phone}`);
            console.log(`      • status: ${dbg.status}`);
            console.log(`      • response_received: ${dbg.response_received}`);
            console.log(`      • sent_at: ${dbg.sent_at}`);
            if (dbg.response_received == 1) {
                console.log(`      ⚠️ CAUSA: Ya tiene respuesta registrada (evita duplicados)`);
            }
        }
    }
        
    // Fallback: si no encontramos por teléfono y tenemos messageId, buscar por external_message_id
    let foundById = false;
    if ((!rows || rows.length === 0) && messageId) {
      console.log(`  ➡️ No encontrado por teléfono ${cleanPhone}, intentando por external_message_id=${messageId}...`);
      const [byIdRows] = await connection.execute(
        `SELECT ml.id, ml.campaign_id, ml.phone, c.campaign_name FROM message_logs ml LEFT JOIN campaigns c ON ml.campaign_id = c.id WHERE ml.external_message_id = ? LIMIT 1`,
        [messageId]
      );
      if (byIdRows && byIdRows.length > 0) {
        rows = byIdRows;
        foundById = true;
        console.log(`${ICONS.info} ✅ Respuesta vinculada por external_message_id=${messageId} (teléfono original: ${rows[0].phone})`);
      }
    }

    // ⛔ Fallback 2 ELIMINADO: NO vincular respuestas al último mensaje de cualquier contacto.
    // Esto causaba falsos positivos: marcaba como "Respondido" a contactos que solo recibieron/leyeron.
    // Es preferible perder algunas respuestas que asignarlas incorrectamente.

    // 🔍 Si no encontramos nada, intentar buscar por contact_id usando el JID original
    if ((!rows || rows.length === 0) && incomingMessage && incomingMessage.from) {
      console.log(`   🔎 Intentando vincular por contact_id del remitente...`);
      
      // Extraer el JID limpio del mensaje entrante
      const fromJidRaw = normalizePhone(incomingMessage.from) || cleanPhone;
      const fromJid = translateFromLid(fromJidRaw);
      if (fromJid !== fromJidRaw) {
        registerLidMapping(fromJidRaw, fromJid);
      }
      
      // Buscar en contacts si existe ese teléfono (puede estar sin +56)
      const [contactRows] = await connection.execute(
        `SELECT c.id as contact_id, c.phone, c.full_name
         FROM contacts c
         WHERE c.phone LIKE ?
         OR c.phone LIKE ?
         LIMIT 1`,
        [`%${fromJid.slice(-8)}`, `%${cleanPhone.slice(-8)}`]
      );
      
      if (contactRows && contactRows.length > 0) {
        const contact = contactRows[0];
        console.log(`      ✓ Contacto encontrado: ${contact.full_name} (${contact.phone})`);
        
        // Buscar mensaje de ese contacto sin respuesta
        const [msgRows] = await connection.execute(
          `SELECT ml.id, ml.campaign_id, ml.phone, c.campaign_name
           FROM message_logs ml
           LEFT JOIN campaigns c ON ml.campaign_id = c.id
           WHERE ml.contact_id = ?
           AND ml.status IN ('sent','delivered','read')
           AND ml.response_received = 0
           ORDER BY ml.sent_at DESC
           LIMIT 1`,
          [contact.contact_id]
        );
        
        if (msgRows && msgRows.length > 0) {
          rows = msgRows;
          console.log(`      🎯 Mensaje vinculado por contact_id: ${contact.phone} -> ${cleanPhone}`);
        }
      }
    }

    if (rows && rows.length > 0) {
            const messageLogId = rows[0].id;
            const campaignId = rows[0].campaign_id;
            const campaignName = rows[0].campaign_name || `#${campaignId}`;
            
            const updateQuery = `
                UPDATE message_logs 
                SET response_received = 1,
                    response_text = ?,
                    response_at = NOW(),
                    replied_at = NOW()
                WHERE id = ?
            `;
            await connection.execute(updateQuery, [responseText, messageLogId]);
            
      const timeStr = new Date().toLocaleTimeString('es-CL', { hour12: false });
      console.log(`📩 [${timeStr}] RESPUESTA de ${cleanPhone} (${campaignName}): "${responseText}"`);
            addRealTimeUpdate('response_received', cleanPhone, `Respuesta: ${responseText.substring(0, 30)}...`);
            return true;
        } else {
            // ❌ NO ENCONTRAMOS NINGÚN MENSAJE PARA VINCULAR
            console.error(`${ICONS.err} ❌ NO SE PUDO VINCULAR RESPUESTA de ${cleanPhone}`);
            console.error(`   📌 Detalles:`);
            console.error(`      • Número buscado: ${cleanPhone}`);
            console.error(`      • MessageId: ${messageId || 'N/A'}`);
            console.error(`      • JID original: ${incomingMessage?.from || 'N/A'}`);
            console.error(`   💡 Posibles causas:`);
            console.error(`      • El número en BD es diferente (ej: +56xxx vs 56xxx)`);
            console.error(`      • WhatsApp usa número LID y no coincide con el real`);
            console.error(`      • El mensaje fue enviado hace más de 1 día`);
        }
        return false;
    } catch (error) {
    console.error(`${ICONS.err} Error guardando respuesta para ${phone}:`, error.message);
        return false;
    } finally {
        await connection.end();
    }
}// ================================
// Cliente activo y contadores
// ================================
function getActiveClient() {
  if (!activeSessionId) return null;
  const sessionData = clients.get(activeSessionId);
  if (!sessionData || !sessionData.isReady) return null;
  return sessionData;
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
  console.log(`${ICONS.stats} [${sessionId}] Mensajes hoy: ${newCount}`);
  return newCount;
}

// ================================
// Sesiones
// ================================
function loadSavedSessions() {
    try {
        const fs = require('fs');
        const authDir = '.wwebjs_auth';
        
        if (!fs.existsSync(authDir)) {
      console.log('📂 No existe directorio de autenticación');
            return;
        }
        
        const sessionDirs = fs.readdirSync(authDir).filter(dir => {
            try {
                const fullPath = `${authDir}/${dir}`;
                const stat = fs.statSync(fullPath);
                return stat.isDirectory() && dir.startsWith('session-');
      } catch {
                return false;
            }
        });
        
        sessionDirs.forEach(sessionDir => {
            if (sessionDir.startsWith('session-messagehub-')) {
                const sessionId = sessionDir.replace('session-messagehub-', '');
                savedSessions.add(sessionId);
        console.log(`📂 Sesión encontrada: ${sessionId}`);
            } else if (sessionDir.startsWith('session-')) {
                const sessionId = sessionDir.replace('session-', '');
                if (sessionId && !sessionId.startsWith('messagehub-')) {
                    savedSessions.add(sessionId);
          console.log(`📂 Sesión encontrada: ${sessionId}`);
                }
            }
        });
        
    console.log(`${ICONS.stats} Total sesiones para cargar: ${savedSessions.size}`);
        if (savedSessions.size === 0) {
      console.log(`${ICONS.phone} No hay sesiones guardadas. Usa el botón "➕ Nueva Sesión".`);
        }
    } catch (error) {
    console.log(`${ICONS.warn} Error cargando sesiones guardadas: ${error.message}`);
  }
}

function createClient(sessionId) {
  console.log(`${ICONS.reconnect} Creando cliente para sesión: ${sessionId}`);
    
    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: `messagehub-${sessionId}`,
      dataPath: './.wwebjs_auth'
        }),
        puppeteer: {
            headless: true,
            args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
        '--disable-gpu', '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
        '--disable-features=TranslateUI', '--disable-ipc-flooding-protection',
        '--disable-web-security', '--disable-features=VizDisplayCompositor',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            ],
      executablePath: undefined,
      timeout: 60000
        },
        webVersionCache: {
      type: 'local',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
        },
    qrMaxRetries: 5,
    restartOnAuthFail: true,
    takeoverOnConflict: false,
    takeoverTimeoutMs: 0
    });

    const sessionData = {
    client,
        isReady: false,
        qrCode: null,
        clientInfo: null,
    sessionId
    };

    clients.set(sessionId, sessionData);
    savedSessions.add(sessionId);
    
    if (!messageCounters.has(sessionId)) {
        messageCounters.set(sessionId, { date: getCurrentDate(), count: 0 });
    }
    
    setupClientEvents(sessionId);
    return sessionData;
}

// ================================
// Eventos del cliente
// ================================
function analyzeDeliveryStatus(messageId, ackStatus, phone, sessionId) {
  // Normalizar número: remover sufijos y + si viene con él
  let cleanPhone = phone.replace(/@c\.us$|@lid$|@g\.us$|@[a-z\.]+$/i, '').replace(/^\+/, '');
  
  const tracking = messageTracking.get(messageId);
  if (!tracking) return;

  const now = Date.now();
  const timeSinceSent = now - tracking.sentTime;
  const minutesElapsed = Math.floor(timeSinceSent / (1000 * 60));

  switch (ackStatus) {
    case MessageAck.ACK_SERVER: // 1
      addRealTimeUpdate('sent', cleanPhone, `Enviado al servidor (${minutesElapsed} min)`);
      tracking.serverTime = now;
      setTimeout(() => {
        const current = messageTracking.get(messageId);
        if (current && current.finalStatus === MessageAck.ACK_SERVER) {
          console.log(`${ICONS.warn} [${sessionId}] ${cleanPhone}: atascado en servidor > 10 min`);
          // 🔥 NO marcar como inválido por timeout - puede ser problema de red
          addRealTimeUpdate('timeout', cleanPhone, 'Mensaje atascado en servidor > 10 minutos');
        }
      }, 10 * 60 * 1000);
      break;

    case MessageAck.ACK_DEVICE: // 2
      addRealTimeUpdate('delivered', cleanPhone, `Entregado al dispositivo (${minutesElapsed} min)`);
      tracking.deliveredTime = now;
      tracking.deliveryTime = timeSinceSent;
      if (invalidNumbers.has(cleanPhone)) invalidNumbers.delete(cleanPhone);
      break;

    default:
      if (ackStatus >= MessageAck.ACK_READ) { // 3 o 4
        addRealTimeUpdate('read', cleanPhone, `Leído por el usuario (${minutesElapsed} min)`);
        tracking.readTime = now;
        console.log(`🔍 [DEBUG] Intentando actualizar ${cleanPhone} a 'read'`);
        updateMessageStatusInDB('+' + cleanPhone, 'read');
      }
      break;
  }

  tracking.finalStatus = ackStatus;
  tracking.lastUpdate = now;
  messageTracking.set(messageId, tracking);
}

function setupClientEvents(sessionId) {
    const sessionData = clients.get(sessionId);
    if (!sessionData) return;
    
    const client = sessionData.client;

    client.on('qr', (qr) => {
    console.log(`\n${ICONS.qr} QR generado para sesión ${sessionId}:`);
        qrcode.generate(qr, { small: true });
        sessionData.qrCode = qr;
        sessionData.isReady = false;
    console.log(`⏳ Esperando escaneo para ${sessionId}...\n`);
    });

    client.on('ready', () => {
    console.log(`${ICONS.ok} Sesión ${sessionId} conectada y lista!`);
        sessionData.isReady = true;
        sessionData.qrCode = null;
        sessionData.clientInfo = client.info;
        
    console.log(`${ICONS.phone} ${sessionId} - Usuario: ${sessionData.clientInfo.pushname}`);
    console.log(`📞 ${sessionId} - Número: ${sessionData.clientInfo.wid.user}`);
        
        if (!activeSessionId) {
            activeSessionId = sessionId;
      console.log(`${ICONS.target} Sesión activa por defecto: ${sessionId}`);
        }

    // Webhooks externos (si los tienes definidos)
            webhookHandler.addWebhookListeners(client, sessionId);
    });

    client.on('authenticated', () => {
    console.log(`${ICONS.auth} Sesión ${sessionId} autenticada`);
    });

    client.on('auth_failure', (msg) => {
    console.error(`${ICONS.err} Error de autenticación ${sessionId}:`, msg);
        sessionData.isReady = false;
        sessionData.qrCode = null;
    });

    client.on('disconnected', (reason) => {
    console.log(`${ICONS.disconnect} Sesión ${sessionId} desconectada:`, reason);
        sessionData.isReady = false;
        sessionData.clientInfo = null;
        
        if (activeSessionId === sessionId) {
            const availableSession = Array.from(clients.entries())
                .find(([id, data]) => id !== sessionId && data.isReady);
            if (availableSession) {
                activeSessionId = availableSession[0];
        console.log(`${ICONS.reconnect} Cambiando sesión activa a: ${activeSessionId}`);
            } else {
                activeSessionId = null;
            }
        }
        
        if (reason === 'LOGOUT' || reason === 'NAVIGATION') {
      console.log(`${ICONS.warn} Sesión ${sessionId} desconectada por timeout/logout. Manteniendo visible en interfaz.`);
      console.log(`${ICONS.bulb} Para reconectar, usa la interfaz web: http://localhost:${PORT}`);
            // NO eliminar la sesión - mantenerla visible en rojo
            sessionData.isReady = false;
            sessionData.clientInfo = null;
            sessionData.qrCode = null;
      return;
        }
        
        setTimeout(() => {
      console.log(`${ICONS.reconnect} Reconectando sesión ${sessionId}...`);
            try {
                client.initialize();
            } catch (error) {
        console.error(`${ICONS.err} Error al reconectar ${sessionId}:`, error.message);
        console.log(`${ICONS.bulb} Para reiniciar manualmente, usa la interfaz web: http://localhost:${PORT}`);
            }
    }, 10000);
    });

  // Tracking de mensajes creados
    client.on('message_create', async (message) => {
        if (message.fromMe) {
            const messageId = message.id.id;
            // Limpiar número: remover @c.us, @lid, y otros sufijos
            let cleanPhone = message.to.replace(/@c\.us$|@lid$|@g\.us$|@[a-z\.]+$/i, '');
            if (!cleanPhone.startsWith('+')) {
              cleanPhone = '+' + cleanPhone;
            }
            messageTracking.set(messageId, {
        phone: cleanPhone,
        sessionId,
                sentTime: Date.now(),
        body: typeof message.body === 'string' ? (message.body || '').substring(0, 50) + '...' : '[Multimedia]',
                finalStatus: 0,
                serverTime: null,
                deliveredTime: null,
                readTime: null
            });
        }
    });

  // ÚNICO listener de ACK con mapping correcto
    client.on('message_ack', async (message, ack) => {
    if (!message.fromMe) return;

    // Limpiar número: remover @c.us, @lid, y otros sufijos de WhatsApp
    let cleanPhone = message.to.replace(/@c\.us$|@lid$|@g\.us$|@[a-z\.]+$/i, '');
    if (!cleanPhone.startsWith('+')) {
      cleanPhone = '+' + cleanPhone;
    }

    const translatedPhone = translateFromLid(cleanPhone);
    if (translatedPhone !== cleanPhone) {
      registerLidMapping(cleanPhone, translatedPhone);
    }
    cleanPhone = translatedPhone;

    let newStatus = null;
    if (ack >= MessageAck.ACK_READ) {
      newStatus = 'read';
    } else if (ack >= MessageAck.ACK_DEVICE) {
      newStatus = 'delivered';
    }

    if (newStatus) {
      try {
        await updateMessageStatusInDB(cleanPhone, newStatus, message.id.id);
      } catch (e) {
        console.error(`${ICONS.err} Error procesando ACK:`, e.message);
      }
    }

    if (ack === MessageAck.ACK_READ) {
      const timeStr = new Date().toLocaleTimeString('es-CL', { hour12: false });
      console.log(`👁️ [${timeStr}] LEÍDO: ${cleanPhone}`);
    }

    analyzeDeliveryStatus(message.id.id, ack, cleanPhone.replace('+', ''), sessionId);
  });

  // Respuestas entrantes
    client.on('message', async (message) => {
        try {
            if (!message.fromMe) {
                // 🔧 ACEPTA CUALQUIER FORMATO DE JID (no solo @c.us)
                // Limpiar número: remover @c.us, @lid, @g.us, @s.whatsapp.net, y otros sufijos
                let fromPhone = message.from.replace(/@c\.us$|@lid$|@g\.us$|@s\.whatsapp\.net$|@[a-z\.]+$/i, '');
                if (!fromPhone.startsWith('+')) {
                  fromPhone = '+' + fromPhone;
                }

        const translatedFrom = translateFromLid(fromPhone);
        if (translatedFrom !== fromPhone) {
          registerLidMapping(fromPhone, translatedFrom);
        }
        fromPhone = translatedFrom;
        const messageText = typeof message.body === 'string' ? (message.body || '') : '[Multimedia]';
        const timeStr = new Date().toLocaleTimeString('es-CL', { hour12: false });
        console.log(`📩 [${timeStr}] [${sessionId}] RESPUESTA de ${fromPhone} (JID original: ${message.from}): ${messageText}`);
        receivedResponses.set(fromPhone, {
          text: messageText,
          timestamp: new Date().toISOString(),
          messageInfo: message
        });
        // Intenta guardar la respuesta (con fallback flexible si el teléfono no coincide exactamente)
        await saveResponseToDB(fromPhone, messageText, message.id.id, message);
        addRealTimeUpdate('response_received', fromPhone, typeof messageText === 'string' ? messageText.substring(0, 50) + (messageText.length > 50 ? '...' : '') : '[Multimedia]');
            }
        } catch (error) {
      console.error(`${ICONS.err} Error procesando mensaje recibido:`, error);
        }
    });
}

function autoInitializeSessions() {
    if (savedSessions.size === 0) {
    console.log(`${ICONS.phone} No hay sesiones guardadas. Usa el botón "➕ Nueva Sesión".`);
        return;
    }
    
    // 🔥 INICIALIZAR TODAS LAS SESIONES GUARDADAS SIN LÍMITE
    const sessionsToInit = Array.from(savedSessions); // TODAS las sesiones, sin límite
    
  console.log(`${ICONS.reconnect} Auto-inicializando TODAS las ${sessionsToInit.length} sesiones guardadas...`);
  console.log(`${ICONS.info} Sin límites - Todas las sesiones se iniciarán automáticamente`);
    
    let delay = 0;
    for (const sessionId of sessionsToInit) {
        setTimeout(async () => {
            try {
        console.log(`${ICONS.rocket} Inicializando sesión: ${sessionId}`);
                const sessionData = createClient(sessionId);
                await sessionData.client.initialize();
            } catch (error) {
        console.error(`${ICONS.err} Error inicializando sesión ${sessionId}:`, error.message);
                if (error.message.includes('ENOTFOUND') || error.message.includes('INTERNET_DISCONNECTED')) {
          console.log('🌐 Error de conectividad detectado. Pausando inicialización automática.');
                    return;
                }
            }
        }, delay);
    delay += 5000;
  }
}

// ================================
// API
// ================================
app.post('/verify-number-real', async (req, res) => {
    try {
        const { phone, sessionId } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'phone requerido' });
        
        const targetSessionId = sessionId || activeSessionId;
    if (!targetSessionId) return res.status(400).json({ success: false, error: 'No hay sesión activa' });
        
        const sessionData = clients.get(targetSessionId);
    if (!sessionData?.isReady) return res.status(400).json({ success: false, error: 'Sesión no está lista' });
        
        const cleanPhone = phone.replace(/[^0-9+]/g, '');
    const numberPlain = cleanPhone.replace(/[^0-9]/g, '');
    const chatId = numberPlain + '@c.us';

    let exists = false, method = 'getNumberId', reason = undefined;
    try {
      const numberId = await sessionData.client.getNumberId(chatId);
      if (numberId) {
        exists = true;
        method = 'getNumberId';
        try {
          const contact = await sessionData.client.getContactById(chatId);
          if (!(contact && contact.isWAContact)) {
            // Registrado pero sin contacto accesible: sospechoso
            exists = false;
            method = 'suspicious';
            reason = 'Registrado pero inaccesible';
          }
        } catch (e) {
          // Si falla contacto, marcamos como sospechoso si queremos
        }
      } else {
        exists = false;
        method = 'getNumberId';
        reason = 'No registrado en WhatsApp';
      }
    } catch (e) {
      exists = false;
      method = 'error';
      reason = e.message;
    }

    if (!exists) markNumberAsInvalid(cleanPhone, reason || 'No existe', method);
        
        res.json({
            success: true,
            phone: cleanPhone,
      exists,
      method,
      reason,
      isKnownInvalid: invalidNumbers.has(cleanPhone.replace('+','')),
            sessionId: targetSessionId,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
    console.error(`${ICONS.err} Error verificando número:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/responses', (req, res) => {
    try {
        const responsesList = Array.from(receivedResponses.entries()).map(([phone, response]) => ({
      phone,
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

// ÚNICO /detection-stats (eliminado duplicado)
app.get('/detection-stats', (req, res) => {
    try {
        const invalidList = Array.from(invalidNumbers);
        const trackingStats = Array.from(messageTracking.values());
        const responsesList = Array.from(receivedResponses.entries()).map(([phone, response]) => ({
      phone, text: response.text, timestamp: response.timestamp
        }));
        
        const deliveryStats = {
            total: trackingStats.length,
      delivered: trackingStats.filter(t => (t.finalStatus ?? 0) >= MessageAck.ACK_DEVICE).length,
      stuckInServer: trackingStats.filter(t => (t.finalStatus ?? 0) === MessageAck.ACK_SERVER).length,
      noResponse: trackingStats.filter(t => (t.finalStatus ?? 0) === 0).length
    };

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
      realTimeUpdates: realTimeUpdates.slice(0, 20),
            lastUpdate: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/send-with-verification', async (req, res) => {
    try {
        const { phone, message, sessionId, skipVerification = false, media_type, media_url, media_caption } = req.body;
        if (!phone || !message) {
            return res.status(400).json({ success: false, error: 'phone y message requeridos' });
        }
        
        const targetSessionId = sessionId || activeSessionId;
    if (!targetSessionId) return res.status(400).json({ success: false, error: 'No hay sesión activa' });
        
        const sessionData = clients.get(targetSessionId);
    if (!sessionData?.isReady) return res.status(400).json({ success: false, error: 'Sesión no está lista' });
        
        let cleanPhone = phone.replace(/[^0-9+]/g, '');
        if (!cleanPhone.startsWith('+')) {
      if (cleanPhone.startsWith('56')) cleanPhone = '+' + cleanPhone;
      else cleanPhone = '+56' + cleanPhone;
    }

        if (invalidNumbers.has(cleanPhone.replace('+', ''))) {
            return res.status(400).json({ 
                success: false, 
        error: 'Número confirmado como inválido por WhatsApp',
                phone: cleanPhone,
        suggestion: 'Este número fue detectado previamente como no válido'
            });
        }
        
        if (!skipVerification) {
      console.log(`${ICONS.link} [${targetSessionId}] Verificando ${cleanPhone} antes de enviar...`);
      const numberPlain = cleanPhone.replace(/\D/g, '');
      const chatId = numberPlain + '@c.us';
      try {
        const numberId = await sessionData.client.getNumberId(chatId);
        if (!numberId) {
          markNumberAsInvalid(cleanPhone.replace('+', ''), 'No registrado en WhatsApp', 'getNumberId');
                return res.status(400).json({ 
                    success: false, 
            error: 'Número no existe en WhatsApp',
                    phone: cleanPhone,
            reason: 'No registrado en WhatsApp',
            method: 'getNumberId'
                });
        }
      } catch (e) {
        markNumberAsInvalid(cleanPhone.replace('+',''), e.message, 'send_precheck_error');
        return res.status(500).json({ success: false, error: e.message, phone: cleanPhone });
            }
        }
        
        const chatId = cleanPhone.substring(1) + '@c.us';
    console.log(`${ICONS.send} [${targetSessionId}] Enviando a ${cleanPhone} (verificado=${!skipVerification})...`);
        
        try {
            let sentMessage;
            
            // 🖼️ MANEJAR MULTIMEDIA SI EXISTE (también en send-with-verification)
            if (media_type && media_type !== 'text' && media_url) {
                console.log(`🖼️ [${targetSessionId}] Enviando ${media_type}: ${media_url}`);
                
                // Validar URL de media primero
                const mediaValidation = await validateMediaUrl(media_url, media_type);
                if (!mediaValidation.valid) {
                    console.error(`${ICONS.err} URL de media inválida: ${mediaValidation.error}`);
                    // Fallback: enviar solo el mensaje de texto
                    sentMessage = await sessionData.client.sendMessage(chatId, message);
                    console.log(`${ICONS.warn} [${targetSessionId}] FALLBACK - TEXTO ENVIADO (media inválida) a ${cleanPhone}`);
                } else {
                    try {
                        // Crear MessageMedia desde URL usando whatsapp-web.js
                        const media = await makeMessageMediaFromUrl(media_url);
                        
                        // Configurar opciones de envío
                        const sendOptions = {};
                        if (media_caption || message) {
                            sendOptions.caption = media_caption || message;
                        }
                        
                        // Enviar mensaje multimedia
                        sentMessage = await sessionData.client.sendMessage(chatId, media, sendOptions);
                        console.log(`🖼️ [${targetSessionId}] MEDIA ENVIADA a ${cleanPhone}`);
                    } catch (mediaError) {
                        console.error(`${ICONS.err} Error procesando multimedia ${media_url}:`, mediaError.message);
                        // Fallback: enviar solo el mensaje de texto
                        sentMessage = await sessionData.client.sendMessage(chatId, message);
                        console.log(`${ICONS.warn} [${targetSessionId}] FALLBACK - TEXTO ENVIADO a ${cleanPhone}`);
                    }
                }
            } else {
                // Envío de texto normal
                sentMessage = await sessionData.client.sendMessage(chatId, message);
                console.log(`${ICONS.ok} [${targetSessionId}] TEXTO ENVIADO a ${cleanPhone}`);
            }
            
            const messageCount = incrementMessageCount(targetSessionId);
            
            if (sentMessage?.to) {
                const normalizedLid = normalizePhone(sentMessage.to);
                if (normalizedLid) {
                    if (normalizedLid !== cleanPhone) {
                        registerLidMapping(normalizedLid, cleanPhone);
                    } else if (realPhoneToLid.has(cleanPhone)) {
                        // Ya existe mapeo, asegurar consistencia en caso de reenvío
                        registerLidMapping(realPhoneToLid.get(cleanPhone), cleanPhone);
                    }
                }
            }
            
            res.json({
                success: true,
                messageId: sentMessage.id.id,
                phone: cleanPhone,
                sessionId: targetSessionId,
                messagesCount: messageCount,
                verified: !skipVerification,
                mediaType: media_type || 'text',
                timestamp: new Date().toISOString()
            });
        } catch (sendError) {
      console.log(`${ICONS.err} [${targetSessionId}] Error enviando a ${cleanPhone}: ${sendError.message}`);
      markNumberAsInvalid(cleanPhone.replace('+',''), sendError.message, 'send_error');
            res.status(500).json({ 
                success: false, 
                error: 'Error enviando mensaje',
                details: sendError.message,
                phone: cleanPhone,
                numberMarkedInvalid: true
            });
        }
    } catch (error) {
    console.error(`${ICONS.err} Error en envío con verificación:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ================================
// Frontend simple
// ================================
app.get('/', (req, res) => {
    const sessionsHtml = Array.from(clients.entries()).map(([sessionId, data]) => {
        const status = data.isReady ? 'connected' : 'disconnected';
    const statusText = data.isReady ? `${ICONS.ok} Conectado` : (data.qrCode ? `${ICONS.qr} Esperando QR` : `${ICONS.reconnect} Iniciando`);
        const isActive = activeSessionId === sessionId ? ' (ACTIVA)' : '';
        const messageCount = getMessageCount(sessionId);
        
        return `
            <div class="session-card ${status}">
        <h3>${ICONS.session} Sesión: ${sessionId}${isActive}</h3>
                <div class="status">${statusText}</div>
                <div class="message-counter">
          ${ICONS.stats} Mensajes hoy: <strong>${messageCount}</strong>
                </div>
                ${data.clientInfo ? `
                    <div class="info">
                        <strong>Usuario:</strong> ${data.clientInfo.pushname}<br>
            <strong>Número:</strong> +${data.clientInfo.wid.user}
          </div>` : ''}
                ${data.qrCode ? `
                    <div class="qr-container">
                        <img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(data.qrCode)}" alt="QR ${sessionId}">
          </div>` : ''}
                <div class="session-actions">
                    ${data.isReady ? `
                        <button onclick="setActiveSession('${sessionId}')" ${activeSessionId === sessionId ? 'disabled' : ''}>
              ${activeSessionId === sessionId ? `${ICONS.target} Activa` : `${ICONS.reconnect} Activar`}
                        </button>
            <button onclick="verifyNumberReal('${sessionId}')" class="verify-btn">${ICONS.link} Verificar Real</button>
            <button onclick="resetCounter('${sessionId}')" class="reset-btn">${ICONS.broom} Reset</button>
            <button onclick="deleteSession('${sessionId}')" class="delete-btn">${ICONS.trash} Eliminar</button>
                    ` : `
                        <button onclick="reconnectSession('${sessionId}')" class="reconnect-btn">${ICONS.reconnect} Reconectar</button>
            <button onclick="resetCounter('${sessionId}')" class="reset-btn">${ICONS.broom} Reset</button>
            <button onclick="deleteSession('${sessionId}')" class="delete-btn">${ICONS.trash} Eliminar</button>
                    `}
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
            .reconnect-btn { background: #17a2b8 !important; }
            .reconnect-btn:hover { background: #138496 !important; }
            .delete-btn { background: #dc3545 !important; }
            .delete-btn:hover { background: #c82333 !important; }
            .create-btn { background: #28a745 !important; }
            .create-btn:hover { background: #218838 !important; }
            .message-counter { 
        background: #e3f2fd; color: #1976d2; padding: 8px; border-radius: 5px; margin: 10px 0; font-weight: bold;
            }
            .controls { text-align: center; margin: 20px 0; padding: 20px; background: #f8f9fa; border-radius: 10px; }
            .detection-summary { 
        background: #d4edda; border: 1px solid #c3e6cb; color: #155724; padding: 10px; border-radius: 5px; margin: 10px 0;
      }
      pre { white-space: pre-wrap; text-align: left; }
        </style>
    </head>
    <body>
        <div class="container">
      <h1>${ICONS.rocket} WhatsApp DETECCIÓN REAL - Sin Patrones</h1>
            
            <div class="controls">
        <h3>${ICONS.target} Sesión Activa: ${activeSessionId || 'Ninguna'}</h3>
                <div class="detection-summary">
          ${ICONS.link} DETECCIÓN REAL ACTIVADA |
          ${ICONS.invalid} Números inválidos detectados: <strong>${invalidCount}</strong>
                </div>

        <button onclick="verifyNumberReal()">${ICONS.link} Verificar Número</button>
        <button onclick="showDetectionStats()" style="background: #dc3545;">${ICONS.stats} Ver Estadísticas</button>
        <button onclick="sendWithVerification()" style="background: #28a745;">${ICONS.phone} Enviar Verificado</button>
        <button onclick="createNewSession()" class="create-btn">➕ Nueva Sesión</button>
        <button onclick="location.reload()">${ICONS.reconnect} Actualizar</button>
            </div>
            
            <div class="sessions-grid">
        ${sessionsHtml || '<div class="session-card disconnected"><h3>📱 Sin sesiones</h3><p>Agrega un número para comenzar</p></div>'}
            </div>
            
      <h3>💡 Endpoints Disponibles:</h3>
      <div style="background:#e9ecef;padding:10px;border-left:4px solid #007bff;margin:10px 0;">
        <strong>POST /verify-number-real</strong> - Verificación real con WhatsApp<br>
                <pre>{"phone": "+56222655410", "sessionId": "principal"}</pre>
            </div>
      <div style="background:#e9ecef;padding:10px;border-left:4px solid #007bff;margin:10px 0;">
        <strong>POST /send-with-verification</strong> - Envío con verificación previa<br>
                <pre>{"phone": "+56912345678", "message": "Hola", "skipVerification": false}</pre>
            </div>
      <div style="background:#e9ecef;padding:10px;border-left:4px solid #dc3545;margin:10px 0;">
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
                result += '\\n• Método: ' + (data.method || '-');
                result += '\\n• Razón: ' + (data.reason || '-');
                result += '\\n• Ya marcado como inválido: ' + (data.isKnownInvalid ? 'SÍ' : 'NO');
                result += '\\n• Verificado con: ' + data.sessionId;
                                alert(result);
                if (!data.exists) location.reload();
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
              message += '⛔ Total números inválidos: ' + data.totalInvalid + '\\n\\n';
                            if (data.invalidNumbers.length > 0) {
                message += 'NÚMEROS CONFIRMADOS COMO INVÁLIDOS:\\n';
                data.invalidNumbers.forEach(phone => { message += '• ' + phone + '\\n'; });
                                message += '\\n';
                            }
              message += 'ESTADO DE ENTREGAS:\\n';
              message += '• Total mensajes enviados: ' + data.deliveryStats.total + '\\n';
              message += '• Entregados correctamente: ' + data.deliveryStats.delivered + '\\n';
              message += '• Atascados en servidor: ' + data.deliveryStats.stuckInServer + '\\n';
              message += '• Sin respuesta: ' + data.deliveryStats.noResponse + '\\n';
              message += '• Tiempo promedio entrega: ' + data.averageDeliveryTime + ' segundos\\n\\n';
              if (data.totalInvalid === 0) message += '✅ No hay números inválidos detectados.';
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
            body: JSON.stringify({ phone, message, skipVerification: !verify })
                    })
                    .then(r => r.json())
                    .then(data => {
                        if (data.success) {
              let result = '✅ MENSAJE ENVIADO\\n\\n';
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
              if (data.reason) error += 'Razón: ' + data.reason + '\\n';
              if (data.numberMarkedInvalid) error += '\\n⛔ El número fue marcado como INVÁLIDO automáticamente.';
                            alert(error);
              if (data.numberMarkedInvalid) location.reload();
                        }
                    })
          .catch(e => alert('❌ Error: ' + e));
                }
                
                function setActiveSession(sessionId) {
                    fetch('/set-active-session', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({sessionId})
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
              body: JSON.stringify({sessionId})
                        })
                        .then(r => r.json())
                        .then(data => {
              alert(data.success ? '✅ Contador reiniciado' : '❌ Error: ' + data.error);
                            location.reload();
                        });
                    }
                }
                
                function createNewSession() {
          const sessionName = prompt('Nombre para la nueva sesión (ej: numero1, empresa1, etc):');
                    if (sessionName && sessionName.trim()) {
                        const cleanName = sessionName.trim().replace(/[^a-zA-Z0-9-_]/g, '');
                        if (cleanName !== sessionName.trim()) {
              alert('⚠️ Se han removido caracteres especiales. Nombre final: ' + cleanName);
                        }
                        fetch('/create-session', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({sessionId: cleanName})
                        })
                        .then(r => r.json())
                        .then(data => {
                            if (data.success) {
                alert('✅ Sesión "' + cleanName + '" creada exitosamente.\\n\\nEscanea el código QR para conectar.');
                                location.reload();
                            } else {
                alert('❌ Error creando sesión: ' + data.error);
                            }
                        })
            .catch(e => alert('❌ Error: ' + e));
                    }
                }
                
                function deleteSession(sessionId) {
          if (confirm('¿Estás seguro de eliminar la sesión "' + sessionId + '"?\\n\\nEsto eliminará los datos de autenticación y tendrás que volver a escanear el QR.')) {
                        fetch('/delete-session', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({sessionId})
                        })
                        .then(r => r.json())
                        .then(data => {
                            if (data.success) {
                alert('✅ Sesión "' + sessionId + '" eliminada.');
                                location.reload();
                            } else {
                alert('❌ Error eliminando sesión: ' + data.error);
                            }
                        })
            .catch(e => alert('❌ Error: ' + e));
                    }
                }
                
                function reconnectSession(sessionId) {
          if (confirm('¿Reconectar la sesión "' + sessionId + '"?\\n\\nEsto intentará reinicializar la conexión y generar un nuevo código QR.')) {
                        fetch('/reconnect-session', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({sessionId})
                        })
                        .then(r => r.json())
                        .then(data => {
                            if (data.success) {
                alert('✅ Reconectando sesión "' + sessionId + '". La página se actualizará para mostrar el nuevo QR.');
                                location.reload();
                            } else {
                alert('❌ Error reconectando sesión: ' + data.error);
                            }
                        })
            .catch(e => alert('❌ Error: ' + e));
                    }
                }
                
        // Auto-refresh cada 60 s
                setTimeout(() => location.reload(), 60000);
            </script>
        </div>
    </body>
    </html>`;
    
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(fixEncoding(html));
});

// Rutas de apoyo
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

  const totalMessagesToday = Array.from(messageCounters.values())
    .reduce((total, counter) => counter.date === getCurrentDate() ? total + counter.count : total, 0);

    res.json({
        sessions: sessionsList,
        activeSession: activeSessionId,
        totalSessions: clients.size,
        date: getCurrentDate(),
    totalMessagesToday
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
    const totalToday = sessionStats.reduce((total, s) => total + s.messagesCount, 0);
    res.json({ date: today, totalToday, sessions: sessionStats, activeSession: activeSessionId });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/reset-counter', (req, res) => {
    try {
        const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ success: false, error: 'sessionId requerido' });
    if (!clients.has(sessionId)) return res.status(404).json({ success: false, error: 'Sesión no encontrada' });
        
        messageCounters.set(sessionId, { date: getCurrentDate(), count: 0 });
    console.log(`${ICONS.broom} Contador reiniciado para sesión: ${sessionId}`);
    res.json({ success: true, message: `Contador de ${sessionId} reiniciado`, newCount: 0 });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/create-session', (req, res) => {
    try {
        const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ success: false, error: 'sessionId requerido' });
        
        const cleanSessionId = sessionId.replace(/[^a-zA-Z0-9-_]/g, '');
        if (cleanSessionId !== sessionId) {
            return res.status(400).json({ 
                success: false, 
        error: 'El nombre de sesión contiene caracteres inválidos. Use solo letras, números, guiones y guiones bajos.'
            });
        }
        
        if (clients.has(sessionId)) {
      return res.status(400).json({ success: false, error: 'Ya existe una sesión con ese nombre' });
        }
        
    console.log(`➕ Creando nueva sesión: ${sessionId}`);
        const sessionData = createClient(sessionId);
        sessionData.client.initialize().catch(error => {
      console.error(`${ICONS.err} Error inicializando nueva sesión ${sessionId}:`, error.message);
            if (error.message.includes('ENOTFOUND') || error.message.includes('INTERNET_DISCONNECTED')) {
        console.log(`🌐 Error de conectividad al crear sesión ${sessionId}. Reintente más tarde.`);
      }
    });

    res.json({ success: true, message: `Sesión ${sessionId} creada exitosamente`, sessionId });
    } catch (error) {
    console.error(`${ICONS.err} Error creando sesión:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/delete-session', async (req, res) => {
    try {
        const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ success: false, error: 'sessionId requerido' });
    if (!clients.has(sessionId)) return res.status(404).json({ success: false, error: 'Sesión no encontrada' });

    console.log(`${ICONS.trash} Eliminando sesión: ${sessionId}`);
        const sessionData = clients.get(sessionId);
        
        if (sessionData.client) {
            try {
                await sessionData.client.destroy();
        console.log(`${ICONS.ok} Cliente ${sessionId} cerrado correctamente`);
            } catch (destroyError) {
        console.log(`${ICONS.warn} Error cerrando cliente ${sessionId}: ${destroyError.message}`);
            }
        }
        
        clients.delete(sessionId);
        savedSessions.delete(sessionId);
        messageCounters.delete(sessionId);
        
        if (activeSessionId === sessionId) {
      const availableSession = Array.from(clients.entries()).find(([id, data]) => data.isReady);
            if (availableSession) {
                activeSessionId = availableSession[0];
        console.log(`${ICONS.reconnect} Sesión activa cambiada a: ${activeSessionId}`);
            } else {
                activeSessionId = null;
        console.log(`${ICONS.warn} No hay sesiones activas disponibles`);
            }
        }
        
        try {
            const fs = require('fs');
            const authDirs = [
                `.wwebjs_auth/session-messagehub-${sessionId}`,
                `.wwebjs_auth\\session-messagehub-${sessionId}`,
                `messagehub-${sessionId}`
            ];
            for (const authDir of authDirs) {
                if (fs.existsSync(authDir)) {
                    fs.rmSync(authDir, { recursive: true, force: true });
          console.log(`${ICONS.broom} Archivos de autenticación eliminados: ${authDir}`);
                    break;
                }
            }
        } catch (fsError) {
      console.log(`${ICONS.warn} No se pudieron eliminar archivos de autenticación: ${fsError.message}`);
    }

    res.json({ success: true, message: `Sesión ${sessionId} eliminada`, activeSession: activeSessionId });
    } catch (error) {
    console.error(`${ICONS.err} Error eliminando sesión:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/reconnect-session', async (req, res) => {
    try {
        const { sessionId } = req.body;
        if (!sessionId) return res.status(400).json({ success: false, error: 'sessionId requerido' });
        if (!clients.has(sessionId)) return res.status(404).json({ success: false, error: 'Sesión no encontrada' });

        console.log(`${ICONS.reconnect} Reconectando sesión: ${sessionId}`);
        const sessionData = clients.get(sessionId);
        
        // 1. Cerrar cliente actual si existe
        if (sessionData.client) {
            try {
                await sessionData.client.destroy();
                console.log(`${ICONS.ok} Cliente anterior ${sessionId} cerrado correctamente`);
            } catch (destroyError) {
                console.log(`${ICONS.warn} Error cerrando cliente anterior ${sessionId}: ${destroyError.message}`);
            }
        }
        
        // 2. Limpiar estado de la sesión
        sessionData.isReady = false;
        sessionData.qrCode = null;
        sessionData.clientInfo = null;
        
        // 3. Crear nuevo cliente
        console.log(`${ICONS.reconnect} Creando nuevo cliente para ${sessionId}...`);
        const newSessionData = createClient(sessionId);
        
        // 4. Inicializar cliente para generar nuevo QR
        try {
            await newSessionData.client.initialize();
            console.log(`${ICONS.ok} Cliente ${sessionId} reinicializado exitosamente`);
            
            res.json({ 
                success: true, 
                message: `Sesión ${sessionId} reconectada - generando nuevo QR`,
                sessionId: sessionId
            });
        } catch (initError) {
            console.error(`${ICONS.err} Error inicializando cliente ${sessionId}:`, initError.message);
            res.status(500).json({ 
                success: false, 
                error: 'Error inicializando sesión: ' + initError.message 
            });
        }
        
    } catch (error) {
        console.error(`${ICONS.err} Error reconectando sesión:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/set-active-session', (req, res) => {
    try {
        const { sessionId } = req.body;
    if (!clients.has(sessionId)) return res.status(404).json({ success: false, error: 'Sesión no encontrada' });
        
        const sessionData = clients.get(sessionId);
    if (!sessionData.isReady) return res.status(400).json({ success: false, error: 'Sesión no está lista' });
        
        activeSessionId = sessionId;
    console.log(`${ICONS.target} Sesión activa cambiada a: ${sessionId}`);
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

// Envío "regular" (compatibilidad) CON SOPORTE PARA MULTIMEDIA Y SESIONES
app.post('/send', async (req, res) => {
    try {
        const { phone, message, campaign_id, campaign_name, sessionId, media_type, media_url, media_caption } = req.body;
    if (!phone || !message) return res.status(400).json({ success: false, error: 'phone y message requeridos' });
        
        const targetSessionId = sessionId || activeSessionId;
    const sessionType = sessionId ? '(específica)' : '(por defecto)';
    console.log(`[SEND] Usando sesión: ${targetSessionId} ${sessionType}`);
        
    if (!targetSessionId) return res.status(400).json({ success: false, error: 'No hay sesión disponible' });
        
        const sessionData = clients.get(targetSessionId);
    if (!sessionData?.isReady) return res.status(400).json({ success: false, error: `Sesión ${targetSessionId} no está lista` });
        
        let cleanPhone = phone.replace(/[^0-9+]/g, '');
        if (!cleanPhone.startsWith('+')) {
      if (cleanPhone.startsWith('56')) cleanPhone = '+' + cleanPhone;
      else cleanPhone = '+56' + cleanPhone;
    }

        if (invalidNumbers.has(cleanPhone.replace('+', ''))) {
            return res.status(400).json({ 
                success: false, 
        error: 'Número confirmado como inválido',
                phone: cleanPhone,
                suggestion: 'Use /send-with-verification para verificar antes de enviar'
            });
        }
        
        const chatId = cleanPhone.substring(1) + '@c.us';
    const timeStr = new Date().toLocaleTimeString('es-CL', { hour12: false });
        const campaignInfo = campaign_name ? ` (${campaign_name})` : campaign_id ? ` (#${campaign_id})` : '';
    console.log(`${ICONS.send} [${timeStr}] [${targetSessionId}] → ${cleanPhone}${campaignInfo}`);
        
        try {
            let sentMessage;
            
            // 🖼️ MANEJAR MULTIMEDIA SI EXISTE
            if (media_type && media_type !== 'text' && media_url) {
                console.log(`🖼️ Enviando ${media_type}: ${media_url}`);
                
                // Validar URL de media primero
                const mediaValidation = await validateMediaUrl(media_url, media_type);
                if (!mediaValidation.valid) {
                    console.error(`${ICONS.err} URL de media inválida: ${mediaValidation.error}`);
                    // Fallback: enviar solo el mensaje de texto
                    sentMessage = await sessionData.client.sendMessage(chatId, message);
                    console.log(`${ICONS.warn} [${timeStr}] FALLBACK - TEXTO ENVIADO (media inválida): ${cleanPhone}${campaignInfo}`);
                } else {
                    try {
                        // Crear MessageMedia desde URL usando whatsapp-web.js
                        const media = await makeMessageMediaFromUrl(media_url);
                        
                        // Configurar opciones de envío
                        const sendOptions = {};
                        if (media_caption || message) {
                            sendOptions.caption = media_caption || message;
                        }
                        
                        // Enviar mensaje multimedia
                        sentMessage = await sessionData.client.sendMessage(chatId, media, sendOptions);
                        console.log(`🖼️ [${timeStr}] MEDIA ENVIADA: ${cleanPhone}${campaignInfo}`);
                    } catch (mediaError) {
                        console.error(`${ICONS.err} Error procesando multimedia ${media_url}:`, mediaError.message);
                        // Fallback: enviar solo el mensaje de texto
                        sentMessage = await sessionData.client.sendMessage(chatId, message);
                        console.log(`${ICONS.warn} [${timeStr}] FALLBACK - TEXTO ENVIADO: ${cleanPhone}${campaignInfo}`);
                    }
                }
            } else {
                // Envío de texto normal
                sentMessage = await sessionData.client.sendMessage(chatId, message);
                console.log(`${ICONS.ok} [${timeStr}] TEXTO ENVIADO: ${cleanPhone}${campaignInfo}`);
            }
            
            const messageCount = incrementMessageCount(targetSessionId);

            if (sentMessage?.to) {
                const normalizedLid = normalizePhone(sentMessage.to);
                if (normalizedLid) {
                    if (normalizedLid !== cleanPhone) {
                        registerLidMapping(normalizedLid, cleanPhone);
                    } else if (realPhoneToLid.has(cleanPhone)) {
                        registerLidMapping(realPhoneToLid.get(cleanPhone), cleanPhone);
                    }
                }
            }

            res.json({
                success: true,
                messageId: sentMessage.id.id,
                phone: cleanPhone,
                sessionId: targetSessionId,
                messagesCount: messageCount,
                timestamp: new Date().toISOString(),
                mediaType: media_type || 'text'
            });
        } catch (sendError) {
      console.log(`${ICONS.err} [${timeStr}] ERROR: ${cleanPhone}${campaignInfo} - ${sendError.message}`);
            
            // 🔥 SOLO MARCAR COMO INVÁLIDO SI ES UN ERROR REAL DE NÚMERO
            const errorMessage = sendError.message.toLowerCase();
            const isNumberError = errorMessage.includes('invalid') || 
                                 errorMessage.includes('not found') || 
                                 errorMessage.includes('doesn\'t exist') ||
                                 errorMessage.includes('not registered') ||
                                 errorMessage.includes('invalid number') ||
                                 errorMessage.includes('número inválido');
            
            if (isNumberError) {
                markNumberAsInvalid(cleanPhone.replace('+', ''), sendError.message, 'send_error');
                res.status(500).json({ 
                    success: false, 
                    error: 'Error enviando mensaje - número marcado como inválido',
                    details: sendError.message,
                    phone: cleanPhone
                });
            } else {
                // Error temporal (imagen, conexión, etc.) - NO marcar como inválido
                res.status(500).json({ 
                    success: false, 
                    error: 'Error temporal enviando mensaje',
                    details: sendError.message,
                    phone: cleanPhone,
                    retry: true
                });
            }
        }
  } catch (error) {
    console.error(`${ICONS.err} Error enviando:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// NUEVO: Obtener sesiones disponibles para selección de números
app.get('/available-sessions', (req, res) => {
  try {
    const sessions = [];
    
    for (const [sessionId, sessionData] of clients.entries()) {
      const messageCount = getMessageCount(sessionId);
      sessions.push({
        sessionId: sessionId,
        isReady: sessionData.isReady,
        clientInfo: sessionData.clientInfo,
        isActive: sessionId === activeSessionId,
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
      defaultSession: activeSessionId
    });
        
    } catch (error) {
    console.error(`${ICONS.err} Error obteniendo sesiones:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// NUEVO: Load Balancer - Seleccionar mejor sesión automáticamente
app.get('/best-session', (req, res) => {
  try {
    const availableSessions = [];
    
    for (const [sessionId, sessionData] of clients.entries()) {
      if (sessionData.isReady) {
        const messageCount = getMessageCount(sessionId);
        availableSessions.push({
          sessionId: sessionId,
          messagesCount: messageCount,
          lastActivity: sessionData.lastActivity
        });
      }
    }
    
    if (availableSessions.length === 0) {
      return res.status(503).json({
        success: false,
        error: 'No hay sesiones disponibles',
        suggestion: 'Conéctate al menos a una sesión primero'
      });
    }
    
    // Seleccionar sesión con menos mensajes enviados hoy
    const bestSession = availableSessions.reduce((best, current) => 
      current.messagesCount < best.messagesCount ? current : best
    );
    
    res.json({ 
        success: true, 
      bestSession: bestSession.sessionId,
      messagesCount: bestSession.messagesCount,
      totalAvailableSessions: availableSessions.length
    });
    
  } catch (error) {
    console.error(`${ICONS.err} Error en load balancer:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Test
app.get('/test-connection', (req, res) => {
  res.json({ success: true, message: 'WhatsApp server working!', timestamp: new Date().toISOString() });
});

// Verificación de leído para un contacto
app.post('/check-message-read-status', async (req, res) => {
    try {
        const { phone, messageId, updateDB = true } = req.body;
    if (!phone) return res.status(400).json({ error: 'Teléfono requerido' });
        
        const activeClient = getActiveClient();
        if (!activeClient || !activeClient.isReady) {
      return res.status(503).json({ error: 'WhatsApp no conectado', ready: false });
        }

        const client = activeClient.client;
        const formattedPhone = phone.replace('+', '') + '@c.us';
        
        try {
            const chat = await client.getChatById(formattedPhone);
            if (!chat) {
        return res.json({ read: false, reason: 'Chat no encontrado', method: 'chat_lookup' });
      }

            const messages = await chat.fetchMessages({ limit: 20 });
            const sentMessages = messages.filter(msg => msg.fromMe);
            if (sentMessages.length === 0) {
        return res.json({ read: false, reason: 'No hay mensajes enviados en este chat', method: 'no_sent_messages' });
      }

            const lastSentMessage = sentMessages[0];
            const ackStatus = lastSentMessage.ack;
      const isRead = ackStatus >= MessageAck.ACK_READ;
      const isDelivered = ackStatus >= MessageAck.ACK_DEVICE;
            
            let newStatus = null;
      if (isRead) newStatus = 'read';
      else if (isDelivered) newStatus = 'delivered';

            let dbUpdated = false;
            if (updateDB && newStatus) {
                dbUpdated = await updateMessageStatusInDB(phone, newStatus, lastSentMessage.id.id);
            }
            
      console.log(`${ICONS.link} Verificación para ${phone}: ACK ${ackStatus} -> ${newStatus} (DB: ${dbUpdated})`);
            
            return res.json({
                read: isRead,
                delivered: isDelivered,
                ack: ackStatus,
                status: newStatus,
                messageId: lastSentMessage.id.id,
        messagePreview: (lastSentMessage.body || '').substring(0, 50),
                method: 'message_ack_check',
        dbUpdated,
                timestamp: Date.now()
            });
        } catch (chatError) {
      console.log(`${ICONS.warn} Error accediendo al chat ${phone}: ${chatError.message}`);
      return res.json({ read: false, reason: 'No se pudo acceder al chat', method: 'chat_error', error: chatError.message });
    }
    } catch (error) {
    console.error(`${ICONS.err} Error verificando estado de lectura:`, error);
    res.status(500).json({ error: 'Error interno del servidor', details: error.message });
  }
});

// Verificación masiva por campaña
app.post('/batch-check-read-status', async (req, res) => {
    try {
        const { campaignId } = req.body;
    if (!campaignId) return res.status(400).json({ error: 'Campaign ID requerido' });
        
        const connection = await connectDB();
    if (!connection) return res.status(500).json({ error: 'Error conectando a BD' });

        const query = `
            SELECT phone, id, status 
            FROM message_logs 
            WHERE campaign_id = ? 
        AND status IN ('sent','delivered')
            ORDER BY sent_at DESC
            LIMIT 20
        `;
        const [rows] = await connection.execute(query, [campaignId]);
        await connection.end();

        if (rows.length === 0) {
            return res.json({ 
                message: 'No hay mensajes pendientes para verificar',
        checked: 0, newly_read: 0, still_unread: 0, errors: 0
            });
        }

    let newly_read = 0, still_unread = 0, errors = 0;
        const results = [];

    const active = getActiveClient();
    if (!active?.isReady) {
      return res.status(503).json({ error: 'WhatsApp no conectado', ready: false });
    }

        for (const row of rows) {
            try {
        const checkResult = await checkSingleMessageStatus(active.client, row.phone);
                if (checkResult.read && row.status !== 'read') {
                    const updated = await updateMessageStatusInDB(row.phone, 'read');
                    if (updated) newly_read++;
                } else {
                    still_unread++;
                }
                results.push({
                    phone: row.phone,
                    oldStatus: row.status,
                    newStatus: checkResult.read ? 'read' : row.status,
                    ...checkResult
                });
        await new Promise(r => setTimeout(r, 300));
            } catch (error) {
                errors++;
                console.error(`Error verificando ${row.phone}:`, error.message);
            }
        }

        res.json({
            success: true,
      campaignId,
            checked: rows.length,
      newly_read, still_unread, errors,
      results,
            timestamp: Date.now()
        });
    } catch (error) {
    console.error(`${ICONS.err} Error en verificación masiva:`, error);
    res.status(500).json({ error: 'Error interno del servidor', details: error.message });
  }
});

async function checkSingleMessageStatus(client, phone) {
    const formattedPhone = phone.replace('+', '') + '@c.us';
    try {
        const chat = await client.getChatById(formattedPhone);
        const messages = await chat.fetchMessages({ limit: 10 });
        const sentMessages = messages.filter(msg => msg.fromMe);
        if (sentMessages.length === 0) {
      return { read: false, reason: 'No hay mensajes enviados', method: 'no_messages' };
    }
        const lastMessage = sentMessages[0];
    const isRead = lastMessage.ack >= MessageAck.ACK_READ;
    return { read: isRead, ack: lastMessage.ack, messageId: lastMessage.id.id, method: 'message_ack' };
    } catch (error) {
    return { read: false, reason: error.message, method: 'error' };
  }
}

// ================================
// Inicio del servidor
// ================================
console.log(`${ICONS.info} Iniciando servidor WhatsApp con DETECCIÓN REAL...`);

loadSavedSessions();


// === Montaje de rutas de distribución automática ===
try {
  const sessionManager = {
    clients,
    get activeSessionId() { return activeSessionId; },
    set activeSessionId(v) { activeSessionId = v; },
    savedSessions,
    getCurrentDate,
    getMessageCount: (sid) => getMessageCount(sid),
    incrementMessageCount: (sid) => incrementMessageCount(sid)
  };
  if (CampaignProcessor && Routes) {
    const campaignProcessor = new CampaignProcessor(sessionManager);
    const routes = new Routes(sessionManager, campaignProcessor);
    app.use('/', routes.router);
    console.log('🧩 Rutas de distribución automática montadas (/send-campaign-distributed-automatic)');
  } else {
    console.log('⚠️ campaignProcessor.js o routes.js no encontrados; servidor seguirá sin distribución automática.');
  }
} catch (e) {
  console.log('⚠️ No se pudieron montar rutas distribuidas:', e.message);
}
app.listen(PORT, () => {
  console.log(`\n🌐 Servidor DETECCIÓN REAL iniciado en http://localhost:${PORT}`);
  console.log(`${ICONS.link} DETECCIÓN REAL DE WHATSAPP ACTIVADA`);
  console.log(`${ICONS.stats} Métodos de detección:`);
    console.log('   1. getNumberId() - Verificar registro en WhatsApp');
    console.log('   2. getContactById() - Verificar accesibilidad del contacto');
  console.log('   3. message_ack events - Tracking de estados de entrega/lectura');
  console.log('   4. send errors - Detección de errores directos');
  console.log(`${ICONS.rocket} SIN PATRONES - Detección basada en respuestas reales de WhatsApp\n`);

  setTimeout(() => autoInitializeSessions(), 2000);
});

process.on('SIGINT', async () => {
  console.log(`\n🛑 Cerrando servidor...`);
    for (const [sessionId, sessionData] of clients) {
    console.log(`${ICONS.logout} Cerrando sesión: ${sessionId}`);
        if (sessionData.client) {
      try { await sessionData.client.destroy(); } catch {}
        }
    }
    process.exit(0);
});
