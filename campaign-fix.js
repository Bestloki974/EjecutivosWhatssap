// campaign-fix.js - Script para corregir problemas de estados y auto-logout
const database = require('./src/database');

class CampaignFix {
    constructor() {
        this.activeCampaigns = new Set();
    }

    // Registrar campaña activa para evitar auto-logout
    registerActiveCampaign(campaignId) {
        this.activeCampaigns.add(campaignId);
        console.log(`🔒 Campaña ${campaignId} registrada - Auto-logout deshabilitado`);
    }

    // Desregistrar campaña completada
    unregisterActiveCampaign(campaignId) {
        this.activeCampaigns.delete(campaignId);
        console.log(`🔓 Campaña ${campaignId} completada - Auto-logout habilitado`);
    }

    // Verificar si hay campañas activas
    hasActiveCampaigns() {
        return this.activeCampaigns.size > 0;
    }

    // Corregir estados de mensajes desactualizados
    async fixMessageStates() {
        try {
            const connection = await database.getConnection();
            
            // Corregir mensajes que están como 'pending' pero deberían estar como 'delivered'
            const fixDeliveredQuery = `
                UPDATE message_logs 
                SET status = 'delivered', 
                    updated_at = NOW()
                WHERE status = 'pending' 
                AND sent_at < NOW() - INTERVAL 5 MINUTE
                AND error_message IS NULL
            `;
            
            const deliveredResult = await connection.execute(fixDeliveredQuery);
            console.log(`✅ ${deliveredResult[0].affectedRows} mensajes corregidos a 'delivered'`);
            
            // Corregir contactos que están como 'WhatsApp Inválido' pero tienen mensajes entregados
            const fixInvalidQuery = `
                UPDATE campaign_contacts cc
                JOIN message_logs ml ON cc.campaign_id = ml.campaign_id AND cc.contact_phone = ml.phone
                SET cc.whatsapp_status = 'valid'
                WHERE cc.whatsapp_status = 'invalid'
                AND ml.status IN ('delivered', 'read', 'sent')
            `;
            
            const invalidResult = await connection.execute(fixInvalidQuery);
            console.log(`✅ ${invalidResult[0].affectedRows} contactos corregidos de 'invalid' a 'valid'`);
            
            await connection.end();
            
        } catch (error) {
            console.error('❌ Error corrigiendo estados:', error.message);
        }
    }
}

// Exportar instancia singleton
module.exports = new CampaignFix();

