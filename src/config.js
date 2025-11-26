// src/config-latest.js - Configuración para whatsapp-web.js VERSIÓN MÁS RECIENTE 2025
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
    
    // WhatsApp - Configuración optimizada para versión más reciente
    DEFAULT_DELAY: 15, // 15 segundos entre mensajes
    MAX_CONCURRENT_SESSIONS: 10, // 🔥 AUMENTADO PARA MANEJAR 9+ SESIONES
    MAX_NUMBERS_PER_CAMPAIGN: 2000,
    
    // Modo PARALLEL para mejor rendimiento
    CAMPAIGN_MODE: 'PARALLEL',
    
    // Performance optimizada
    HIGH_PERFORMANCE: {
        maxOldSpaceSize: 6144, // 6GB
        uvThreadpoolSize: 64,
        gcInterval: 45000 // 45 segundos
    },
    
    // Puppeteer - Configuración OPTIMIZADA para 2025
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
        // 🆕 Argumentos específicos para 2025
        '--disable-blink-features=AutomationControlled',
        '--disable-features=VizDisplayCompositor,TranslateUI,BlinkGenPropertyTrees',
        '--disable-client-side-phishing-detection',
        '--disable-component-extensions-with-background-pages',
        '--disable-hang-monitor',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-domain-reliability',
        '--disable-features=AudioServiceOutOfProcess',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    ],
    
    // 🆕 Configuración específica de WhatsApp Web para versión más reciente
    WHATSAPP_CONFIG: {
        // Timeouts optimizados para versión reciente
        timeout: 90000, // 90 segundos
        protocolTimeout: 90000,
        qrMaxRetries: 8,
        restartOnAuthFail: true,
        takeoverOnConflict: false,
        takeoverTimeoutMs: 0,
        
        // WebVersionCache más reciente y actualizado
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1017804874-beta.html',
            strict: false
        },
        
        // 🆕 Configuraciones adicionales para versión más reciente
        authTimeoutMs: 120000, // 2 minutos para autenticación
        blockCrashLogs: true,
        ffmpegPath: undefined,
        bypassCSP: true,
        
        // 🆕 Configuración de Puppeteer específica para latest
        puppeteer: {
            headless: true,
            devtools: false,
            defaultViewport: {
                width: 1366,
                height: 768
            },
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-web-security'
            ],
            timeout: 90000,
            protocolTimeout: 90000
        }
    },
    
    // Logging optimizado
    LOGGING: {
        level: 'INFO', // INFO para balance entre información y rendimiento
        showTimestamp: true,
        showSessionId: true,
        maxLogLength: 150
    }
};

module.exports = config;
