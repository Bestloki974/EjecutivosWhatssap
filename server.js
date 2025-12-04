// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const config = require('./src/config');
const routes = require('./src/routes');
const sessionManager = require('./src/sessionManager');

const app = express();
const server = http.createServer(app);

// Configurar Socket.IO
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Hacer io accesible globalmente para el sessionManager
global.io = io;

// Middleware básicos
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rutas API
app.use('/api', routes);

// Servir archivos estáticos (Frontend)
app.use(express.static('public'));

// Ruta principal devuelve el index.html
app.get('*', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Socket.IO eventos
io.on('connection', (socket) => {
    console.log('🔌 Cliente conectado:', socket.id);
    
    // El cliente puede unirse a una "sala" de su empresa
    socket.on('join_company', (companyId) => {
        socket.join(`company_${companyId}`);
        console.log(`📢 Socket ${socket.id} unido a company_${companyId}`);
    });

    // Unirse a un chat específico
    socket.on('join_chat', (chatId) => {
        socket.join(`chat_${chatId}`);
    });

    socket.on('disconnect', () => {
        console.log('🔌 Cliente desconectado:', socket.id);
    });
});

// Manejo de errores global
process.on('uncaughtException', (err) => {
    console.error('🔥 Excepción no capturada:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 Promesa rechazada no manejada:', reason);
});

// Iniciar Servidor
server.listen(config.PORT, async () => {
    console.log(`\n==================================================`);
    console.log(`🚀 SERVIDOR CRM INICIADO EN EL PUERTO: ${config.PORT}`);
    console.log(`🔗 URL: http://localhost:${config.PORT}`);
    console.log(`🔌 WebSocket habilitado para tiempo real`);
    console.log(`==================================================\n`);

    // Recuperar sesiones guardadas
    await sessionManager.initializeSavedSessions();
});
