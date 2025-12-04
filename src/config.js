// src/config.js
module.exports = {
    // Configuración del Servidor
    PORT: process.env.PORT || 3001,
    JWT_SECRET: 'tu_secreto_super_seguro_cambialo_aqui', // 🔐 CLAVE PARA GENERAR TOKENS
    
    // Base de Datos
    DB_CONFIG: {
        host: 'localhost',
        user: 'root',
        password: '',
        database: 'whatsapp_crm',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    },

    // Configuración de WhatsApp Web
    WHATSAPP: {
        authTimeoutMs: 60000,
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
    }
};