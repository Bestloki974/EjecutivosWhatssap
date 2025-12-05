// src/config.js
const os = require('os');
const fs = require('fs');

// =====================================================
// 🔧 DETECCIÓN AUTOMÁTICA DE CHROME PARA LINUX
// =====================================================
function detectChromePath() {
    const isLinux = os.platform() === 'linux';
    const isWindows = os.platform() === 'win32';
    
    if (!isLinux) {
        // En Windows, Puppeteer usa su Chromium bundled
        return undefined;
    }
    
    // Rutas comunes de Chrome/Chromium en Linux
    const possiblePaths = [
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/snap/bin/chromium',
        '/usr/lib/chromium/chromium',
        // Puppeteer cache paths
        process.env.HOME + '/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome',
    ];
    
    for (const chromePath of possiblePaths) {
        // Manejar wildcards para el cache de puppeteer
        if (chromePath.includes('*')) {
            const baseDir = chromePath.split('*')[0];
            if (fs.existsSync(baseDir)) {
                const dirs = fs.readdirSync(baseDir.slice(0, -1));
                for (const dir of dirs) {
                    const fullPath = chromePath.replace('linux-*', dir);
                    if (fs.existsSync(fullPath)) {
                        console.log(`🌐 Chrome detectado en: ${fullPath}`);
                        return fullPath;
                    }
                }
            }
        } else if (fs.existsSync(chromePath)) {
            console.log(`🌐 Chrome detectado en: ${chromePath}`);
            return chromePath;
        }
    }
    
    console.log('⚠️ No se encontró Chrome instalado. Usando Puppeteer bundled.');
    return undefined;
}

// Detectar sistema operativo y Chrome
const isLinux = os.platform() === 'linux';
const chromePath = detectChromePath();

// Configuración de Puppeteer según el sistema operativo
const puppeteerConfig = {
    headless: true,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--single-process',
        '--disable-extensions'
    ]
};

// Si estamos en Linux y encontramos Chrome, usar ese path
if (isLinux && chromePath) {
    puppeteerConfig.executablePath = chromePath;
}

module.exports = {
    // Configuración del Servidor
    PORT: process.env.PORT || 3001,
    JWT_SECRET: 'tu_secreto_super_seguro_cambialo_aqui', // 🔐 CLAVE PARA GENERAR TOKENS
    
    // Zona horaria de Chile
    TIMEZONE: 'America/Santiago',
    
    // Base de Datos
    DB_CONFIG: {
        host: 'localhost',
        user: 'admin',
        password: '0974',
        database: 'whatsapp_crm',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    },

    // Configuración de WhatsApp Web
    WHATSAPP: {
        authTimeoutMs: 60000,
        puppeteer: puppeteerConfig
    },
    
    // Info del sistema (para debug)
    SYSTEM: {
        platform: os.platform(),
        isLinux,
        chromePath
    }
};