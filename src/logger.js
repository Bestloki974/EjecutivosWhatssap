// src/logger.js - Sistema de logging controlado
const config = require('./config');

class Logger {
    constructor() {
        this.level = config.LOGGING.level;
        this.showTimestamp = config.LOGGING.showTimestamp;
        this.showSessionId = config.LOGGING.showSessionId;
        this.maxLength = config.LOGGING.maxLogLength;
        
        this.levels = {
            'ERROR': 0,
            'WARN': 1,
            'INFO': 2,
            'DEBUG': 3
        };
    }
    
    shouldLog(level) {
        return this.levels[level] <= this.levels[this.level];
    }
    
    formatMessage(level, message, sessionId = null) {
        let formatted = '';
        
        if (this.showTimestamp) {
            const now = new Date().toISOString().slice(11, 19); // HH:MM:SS
            formatted += `[${now}] `;
        }
        
        if (sessionId && this.showSessionId) {
            formatted += `[${sessionId}] `;
        }
        
        // Truncar mensaje si es muy largo
        if (typeof message === 'string' && message.length > this.maxLength) {
            message = message.substring(0, this.maxLength) + '...';
        }
        
        formatted += message;
        return formatted;
    }
    
    error(message, sessionId = null) {
        if (this.shouldLog('ERROR')) {
            console.error('❌', this.formatMessage('ERROR', message, sessionId));
        }
    }
    
    warn(message, sessionId = null) {
        if (this.shouldLog('WARN')) {
            console.warn('⚠️', this.formatMessage('WARN', message, sessionId));
        }
    }
    
    info(message, sessionId = null) {
        if (this.shouldLog('INFO')) {
            console.log('ℹ️', this.formatMessage('INFO', message, sessionId));
        }
    }
    
    debug(message, sessionId = null) {
        if (this.shouldLog('DEBUG')) {
            console.log('🔍', this.formatMessage('DEBUG', message, sessionId));
        }
    }
    
    // Métodos específicos para eventos importantes (siempre se muestran)
    campaign(message, campaignId = null) {
        const prefix = campaignId ? `[CAMPAÑA ${campaignId}]` : '[CAMPAÑA]';
        console.log('🚀', this.formatMessage('INFO', `${prefix} ${message}`));
    }
    
    session(message, sessionId) {
        console.log('📱', this.formatMessage('INFO', message, sessionId));
    }
    
    success(message, sessionId = null) {
        console.log('✅', this.formatMessage('INFO', message, sessionId));
    }
    
    progress(current, total, sessionId = null) {
        if (current % 10 === 0 || current === total) { // Solo cada 10 o al final
            const percentage = Math.round((current / total) * 100);
            const message = `Progreso: ${current}/${total} (${percentage}%)`;
            this.info(message, sessionId);
        }
    }
    
    // Para cambiar el nivel de logging dinámicamente
    setLevel(level) {
        if (this.levels.hasOwnProperty(level)) {
            this.level = level;
            this.info(`Nivel de logging cambiado a: ${level}`);
        }
    }
}

module.exports = new Logger();

