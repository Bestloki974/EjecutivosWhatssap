// src/config.js - Configuración centralizada
const config = {
    // Servidor
    PORT: 3001,
    
    // Base de datos
    DB_CONFIG: {
        host: 'localhost',
        user: 'root',
        password: '',
        database: 'messagehub'
    },
    
    // WhatsApp
    DEFAULT_DELAY: 15, // 15 segundos por defecto entre mensajes
    MAX_CONCURRENT_SESSIONS: 10,
    MAX_NUMBERS_PER_CAMPAIGN: 5000,
    
    // 🚀 MODO DE ENVÍO DE CAMPAÑAS
    CAMPAIGN_MODE: 'PARALLEL', // 'PARALLEL' o 'SEQUENTIAL'
    // PARALLEL: Todos los números envían simultáneamente (más rápido)
    // SEQUENTIAL: Cola global, un mensaje a la vez (más seguro)
    
    // Performance
    HIGH_PERFORMANCE: {
        maxOldSpaceSize: 8192, // 8GB
        uvThreadpoolSize: 128,
        gcInterval: 60000 // 1 minuto
    },
    
    // Puppeteer - Configuración actualizada para WhatsApp Web 2025
    PUPPETEER_ARGS: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-field-trial-config',
        '--disable-ipc-flooding-protection',
        '--disable-extensions',
        '--disable-plugins',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--mute-audio',
        '--no-default-browser-check',
        '--no-pings',
        // 🆕 Argumentos adicionales para 2025
        '--disable-blink-features=AutomationControlled',
        '--disable-features=VizDisplayCompositor,TranslateUI,BlinkGenPropertyTrees',
        '--disable-client-side-phishing-detection',
        '--disable-component-extensions-with-background-pages',
        '--disable-default-background-page',
        '--disable-prompt-on-repost',
        '--disable-hang-monitor',
        '--disable-features=Translate',
        '--disable-background-networking',
        '--disable-component-update',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    ],
    
    // 🆕 Configuración específica de WhatsApp Web
    WHATSAPP_CONFIG: {
        // Timeouts actualizados para 2025
        timeout: 120000, // 2 minutos
        protocolTimeout: 120000,
        qrMaxRetries: 10, // Más reintentos
        restartOnAuthFail: true,
        takeoverOnConflict: false,
        takeoverTimeoutMs: 0,
        // Cacheo de versión web actualizado
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1017804874.html'
        }
    },
    
    // Logging
    LOGGING: {
        level: 'INFO', // DEBUG, INFO, WARN, ERROR
        showTimestamp: true,
        showSessionId: true,
        maxLogLength: 100 // Caracteres máximos por log
    }
};

module.exports = config;
