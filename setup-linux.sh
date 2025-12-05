#!/bin/bash

# ==================================================
# 🚀 SCRIPT DE CONFIGURACIÓN PARA LINUX
# Sistema: WhatsApp CRM Server
# Autor: Generado para DigitalOcean/Linux
# ==================================================

echo "===================================================="
echo "🔧 INSTALADOR DE DEPENDENCIAS - WhatsApp CRM"
echo "===================================================="

# Detectar distribución
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$NAME
    VERSION=$VERSION_ID
    echo "📋 Sistema detectado: $OS $VERSION"
else
    echo "⚠️ No se pudo detectar la distribución de Linux"
    OS="Unknown"
fi

echo ""
echo "📦 Instalando dependencias del sistema para Puppeteer/Chrome..."
echo ""

# Actualizar repositorios
sudo apt-get update -y

# Instalar dependencias necesarias para Chromium/Puppeteer en Linux
sudo apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    xdg-utils \
    libxshmfence1 \
    libglu1-mesa \
    libdrm2 \
    libxkbcommon0

echo ""
echo "🌐 Instalando Google Chrome (versión estable)..."
echo ""

# Instalar Google Chrome
if ! command -v google-chrome &> /dev/null; then
    wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
    sudo sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google-chrome.list'
    sudo apt-get update -y
    sudo apt-get install -y google-chrome-stable
else
    echo "✅ Google Chrome ya está instalado"
fi

# Verificar instalación de Chrome
CHROME_PATH=""
if command -v google-chrome-stable &> /dev/null; then
    CHROME_PATH=$(which google-chrome-stable)
elif command -v google-chrome &> /dev/null; then
    CHROME_PATH=$(which google-chrome)
elif command -v chromium-browser &> /dev/null; then
    CHROME_PATH=$(which chromium-browser)
elif command -v chromium &> /dev/null; then
    CHROME_PATH=$(which chromium)
fi

echo ""
if [ -n "$CHROME_PATH" ]; then
    echo "✅ Chrome/Chromium encontrado en: $CHROME_PATH"
    CHROME_VERSION=$($CHROME_PATH --version)
    echo "📋 Versión: $CHROME_VERSION"
else
    echo "⚠️ No se encontró Chrome. Intentando instalar Chromium..."
    sudo apt-get install -y chromium-browser || sudo apt-get install -y chromium
fi

echo ""
echo "📦 Instalando dependencias de Node.js..."
echo ""

# Verificar si existe node_modules, si no, instalar
if [ ! -d "node_modules" ]; then
    npm install
else
    echo "✅ node_modules ya existe"
fi

# Descargar Chromium para Puppeteer
echo ""
echo "🔄 Descargando Chromium para Puppeteer..."
npx puppeteer browsers install chrome

echo ""
echo "===================================================="
echo "✅ INSTALACIÓN COMPLETADA"
echo "===================================================="
echo ""
echo "📝 NOTAS IMPORTANTES:"
echo "   1. Si estás en un servidor sin GUI, asegúrate de usar headless: true"
echo "   2. El sistema está configurado para detectar Linux automáticamente"
echo "   3. Para iniciar el servidor: npm start"
echo ""
echo "🔍 Chrome/Chromium encontrado en: $CHROME_PATH"
echo ""


