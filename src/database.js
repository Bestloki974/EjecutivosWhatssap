// src/database.js - Módulo de gestión de base de datos
const mysql = require('mysql2/promise');
const config = require('./config');
const logger = require('./logger');

class Database {
    constructor() {
        this.config = config.DB_CONFIG;
    }
    
    async connect() {
        try {
            const connection = await mysql.createConnection(this.config);
            return connection;
        } catch (error) {
            logger.error(`Error conectando a la base de datos: ${error.message}`);
            return null;
        }
    }
    
    async updateMessageStatus(phone, newStatus, messageId = null) {
        const connection = await this.connect();
        if (!connection) return false;
        
        try {
            // Normalizar teléfono: remover sufijos @c.us, @lid, etc.
            let cleanPhone = phone.replace(/@c\.us$|@lid$|@g\.us$|@[a-z\.]+$/i, '');
            if (!cleanPhone.startsWith('+')) {
                cleanPhone = '+' + cleanPhone;
            }

            // 🔍 BUSCAR MENSAJE MÁS RECIENTE (mejorado)
            const findQuery = `
                SELECT id, status, campaign_id 
                FROM message_logs 
                WHERE phone = ? OR phone = ?
                ORDER BY sent_at DESC 
                LIMIT 1
            `;
            
            const phonePlus = cleanPhone.startsWith('+') ? cleanPhone : '+' + cleanPhone;
            const phoneNoPlus = phonePlus.slice(1);
            const [rows] = await connection.execute(findQuery, [phonePlus, phoneNoPlus]);
            
            if (rows.length === 0) {
                logger.debug(`⚠️ No se encontró mensaje para actualizar: ${cleanPhone}`);
                return false;
            }
            
            const messageLog = rows[0];
            const statusHierarchy = { 'sent': 1, 'delivered': 2, 'read': 3 };
            
            // ✅ PERMITIR ACTUALIZACIÓN SIEMPRE SI ES A UN ESTADO SUPERIOR
            if (statusHierarchy[newStatus] <= statusHierarchy[messageLog.status]) {
                logger.debug(`⚠️ Estado ${newStatus} no supera a ${messageLog.status} para ${cleanPhone}`);
                return false;
            }
            
            let updateQuery;
            if (newStatus === 'read') {
                updateQuery = `
                    UPDATE message_logs 
                    SET status = 'read', delivery_status = 'read', read_at = NOW()
                    WHERE id = ?
                `;
            } else if (newStatus === 'delivered') {
                updateQuery = `
                    UPDATE message_logs 
                    SET status = 'delivered', delivery_status = 'delivered', delivered_at = NOW()
                    WHERE id = ?
                `;
            } else {
                return false;
            }
            
            await connection.execute(updateQuery, [messageLog.id]);
            await this.updateCampaignStats(messageLog.campaign_id);
            
            logger.debug(`Estado actualizado en DB: ${cleanPhone} -> ${newStatus}`);
            return true;
            
        } catch (error) {
            logger.error(`Error actualizando estado en DB para ${phone}: ${error.message}`);
            return false;
        } finally {
            await connection.end();
        }
    }
    
    async updateCampaignStats(campaignId) {
        const connection = await this.connect();
        if (!connection) return;
        
        try {
            const statsQuery = `
                UPDATE campaigns SET
                    total_delivered = (
                        SELECT COUNT(*) FROM message_logs 
                        WHERE campaign_id = ? AND status IN ('delivered', 'read')
                    ),
                    total_read = (
                        SELECT COUNT(*) FROM message_logs 
                        WHERE campaign_id = ? AND status = 'read'
                    ),
                    total_replied = (
                        SELECT COUNT(*) FROM message_logs 
                        WHERE campaign_id = ? AND response_received = 1
                    ),
                    response_rate = ROUND(
                        (SELECT COUNT(*) FROM message_logs WHERE campaign_id = ? AND response_received = 1) /
                        (SELECT COUNT(*) FROM message_logs WHERE campaign_id = ? AND status IN ('sent', 'delivered', 'read')) * 100, 2
                    )
                WHERE id = ?
            `;
            
            await connection.execute(statsQuery, [campaignId, campaignId, campaignId, campaignId, campaignId, campaignId]);
            
        } catch (error) {
            logger.error(`Error actualizando estadísticas de campaña ${campaignId}: ${error.message}`);
        } finally {
            await connection.end();
        }
    }
    
    async saveMessage(campaignId, contactId, phone, messageContent, messageId, mediaType = null, mediaUrl = null) {
        const connection = await this.connect();
        if (!connection) return false;
        
        try {
            const query = `
                INSERT INTO message_logs 
                (campaign_id, contact_id, phone, message_content, external_message_id, status, sent_at, media_type, media_url)
                VALUES (?, ?, ?, ?, ?, 'sent', NOW(), ?, ?)
            `;
            
            await connection.execute(query, [
                campaignId, contactId, phone, messageContent, messageId, mediaType, mediaUrl
            ]);
            
            return true;
            
        } catch (error) {
            logger.error(`Error guardando mensaje en BD para ${phone}: ${error.message}`);
            return false;
        } finally {
            await connection.end();
        }
    }
    
    async saveResponse(phone, responseText, messageId = null) {
        const connection = await this.connect();
        if (!connection) return false;
        
        try {
            // Normalizar teléfono: remover sufijos @c.us, @lid, etc.
            let cleanPhone = phone.replace(/@c\.us$|@lid$|@g\.us$|@[a-z\.]+$/i, '');
            if (!cleanPhone.startsWith('+')) {
                cleanPhone = '+' + cleanPhone;
            }

            const findQuery = `
                SELECT id, campaign_id, contact_id
                FROM message_logs 
                WHERE (phone = ? OR phone = ?)
                AND status IN ('sent', 'delivered', 'read')
                ORDER BY sent_at DESC 
                LIMIT 1
            `;
            
            const phonePlus = cleanPhone.startsWith('+') ? cleanPhone : '+' + cleanPhone;
            const phoneNoPlus = phonePlus.slice(1);
            let [rows] = await connection.execute(findQuery, [phonePlus, phoneNoPlus]);
            
            // Fallback: si no encontramos por teléfono y tenemos messageId, buscar por external_message_id
            if ((!rows || rows.length === 0) && messageId) {
                const [byIdRows] = await connection.execute(
                    `SELECT id, campaign_id, contact_id FROM message_logs WHERE external_message_id = ? LIMIT 1`,
                    [messageId]
                );
                if (byIdRows && byIdRows.length > 0) {
                    rows = byIdRows;
                    logger.debug(`Respuesta vinculada por external_message_id=${messageId}`);
                }
            }

            // Fallback 2: si aún no encontramos, buscar el último mensaje sin respuesta EN LOS ÚLTIMOS 5 MINUTOS
            // IMPORTANTE: Solo en últimos 5 minutos para NO vincular a mensajes antiguos
            if ((!rows || rows.length === 0)) {
                logger.debug(`No se encontró por teléfono. Buscando en últimos 5 minutos...`);
                const [anyRows] = await connection.execute(
                    `SELECT id, campaign_id, contact_id FROM message_logs WHERE response_received = 0 AND status IN ('sent','delivered','read') AND sent_at >= DATE_SUB(NOW(), INTERVAL 5 MINUTE) ORDER BY sent_at DESC LIMIT 1`
                );
                if (anyRows && anyRows.length > 0) {
                    rows = anyRows;
                    logger.debug(`Respuesta vinculada al último mensaje sin respuesta (últimos 5 min - flexible matching)`);
                }
            }
            
            if (rows && rows.length > 0) {
                const messageLog = rows[0];
                
                const updateQuery = `
                    UPDATE message_logs 
                    SET response_received = 1, response_text = ?, response_at = NOW(), 
                        replied_at = NOW(), status = 'read'
                    WHERE id = ?
                `;
                
                await connection.execute(updateQuery, [responseText, messageLog.id]);
                
                if (messageLog.campaign_id) {
                    await this.updateCampaignStats(messageLog.campaign_id);
                }
                
                return true;
            }
            return false;
            
        } catch (error) {
            logger.error(`Error guardando respuesta para ${phone}: ${error.message}`);
            return false;
        } finally {
            await connection.end();
        }
    }
    
    async updateMessageLogStatus(contactId, status, errorMessage, campaignId) {
        if (!contactId || !campaignId || !status) {
            logger.error(`Parámetros faltantes - Contact: ${contactId}, Campaign: ${campaignId}, Status: ${status}`);
            return false;
        }
        
        const connection = await this.connect();
        if (!connection) return false;
        
        try {
            let updateQuery;
            let updateParams;
            
            if (status === 'failed') {
                updateQuery = `
                    UPDATE message_logs 
                    SET status = 'failed', error_message = ?, sent_at = NOW()
                    WHERE contact_id = ? AND campaign_id = ?
                `;
                updateParams = [errorMessage || 'Error desconocido', contactId, campaignId];
            } else {
                updateQuery = `
                    UPDATE message_logs 
                    SET status = 'sent', sent_at = NOW()
                    WHERE contact_id = ? AND campaign_id = ?
                `;
                updateParams = [contactId, campaignId];
            }
            
            await connection.execute(updateQuery, updateParams);
            return true;
            
        } catch (error) {
            logger.error(`Error actualizando message_log para contacto ${contactId}: ${error.message}`);
            return false;
        } finally {
            await connection.end();
        }
    }
    
    // 📊 ACTUALIZAR ESTADO DE CAMPAÑA
    async updateCampaignStatus(campaignId, status, additionalData = {}) {
        const connection = await this.connect();
        if (!connection) return false;
        
        try {
            let updateQuery = `UPDATE campaigns SET status = ?`;
            let updateParams = [status, campaignId];
            
            // Agregar campos adicionales según el estado
            if (status === 'completed') {
                updateQuery += `, completed_at = NOW()`;
            } else if (status === 'sending') {
                updateQuery += `, started_at = NOW()`;
            }
            
            // Agregar estadísticas si se proporcionan
            if (additionalData.messages_sent !== undefined) {
                updateQuery += `, messages_sent = ?`;
                updateParams.splice(-1, 0, additionalData.messages_sent);
            }
            
            if (additionalData.messages_delivered !== undefined) {
                updateQuery += `, messages_delivered = ?`;
                updateParams.splice(-1, 0, additionalData.messages_delivered);
            }
            
            if (additionalData.messages_failed !== undefined) {
                updateQuery += `, messages_failed = ?`;
                updateParams.splice(-1, 0, additionalData.messages_failed);
            }
            
            updateQuery += ` WHERE id = ?`;
            
            const [result] = await connection.execute(updateQuery, updateParams);
            logger.info(`📊 Campaña ${campaignId} actualizada a estado '${status}' (${result.affectedRows} filas afectadas)`);
            
            await connection.end();
            return result.affectedRows > 0;
            
        } catch (error) {
            logger.error(`❌ Error actualizando estado de campaña ${campaignId}: ${error.message}`);
            await connection.end();
            return false;
        }
    }

    // Obtener estado actual de campaña desde BD
    async getCampaignStatusFromDB(campaignId) {
        const connection = await this.connect();
        if (!connection) return null;
        try {
            const [rows] = await connection.execute('SELECT id, status FROM campaigns WHERE id = ?', [campaignId]);
            await connection.end();
            if (rows && rows.length > 0) return rows[0];
            return null;
        } catch (error) {
            logger.error(`❌ Error obteniendo estado de campaña ${campaignId}: ${error.message}`);
            await connection.end();
            return null;
        }
    }

    // 🔧 FUNCIÓN PARA CORREGIR ESTADOS DE MENSAJES
    async fixMessageStates() {
        const connection = await this.connect();
        if (!connection) return false;
        
        try {
            // 1. Corregir mensajes que están como 'pending' pero deberían estar como 'delivered'
            const fixDeliveredQuery = `
                UPDATE message_logs 
                SET status = 'delivered', 
                    delivery_status = 'delivered',
                    delivered_at = sent_at,
                    updated_at = NOW()
                WHERE status = 'pending' 
                AND sent_at < NOW() - INTERVAL 5 MINUTE
                AND error_message IS NULL
            `;
            
            const [deliveredResult] = await connection.execute(fixDeliveredQuery);
            logger.info(`✅ ${deliveredResult.affectedRows} mensajes corregidos a 'delivered'`);
            
            // 2. Corregir contactos que están como 'invalid' pero tienen mensajes entregados
            const fixInvalidQuery = `
                UPDATE campaign_contacts cc
                JOIN message_logs ml ON cc.campaign_id = ml.campaign_id AND cc.contact_phone = ml.phone
                SET cc.whatsapp_status = 'valid'
                WHERE cc.whatsapp_status = 'invalid'
                AND ml.status IN ('delivered', 'read', 'sent')
            `;
            
            const [invalidResult] = await connection.execute(fixInvalidQuery);
            logger.info(`✅ ${invalidResult.affectedRows} contactos corregidos de 'invalid' a 'valid'`);
            
            await connection.end();
            return true;
            
        } catch (error) {
            logger.error(`❌ Error corrigiendo estados: ${error.message}`);
            await connection.end();
            return false;
        }
    }
}

module.exports = new Database();

