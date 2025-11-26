// src/utils.js - Funciones de utilidad
const logger = require('./logger');

class Utils {
    
    // Obtener fecha actual en formato YYYY-MM-DD
    getCurrentDate() {
        return new Date().toISOString().split('T')[0];
    }
    
    // Formatear teléfono para WhatsApp
    formatPhoneNumber(phone) {
        let cleanPhone = phone.replace(/[^0-9+]/g, '');
        if (!cleanPhone.startsWith('+')) {
            if (cleanPhone.startsWith('56')) {
                cleanPhone = '+' + cleanPhone;
            } else {
                cleanPhone = '+56' + cleanPhone;
            }
        }
        return cleanPhone;
    }
    
    // Dividir array en chunks
    chunkArray(array, chunkSize) {
        const chunks = [];
        for (let i = 0; i < array.length; i += chunkSize) {
            chunks.push(array.slice(i, i + chunkSize));
        }
        return chunks;
    }
    
    // Delay con Promise
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    // Formatear tiempo transcurrido
    formatElapsedTime(startTime) {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        if (elapsed < 60) {
            return `${elapsed}s`;
        } else if (elapsed < 3600) {
            return `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
        } else {
            const hours = Math.floor(elapsed / 3600);
            const minutes = Math.floor((elapsed % 3600) / 60);
            return `${hours}h ${minutes}m`;
        }
    }
    
    // Truncar texto
    truncateText(text, maxLength = 50) {
        if (typeof text !== 'string') return text;
        return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
    }
    
    // Validar número de teléfono
    isValidPhoneNumber(phone) {
        const cleanPhone = phone.replace(/[^0-9+]/g, '');
        return /^(\+56)?[0-9]{8,9}$/.test(cleanPhone);
    }
    
    // Calcular porcentaje
    calculatePercentage(current, total) {
        if (total === 0) return 0;
        return Math.round((current / total) * 100);
    }
    
    // Generar ID único
    generateId() {
        return Math.random().toString(36).substring(2) + Date.now().toString(36);
    }
    
    // Validar configuración de campaña
    validateCampaignConfig(config) {
        const errors = [];
        
        if (!config.campaign_id) {
            errors.push('campaign_id es requerido');
        }
        
        if (!config.contacts || !Array.isArray(config.contacts) || config.contacts.length === 0) {
            errors.push('contacts debe ser un array con al menos un elemento');
        }
        
        if (config.delay_seconds && (config.delay_seconds < 1 || config.delay_seconds > 300)) {
            errors.push('delay_seconds debe estar entre 1 y 300 segundos');
        }
        
        return {
            isValid: errors.length === 0,
            errors: errors
        };
    }
    
    // Limpiar nombre de archivo
    sanitizeFileName(fileName) {
        return fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    }
    
    // Formatear número con separadores de miles
    formatNumber(number) {
        return new Intl.NumberFormat('es-CL').format(number);
    }
    
    // Formatear moneda chilena
    formatCurrency(amount) {
        return new Intl.NumberFormat('es-CL', {
            style: 'currency',
            currency: 'CLP',
            minimumFractionDigits: 0
        }).format(amount);
    }
    
    // Detectar tipo de archivo por extensión
    getFileType(fileName) {
        const extension = fileName.split('.').pop().toLowerCase();
        const imageTypes = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
        const documentTypes = ['pdf', 'doc', 'docx', 'xls', 'xlsx'];
        const videoTypes = ['mp4', 'avi', 'mov', 'wmv'];
        
        if (imageTypes.includes(extension)) return 'image';
        if (documentTypes.includes(extension)) return 'document';
        if (videoTypes.includes(extension)) return 'video';
        return 'unknown';
    }
    
    // Validar URL
    isValidUrl(string) {
        try {
            new URL(string);
            return true;
        } catch (_) {
            return false;
        }
    }
    
    // Obtener estadísticas de array
    getArrayStats(array) {
        return {
            total: array.length,
            min: Math.min(...array),
            max: Math.max(...array),
            avg: array.reduce((a, b) => a + b, 0) / array.length,
            sum: array.reduce((a, b) => a + b, 0)
        };
    }
    
    // Retry con backoff exponencial
    async retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await fn();
            } catch (error) {
                if (attempt === maxRetries) {
                    throw error;
                }
                
                const delayMs = baseDelay * Math.pow(2, attempt - 1);
                logger.warn(`Intento ${attempt} falló, reintentando en ${delayMs}ms: ${error.message}`);
                await this.delay(delayMs);
            }
        }
    }
    
    // Limpieza de memoria
    forceGarbageCollection() {
        if (global.gc) {
            global.gc();
            logger.debug('Garbage collection ejecutado manualmente');
        }
    }
    
    // Obtener uso de memoria
    getMemoryUsage() {
        const usage = process.memoryUsage();
        return {
            rss: Math.round(usage.rss / 1024 / 1024) + ' MB',
            heapTotal: Math.round(usage.heapTotal / 1024 / 1024) + ' MB',
            heapUsed: Math.round(usage.heapUsed / 1024 / 1024) + ' MB',
            external: Math.round(usage.external / 1024 / 1024) + ' MB'
        };
    }
}

module.exports = new Utils();

