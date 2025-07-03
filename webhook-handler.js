// webhook-handler.js - Módulo para capturar respuestas y enviar webhook
const fetch = require('node-fetch');

// Configuración
const WEBHOOK_URL = 'http://localhost/sistemasms/backend/api/whatsapp/webhook-responses.php';

// 🆕 FUNCIÓN PARA ENVIAR WEBHOOK
async function sendWebhook(data) {
    try {
        console.log('📡 Enviando webhook:', JSON.stringify(data, null, 2));
        
        const response = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data)
        });
        
        if (response.ok) {
            const responseText = await response.text();
            console.log('✅ Webhook enviado exitosamente - Respuesta:', responseText);
        } else {
            console.log('❌ Error en webhook:', response.status, response.statusText);
            const errorText = await response.text();
            console.log('❌ Error details:', errorText);
        }
    } catch (error) {
        console.error('❌ Error enviando webhook:', error.message);
    }
}

// 🆕 FUNCIÓN PARA AGREGAR LISTENERS DE WEBHOOK A UN CLIENTE
function addWebhookListeners(client, sessionName = 'principal') {
    console.log(`🔗 Agregando webhook listeners a sesión: ${sessionName}`);
    
    // Capturar respuestas recibidas
    client.on('message', async (message) => {
        try {
            // Solo procesar mensajes recibidos (no enviados por nosotros)
            if (!message.fromMe && message.from.endsWith('@c.us')) {
                const fromPhone = message.from.replace('@c.us', '');
                const messageText = message.body;
                const timestamp = Math.floor(Date.now() / 1000);
                
                console.log(`📨 [${sessionName}] Respuesta recibida de +${fromPhone}: ${messageText}`);
                
                // Enviar webhook con la respuesta
                await sendWebhook({
                    messages: [{
                        from: '+' + fromPhone,
                        body: messageText,
                        timestamp: timestamp,
                        messageId: message.id.id,
                        chatId: message.from,
                        sessionName: sessionName
                    }]
                });
            }
        } catch (error) {
            console.error('❌ Error procesando mensaje recibido:', error);
        }
    });

    // ⭐ CAPTURAR ACK (confirmaciones de entrega) - VERSIÓN CORREGIDA
    client.on('message_ack', async (message, ack) => {
        try {
            // Solo procesar mensajes enviados por nosotros
            if (!message.fromMe) return;
            
            const phone = message.to.replace('@c.us', '');
            let status = 'unknown';
            
            // Mapear ACK de WhatsApp a estados
            switch (ack) {
                case 0: 
                    status = 'error'; 
                    console.log(`❌ [${sessionName}] ACK ERROR: ${message.id.id} -> +${phone}`);
                    break;
                case 1: 
                    status = 'pending'; 
                    console.log(`⏳ [${sessionName}] ACK PENDING: ${message.id.id} -> +${phone}`);
                    break;
                case 2: 
                    status = 'server'; 
                    console.log(`📤 [${sessionName}] ACK SERVER: ${message.id.id} -> +${phone}`);
                    break;
                case 3: 
                    status = 'delivered'; 
                    console.log(`📧 [${sessionName}] ACK DELIVERED: ${message.id.id} -> +${phone} (Estado: ${ack} = delivered)`);
                    break;
                case 4: 
                    status = 'read'; 
                    console.log(`👁️ [${sessionName}] ACK READ: ${message.id.id} -> +${phone} (Estado: ${ack} = read)`);
                    console.log(`🔥 MENSAJE LEÍDO DETECTADO: +${phone} - Enviando webhook read`);
                    break;
                default:
                    console.log(`🤔 [${sessionName}] ACK UNKNOWN: ${message.id.id} -> +${phone} (Estado: ${ack})`);
                    return;
            }
            
            // Solo enviar webhook para estados importantes (entregado y leído)
            if (ack === 3 || ack === 4) {
                console.log(`📡 [${sessionName}] Enviando webhook para ACK ${ack} (${status}) -> +${phone}`);
                
                await sendWebhook({
                    statuses: [{
                        recipient_id: '+' + phone,
                        status: status,
                        timestamp: Math.floor(Date.now() / 1000),
                        messageId: message.id.id,
                        sessionName: sessionName,
                        ack: ack
                    }]
                });
            }
        } catch (error) {
            console.error('❌ Error procesando ACK:', error);
        }
    });
    
    console.log(`✅ Webhook listeners agregados a ${sessionName}`);
}

module.exports = {
    addWebhookListeners,
    sendWebhook,
    WEBHOOK_URL
};