const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const http = require('http');
const url = require('url');
const qrcode = require('qrcode');

const logger = pino({ level: 'silent' });
const AUTH_FOLDER = './auth_info';
const TELEGRAM_SESSION_FILE = './telegram_session.txt';
const CONFIG_FILE = './config.js';
const DASHBOARD_PASSWORD = ""; // No password required

let isWhatsAppConnected = false;
let isTelegramConnected = false;
let telegramClient = null;
let sock = null;
let groupsList = [];
let selectedTarget = null;
let selectedTarget2 = null;
let whatsappQR = null;
let forwardedCount = 0;
let lastForwardedMessage = null;

let telegramLoginState = {
    step: 'idle',
    phone: null,
    phoneCodeHash: null,
};

let isConnectingWhatsApp = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
const MAX_RECONNECT_ATTEMPTS = 3;

function loadConfig() {
    delete require.cache[require.resolve(CONFIG_FILE)];
    return require(CONFIG_FILE);
}

function saveConfig(updates = {}) {
    const config = loadConfig();
    const newConfig = { ...config, ...updates };
    
    const keywordsStr = newConfig.FILTER_KEYWORDS.map(k => `        '${k}'`).join(',\n');
    const sensitiveWordsStr = (newConfig.SENSITIVE_WORDS || []).map(w => `        '${w}'`).join(',\n');
    
    const content = `// ===== CONFIGURATION =====
module.exports = {
    TELEGRAM_API_ID: ${newConfig.TELEGRAM_API_ID || 0},
    TELEGRAM_API_HASH: '${newConfig.TELEGRAM_API_HASH || 'YOUR_API_HASH_HERE'}',
    TELEGRAM_CHANNEL: '${newConfig.TELEGRAM_CHANNEL || 'YOUR_CHANNEL_HERE'}',
    WHATSAPP_TARGET_ID: '${newConfig.WHATSAPP_TARGET_ID || 'YOUR_WHATSAPP_GROUP_ID_HERE'}',
    WHATSAPP_TARGET_ID_2: '${newConfig.WHATSAPP_TARGET_ID_2 || ''}',
    TARGET_2_ENABLED: ${newConfig.TARGET_2_ENABLED !== undefined ? newConfig.TARGET_2_ENABLED : false},
    FILTER_KEYWORDS: [
${keywordsStr}
    ],
    SENSITIVE_WORDS: [
${sensitiveWordsStr}
    ],
    ADMIN_NUMBERS: ${JSON.stringify(newConfig.ADMIN_NUMBERS || [])},
};
`;
    fs.writeFileSync(CONFIG_FILE, content);
}

function loadTelegramSession() {
    try {
        if (fs.existsSync(TELEGRAM_SESSION_FILE)) {
            return fs.readFileSync(TELEGRAM_SESSION_FILE, 'utf8');
        }
    } catch (err) {
        console.error('Error loading Telegram session:', err.message);
    }
    return '';
}

function saveTelegramSession(session) {
    fs.writeFileSync(TELEGRAM_SESSION_FILE, session);
}

function containsKeyword(text, keywords) {
    if (!text || !keywords || keywords.length === 0) return false;
    const lowerText = text.toLowerCase();
    return keywords.some(keyword => lowerText.includes(keyword.toLowerCase()));
}

function removeSensitiveWords(text, sensitiveWords) {
    if (!text || !sensitiveWords || sensitiveWords.length === 0) return text;
    
    let cleanedText = text;
    // Sort by length (longest first) to avoid partial matches
    const sortedWords = [...sensitiveWords].sort((a, b) => b.length - a.length);
    sortedWords.forEach(word => {
        if (!word || !word.trim()) return;
        // Case insensitive replacement - remove the word completely
        const regex = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        cleanedText = cleanedText.replace(regex, '');
    });
    
    // Clean up extra spaces left after removal
    cleanedText = cleanedText.replace(/\s+/g, ' ').trim();
    
    return cleanedText;
}

function extractSignalInfo(text) {
    const lines = text.split('\n').filter(line => line.trim());
    const signal = {
        original: text,
        type: null,
        entry: null,
        sl: null,
        tp1: null,
        tp2: null,
        tp3: null
    };
    
    if (/gold\s+sell|xauusd\s+sell|sell\s+now/i.test(text)) {
        signal.type = 'SELL SIGNAL';
    } else if (/gold\s+buy|xauusd\s+buy|buy\s+now/i.test(text)) {
        signal.type = 'BUY SIGNAL';
    }
    
    lines.forEach(line => {
        const lowerLine = line.toLowerCase();
        
        // Extract Entry (price range with @ or dash)
        if (line.includes('@') || /\d+\s*-\s*\d+/.test(line)) {
            if (!signal.entry) {
                const match = line.match(/@?\s*(\d[\d\s.-]*)/);
                if (match) signal.entry = match[1].trim();
            }
        }
        
        // Extract SL / Stoploss - handle formats: "Stoploss: 4215", "SL: 4215", "SL 4215"
        if (lowerLine.includes('sl') || lowerLine.includes('stoploss') || lowerLine.includes('stop loss')) {
            const match = line.match(/(?:sl|stoploss|stop\s*loss)\s*:?\s*(\d[\d.]*)/i);
            if (match) signal.sl = match[1];
        }
        
        // Extract TP / Take profits - handle formats:
        // "Take profits: 4200 / 4198 / 4196"
        // "TP1: 4200", "TP: 4200", "TP 4200"
        if (lowerLine.includes('tp') || lowerLine.includes('take profit') || lowerLine.includes('take profits')) {
            // Try "Take profits: 4200 / 4198 / 4196" format
            const tpListMatch = line.match(/(?:take\s*profits?|tp)\s*:?\s*(\d[\d.\s\/]*)/i);
            if (tpListMatch) {
                const tpValues = tpListMatch[1].split(/\s*[\/\,]\s*/).filter(v => v.trim());
                if (tpValues.length >= 1) signal.tp1 = tpValues[0].trim();
                if (tpValues.length >= 2) signal.tp2 = tpValues[1].trim();
                if (tpValues.length >= 3) signal.tp3 = tpValues[2].trim();
            }
            
            // Also try individual TP format: "TP1: 4200"
            const tpSingleMatch = line.match(/tp\s*(\d?)\s*:?\s*(\d[\d.]*)/i);
            if (tpSingleMatch) {
                const tpNum = tpSingleMatch[1] || '1';
                const tpPrice = tpSingleMatch[2];
                if ((tpNum === '1' || tpNum === '') && !signal.tp1) signal.tp1 = tpPrice;
                else if (tpNum === '2' && !signal.tp2) signal.tp2 = tpPrice;
                else if (tpNum === '3' && !signal.tp3) signal.tp3 = tpPrice;
            }
        }
    });
    
    return signal;
}

function formatSignalMessage(signal, originalText) {
    let formatted = '';
    
    // Add signal type header if detected
    if (signal.type) {
        formatted += `[${signal.type}]\n`;
        formatted += `================\n\n`;
    }
    
    // Add the original message text (with sensitive words already removed)
    formatted += originalText;
    
    return formatted;
}

async function initTelegram() {
    const config = loadConfig();
    const apiId = config.TELEGRAM_API_ID;
    const apiHash = config.TELEGRAM_API_HASH;
    
    if (!apiId || apiId === 0 || !apiHash || apiHash === 'YOUR_API_HASH_HERE') {
        console.log('Please set Telegram API_ID and API_HASH via web setup');
        return;
    }
    
    const sessionString = loadTelegramSession();
    const stringSession = new StringSession(sessionString);
    
    telegramClient = new TelegramClient(stringSession, parseInt(apiId), apiHash, {
        connectionRetries: 5,
    });
    
    console.log('Connecting to Telegram...');
    
    try {
        await telegramClient.connect();
        
        if (await telegramClient.isUserAuthorized()) {
            console.log('Telegram already authorized!');
            isTelegramConnected = true;
            telegramLoginState.step = 'connected';
            saveTelegramSession(telegramClient.session.save());
            startTelegramListener();
        } else {
            console.log('Telegram login required - use web dashboard');
            telegramLoginState.step = 'phone';
        }
    } catch (err) {
        console.error('Telegram connection error:', err.message);
        telegramLoginState.step = 'error';
    }
}

async function telegramSendCode(phone) {
    const config = loadConfig();
    const apiId = config.TELEGRAM_API_ID;
    const apiHash = config.TELEGRAM_API_HASH;
    
    if (!telegramClient) {
        const sessionString = loadTelegramSession();
        const stringSession = new StringSession(sessionString);
        telegramClient = new TelegramClient(stringSession, parseInt(apiId), apiHash, {
            connectionRetries: 5,
        });
        await telegramClient.connect();
    }
    
    try {
        const result = await telegramClient.sendCode({
            apiId: parseInt(apiId),
            apiHash: apiHash
        }, phone);
        
        telegramLoginState.phone = phone;
        telegramLoginState.phoneCodeHash = result.phoneCodeHash;
        telegramLoginState.step = 'code';
        
        return { success: true, message: 'Code sent to your Telegram app' };
    } catch (err) {
        console.error('Error sending code:', err);
        return { success: false, error: err.message };
    }
}

async function telegramSignIn(code) {
    if (!telegramClient || !telegramLoginState.phone || !telegramLoginState.phoneCodeHash) {
        return { success: false, error: 'Not ready. Send phone first.' };
    }
    
    try {
        await telegramClient.invoke(new Api.auth.SignIn({
            phoneNumber: telegramLoginState.phone,
            phoneCodeHash: telegramLoginState.phoneCodeHash,
            phoneCode: code,
        }));
        
        isTelegramConnected = true;
        telegramLoginState.step = 'connected';
        saveTelegramSession(telegramClient.session.save());
        startTelegramListener();
        
        return { success: true, message: 'Telegram login successful!' };
    } catch (err) {
        if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
            telegramLoginState.step = 'password';
            return { success: true, needPassword: true, message: '2FA password required' };
        }
        return { success: false, error: err.message };
    }
}

async function telegramCheckPassword(password) {
    if (!telegramClient) {
        return { success: false, error: 'Not ready' };
    }
    
    try {
        await telegramClient.checkPassword(password);
        
        isTelegramConnected = true;
        telegramLoginState.step = 'connected';
        saveTelegramSession(telegramClient.session.save());
        startTelegramListener();
        
        return { success: true, message: 'Telegram login successful!' };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function startTelegramListener() {
    const config = loadConfig();
    const channel = config.TELEGRAM_CHANNEL;
    
    if (!channel || channel === 'YOUR_CHANNEL_HERE') {
        console.log('Please set TELEGRAM_CHANNEL in web setup');
        return;
    }
    
    console.log('Listening to Telegram channel:', channel);
    
    let channelEntity;
    try {
        channelEntity = await telegramClient.getEntity(channel);
        console.log('Channel found:', channelEntity.title || channelEntity.username);
    } catch (err) {
        console.error('Could not find channel:', err.message);
        return;
    }
    
    telegramClient.addEventHandler(async (update) => {
        if (update.className === 'UpdateNewChannelMessage') {
            const msg = update.message;
            
            if (msg.peerId && msg.peerId.channelId) {
                const msgChannelId = msg.peerId.channelId.toString();
                const targetChannelId = channelEntity.id.toString();
                
                if (msgChannelId !== targetChannelId) return;
            }
            
            const messageText = msg.message || '';
            
            console.log(`Telegram message: ${messageText.substring(0, 50)}...`);
            
            // Reload config to get latest keywords
            const currentConfig = loadConfig();
            
            if (!containsKeyword(messageText, currentConfig.FILTER_KEYWORDS)) {
                console.log('No keywords matched, skipping');
                return;
            }
            
            console.log('Keywords matched! Forwarding...');
            
            // Remove sensitive words from message
            const filteredText = removeSensitiveWords(messageText, currentConfig.SENSITIVE_WORDS || []);
            
            // Check if message contains signal info (Entry, SL, TP)
            const signal = extractSignalInfo(filteredText);
            let finalText;
            
            // Only format as signal if it has BOTH entry AND sl (proper signal format)
            if (signal.entry && signal.sl) {
                // Message has signal info - add header but keep original text
                finalText = formatSignalMessage(signal, filteredText);
                console.log('Signal detected - adding header to original text');
            } else {
                // No signal info - forward original text
                finalText = filteredText;
                console.log('No signal info - forwarding original text');
            }
            
            if (sock && isWhatsAppConnected && selectedTarget) {
                try {
                    // Send to primary target
                    await sock.sendMessage(selectedTarget, { text: finalText });
                    
                    // Send to secondary target if enabled
                    const currentConfig = loadConfig();
                    if (currentConfig.TARGET_2_ENABLED && selectedTarget2) {
                        await sock.sendMessage(selectedTarget2, { text: finalText });
                        console.log('Forwarded to both WhatsApp groups!');
                    } else {
                        console.log('Forwarded to WhatsApp!');
                    }
                    
                    forwardedCount++;
                    lastForwardedMessage = {
                        text: messageText.substring(0, 100),
                        time: new Date().toISOString()
                    };
                } catch (err) {
                    console.error('Forward error:', err.message);
                }
            } else {
                console.log('WhatsApp not connected, message skipped');
            }
        }
    });
    
    console.log('Telegram listener started');
}

async function connectToWhatsApp() {
    // Prevent overlapping connections
    if (isConnectingWhatsApp) {
        console.log('WhatsApp connection already in progress, skipping...');
        return;
    }
    isConnectingWhatsApp = true;
    
    // Clear any pending reconnect timer
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const config = loadConfig();
    selectedTarget = config.WHATSAPP_TARGET_ID;
    selectedTarget2 = config.WHATSAPP_TARGET_ID_2;
    
    console.log('Starting WhatsApp connection...');
    
    sock = makeWASocket({
        logger,
        printQRInTerminal: false,
        auth: state,
        browser: ['Chrome (Linux)', '', ''],
        markOnlineOnConnect: true,
        syncFullHistory: false,
    });
    
    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('WhatsApp QR generated');
            reconnectAttempts = 0; // Reset attempts when QR is generated
            try {
                whatsappQR = await qrcode.toDataURL(qr, { width: 400, margin: 2 });
            } catch (err) {
                console.error('QR Error:', err.message);
            }
        }
        
        if (connection === 'open') {
            console.log('WhatsApp Connected!');
            isWhatsAppConnected = true;
            reconnectAttempts = 0;
            whatsappQR = null;
            
            try {
                const groups = await sock.groupFetchAllParticipating();
                groupsList = Object.entries(groups).map(([id, group]) => ({
                    id,
                    name: group.subject,
                    participants: group.participants.length
                }));
                console.log('Found', groupsList.length, 'WhatsApp groups');
            } catch (err) {
                console.error('Error fetching groups:', err.message);
            }
        }
        
        if (connection === 'close') {
            isWhatsAppConnected = false;
            isConnectingWhatsApp = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            
            console.log('WhatsApp disconnected:', statusCode);
            
            // Don't reconnect on logout or if max attempts reached
            if (statusCode === DisconnectReason.loggedOut) {
                console.log('Logged out, not reconnecting');
                reconnectAttempts = 0;
                return;
            }
            
            reconnectAttempts++;
            if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
                console.log('Max reconnect attempts reached. Stopping reconnection.');
                reconnectAttempts = 0;
                return;
            }
            
            console.log(`Reconnecting in 5 seconds... (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
            reconnectTimer = setTimeout(connectToWhatsApp, 5000);
        }
    });
}

function getSetupHTML() {
    return `<!DOCTYPE html>
<html><head><title>Setup - Gold Signal Forwarder</title>
<meta charset="UTF-8">
<style>
body{font-family:Arial,sans-serif;background:#1a1a2e;color:#fff;padding:20px;margin:0}
.container{max-width:800px;margin:0 auto}
.box{background:#16213e;padding:25px;border-radius:10px;margin:20px 0}
h1{text-align:center;color:#e94560}h2{color:#ffd700;margin-top:0}
input,textarea{width:100%;padding:12px;margin:8px 0;border:none;border-radius:5px;font-size:16px;box-sizing:border-box}
.btn{background:#28a745;color:#fff;padding:15px;border:none;border-radius:8px;font-size:18px;cursor:pointer;width:100%;margin-top:10px}
.btn:hover{background:#218838}
.btn-blue{background:#0088cc}
.btn-blue:hover{background:#006699}
.btn-green{background:#25d366}
.btn-green:hover{background:#128c7e}
.status{padding:10px;border-radius:5px;margin:10px 0;text-align:center}
.success{background:#28a745}.error{background:#dc3545}.info{background:#007bff}
.help{color:#aaa;font-size:14px;margin:5px 0}
a{color:#00d4ff}
.step{display:flex;align-items:center;margin-bottom:10px}
.step-num{background:#e94560;color:#fff;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin-right:10px;font-weight:bold}
</style></head><body>
<div class="container">
<h1>Gold Signal Forwarder Setup</h1>
<p style="text-align:center;color:#aaa">Complete all steps to start forwarding</p>

<div class="box">
<div class="step"><div class="step-num">1</div><h2>Telegram API Credentials</h2></div>
<p class="help">Get these from <a href="https://my.telegram.org/apps" target="_blank">my.telegram.org/apps</a></p>
<input type="number" id="api-id" placeholder="API ID (numbers only)">
<input type="text" id="api-hash" placeholder="API Hash">
<button class="btn btn-blue" onclick="saveApi()">Save API Credentials</button>
<div id="api-status"></div>
</div>

<div class="box">
<div class="step"><div class="step-num">2</div><h2>Telegram Channel</h2></div>
<p class="help">Enter channel username (e.g., @goldsignals) or ID</p>
<input type="text" id="channel" placeholder="@goldsignals or -1001234567890">
<button class="btn btn-blue" onclick="saveChannel()">Save Channel</button>
<div id="channel-status"></div>
</div>

<div class="box">
<div class="step"><div class="step-num">3</div><h2>Filter Keywords</h2></div>
<p class="help">One keyword per line. Only messages with these words will be forwarded.</p>
<textarea id="keywords" rows="6" placeholder="Gold Sell Now\nGold Buy Now\nXAUUSD Sell Now\nXAUUSD Buy Now"></textarea>
<button class="btn" onclick="saveKeywords()">Save Keywords</button>
<div id="keywords-status"></div>
</div>

<div class="box">
<div class="step"><div class="step-num">4</div><h2>Login to Telegram</h2></div>
<div id="tg-phone-area">
<p class="help">Enter your phone number with country code</p>
<input type="text" id="phone" placeholder="+880123456789">
<button class="btn btn-blue" onclick="sendCode()">Send Code</button>
</div>
<div id="tg-code-area" style="display:none">
<p class="help">Enter the code you received in Telegram</p>
<input type="text" id="code" placeholder="12345">
<button class="btn btn-blue" onclick="verifyCode()">Verify Code</button>
</div>
<div id="tg-pass-area" style="display:none">
<p class="help">Enter your 2FA password</p>
<input type="password" id="tg-password" placeholder="2FA Password">
<button class="btn btn-blue" onclick="verifyPassword()">Login</button>
</div>
<div id="tg-connected" style="display:none">
<div class="status success">Telegram Connected</div>
</div>
<div id="tg-status"></div>
</div>

<div class="box">
<div class="step"><div class="step-num">5</div><h2>Login to WhatsApp</h2></div>
<div id="wa-login-area">
<button class="btn btn-green" onclick="showQR()">Show QR Code</button>
<div id="qr-section" style="display:none;text-align:center;margin-top:15px">
<img id="qr-image" style="max-width:300px;background:#fff;padding:10px;border-radius:10px">
<p class="help">Open WhatsApp &gt; Settings &gt; Linked Devices &gt; Link a Device</p>
</div>
</div>
<div id="wa-connected" style="display:none">
<div class="status success">WhatsApp Connected</div>
</div>
</div>

<div class="box">
<div class="step"><div class="step-num">6</div><h2>Select Target Group</h2></div>
<button class="btn btn-green" onclick="refreshGroups()">Refresh Groups</button>
<div id="groups-list" style="margin-top:15px"></div>
</div>

<div class="box" style="text-align:center">
<a href="/?password=***" style="text-decoration:none"><button class="btn">Go to Dashboard</button></a>
</div>
</div>

<script>
// PASSWORD - DO NOT CHANGE
var PASS = '***';

// Debug function
function debug(msg) {
    console.log('[DEBUG]', msg);
}

// Save form data to localStorage
function saveFormData() {
    var data = {
        apiId: document.getElementById('api-id').value,
        apiHash: document.getElementById('api-hash').value,
        channel: document.getElementById('channel').value,
        keywords: document.getElementById('keywords').value,
        phone: document.getElementById('phone').value
    };
    localStorage.setItem('forwarder_setup', JSON.stringify(data));
    debug('Form data saved');
}

// Load form data from localStorage
function loadFormData() {
    var saved = localStorage.getItem('forwarder_setup');
    if(saved) {
        var data = JSON.parse(saved);
        if(data.apiId) document.getElementById('api-id').value = data.apiId;
        if(data.apiHash) document.getElementById('api-hash').value = data.apiHash;
        if(data.channel) document.getElementById('channel').value = data.channel;
        if(data.keywords) document.getElementById('keywords').value = data.keywords;
        if(data.phone) document.getElementById('phone').value = data.phone;
        debug('Form data loaded');
    }
}

// Auto-save on input change
document.addEventListener('DOMContentLoaded', function() {
    loadFormData();
    var inputs = document.querySelectorAll('input, textarea');
    inputs.forEach(function(input) {
        input.addEventListener('change', saveFormData);
        input.addEventListener('keyup', saveFormData);
    });
});

async function saveApi(){
    debug('saveApi called');
    var id = document.getElementById('api-id').value;
    var hash = document.getElementById('api-hash').value;
    if(!id || !hash){
        alert('Fill all fields');
        return;
    }
    try{
        var url = '/api/config?password=' + PASS + '&api_id=' + id + '&api_hash=' + encodeURIComponent(hash);
        debug('Fetching: ' + url);
        var res = await fetch(url);
        var data = await res.json();
        debug('Response: ' + JSON.stringify(data));
        document.getElementById('api-status').innerHTML = data.success ? 
            '<div class="status success">Saved!</div>' : 
            '<div class="status error">Error: ' + data.error + '</div>';
    }catch(err){
        debug('Error: ' + err);
        alert('Error: ' + err);
    }
}

async function saveChannel(){
    debug('saveChannel called');
    var ch = document.getElementById('channel').value;
    if(!ch){
        alert('Enter channel');
        return;
    }
    try{
        var url = '/api/config?password=' + PASS + '&channel=' + encodeURIComponent(ch);
        debug('Fetching: ' + url);
        var res = await fetch(url);
        var data = await res.json();
        debug('Response: ' + JSON.stringify(data));
        document.getElementById('channel-status').innerHTML = data.success ? 
            '<div class="status success">Saved!</div>' : 
            '<div class="status error">Error: ' + data.error + '</div>';
    }catch(err){
        debug('Error: ' + err);
        alert('Error: ' + err);
    }
}

async function saveKeywords(){
    debug('saveKeywords called');
    var kw = document.getElementById('keywords').value.split('\n').filter(function(k){return k.trim();});
    if(kw.length === 0){
        alert('Enter at least one keyword');
        return;
    }
    try{
        var url = '/api/config?password=' + PASS + '&keywords=' + encodeURIComponent(JSON.stringify(kw));
        debug('Fetching: ' + url);
        var res = await fetch(url);
        var data = await res.json();
        debug('Response: ' + JSON.stringify(data));
        document.getElementById('keywords-status').innerHTML = data.success ? 
            '<div class="status success">Saved ' + kw.length + ' keywords!</div>' : 
            '<div class="status error">Error: ' + data.error + '</div>';
    }catch(err){
        debug('Error: ' + err);
        alert('Error: ' + err);
    }
}

async function sendCode(){
    debug('sendCode called');
    var phone = document.getElementById('phone').value;
    if(!phone){
        alert('Enter phone');
        return;
    }
    try{
        var url = '/api/telegram/login?password=' + PASS + '&phone=' + encodeURIComponent(phone);
        debug('Fetching: ' + url);
        var res = await fetch(url);
        var data = await res.json();
        debug('Response: ' + JSON.stringify(data));
        if(data.success){
            document.getElementById('tg-phone-area').style.display = 'none';
            document.getElementById('tg-code-area').style.display = 'block';
        }
        document.getElementById('tg-status').innerHTML = '<div class="status info">' + data.message + '</div>';
    }catch(err){
        debug('Error: ' + err);
        alert('Error: ' + err);
    }
}

async function verifyCode(){
    debug('verifyCode called');
    var code = document.getElementById('code').value;
    if(!code){
        alert('Enter code');
        return;
    }
    try{
        var url = '/api/telegram/login?password=' + PASS + '&code=' + encodeURIComponent(code);
        debug('Fetching: ' + url);
        var res = await fetch(url);
        var data = await res.json();
        debug('Response: ' + JSON.stringify(data));
        if(data.success){
            if(data.needPassword){
                document.getElementById('tg-code-area').style.display = 'none';
                document.getElementById('tg-pass-area').style.display = 'block';
            }else{
                document.getElementById('tg-code-area').style.display = 'none';
                document.getElementById('tg-connected').style.display = 'block';
            }
        }
        document.getElementById('tg-status').innerHTML = '<div class="status ' + (data.success ? 'success' : 'error') + '">' + data.message + '</div>';
    }catch(err){
        debug('Error: ' + err);
        alert('Error: ' + err);
    }
}

async function verifyPassword(){
    debug('verifyPassword called');
    var pass = document.getElementById('tg-password').value;
    if(!pass){
        alert('Enter password');
        return;
    }
    try{
        var url = '/api/telegram/login?password=' + PASS + '&tg_password=' + encodeURIComponent(pass);
        debug('Fetching: ' + url);
        var res = await fetch(url);
        var data = await res.json();
        debug('Response: ' + JSON.stringify(data));
        if(data.success){
            document.getElementById('tg-pass-area').style.display = 'none';
            document.getElementById('tg-connected').style.display = 'block';
        }
        document.getElementById('tg-status').innerHTML = '<div class="status ' + (data.success ? 'success' : 'error') + '">' + data.message + '</div>';
    }catch(err){
        debug('Error: ' + err);
        alert('Error: ' + err);
    }
}

async function showQR(){
    debug('showQR called');
    document.getElementById('qr-section').style.display = 'block';
    try{
        var url = '/api/whatsapp/qr?password=' + PASS;
        debug('Fetching: ' + url);
        var res = await fetch(url);
        var data = await res.json();
        debug('Response: ' + JSON.stringify(data));
        if(data.qr){
            document.getElementById('qr-image').src = data.qr;
        }else if(data.connected){
            document.getElementById('wa-login-area').style.display = 'none';
            document.getElementById('wa-connected').style.display = 'block';
        }
    }catch(err){
        debug('Error: ' + err);
    }
}

async function refreshGroups(){
    debug('refreshGroups called');
    try{
        var url = '/api/refresh?password=' + PASS;
        debug('Fetching: ' + url);
        var res = await fetch(url);
        var data = await res.json();
        debug('Response: ' + JSON.stringify(data));
        var container = document.getElementById('groups-list');
        container.innerHTML = '';
        if(!data.success){
            container.innerHTML = '<div class="status error">' + data.message + '</div>';
            return;
        }
        var res2 = await fetch('/api/groups?password=' + PASS);
        var data2 = await res2.json();
        debug('Groups Response: ' + JSON.stringify(data2));
        if(!data2.connected){
            container.innerHTML = '<div class="status error">WhatsApp not connected</div>';
            return;
        }
        data2.groups.forEach(function(g){
            var div = document.createElement('div');
            div.style.cssText = 'background:#0f3460;padding:15px;margin:10px 0;border-radius:8px;cursor:pointer';
            div.innerHTML = '<strong>' + g.name + '</strong><br><small style="color:#aaa">' + g.id + '</small>';
            div.onclick = function(){selectGroup(g.id);};
            container.appendChild(div);
        });
    }catch(err){
        debug('Error: ' + err);
        alert('Error: ' + err);
    }
}

async function selectGroup(id){
    debug('selectGroup called: ' + id);
    try{
        var url = '/api/set?password=' + PASS + '&target=' + encodeURIComponent(id);
        debug('Fetching: ' + url);
        var res = await fetch(url);
        var data = await res.json();
        debug('Response: ' + JSON.stringify(data));
        if(data.success){
            alert('Target saved!');
        }
    }catch(err){
        debug('Error: ' + err);
        alert('Error: ' + err);
    }
}

// Check status on load
async function checkStatus(){
    try{
        var res = await fetch('/api/status?password=' + PASS);
        var data = await res.json();
        if(data.telegramConnected){
            document.getElementById('tg-phone-area').style.display = 'none';
            document.getElementById('tg-connected').style.display = 'block';
        }
        if(data.whatsappConnected){
            document.getElementById('wa-login-area').style.display = 'none';
            document.getElementById('wa-connected').style.display = 'block';
        }
    }catch(err){
        debug('checkStatus error: ' + err);
    }
}
checkStatus();
</script></body></html>`;
}

const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const password = parsedUrl.query.password || '';
    const isAuthenticated = password === DASHBOARD_PASSWORD;
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/setup') {
        res.writeHead(302, { 'Location': '/working.html' });
        res.end();
        return;
    }
    
    if (parsedUrl.pathname === '/test.html') {
        res.writeHead(200, { 
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        res.end(fs.readFileSync('./test.html', 'utf8'));
        return;
    }
    
    if (parsedUrl.pathname === '/working.html') {
        res.writeHead(200, { 
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        res.end(fs.readFileSync('./working.html', 'utf8'));
        return;
    }
    
    if (parsedUrl.pathname === '/api/config') {
        res.setHeader('Content-Type', 'application/json');
        if (!isAuthenticated) {
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }
        
        const updates = {};
        if (parsedUrl.query.api_id) updates.TELEGRAM_API_ID = parseInt(parsedUrl.query.api_id);
        if (parsedUrl.query.api_hash) updates.TELEGRAM_API_HASH = parsedUrl.query.api_hash;
        if (parsedUrl.query.channel) updates.TELEGRAM_CHANNEL = parsedUrl.query.channel;
        if (parsedUrl.query.keywords) {
            try {
                updates.FILTER_KEYWORDS = JSON.parse(parsedUrl.query.keywords);
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ success: false, error: 'Invalid keywords' }));
                return;
            }
        }
        if (parsedUrl.query.sensitive_words) {
            try {
                updates.SENSITIVE_WORDS = JSON.parse(parsedUrl.query.sensitive_words);
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ success: false, error: 'Invalid sensitive words' }));
                return;
            }
        }
        if (parsedUrl.query.target) {
            updates.WHATSAPP_TARGET_ID = parsedUrl.query.target;
            selectedTarget = parsedUrl.query.target; // Update running variable immediately
            console.log('Target updated to:', parsedUrl.query.target);
        }
        if (parsedUrl.query.target2) {
            updates.WHATSAPP_TARGET_ID_2 = parsedUrl.query.target2;
            selectedTarget2 = parsedUrl.query.target2;
            console.log('Target 2 updated to:', parsedUrl.query.target2);
        }
        if (parsedUrl.query.target2_enabled !== undefined) {
            updates.TARGET_2_ENABLED = parsedUrl.query.target2_enabled === 'true';
        }
        
        saveConfig(updates);
        const savedConfig = loadConfig();
        res.writeHead(200);
        res.end(JSON.stringify({
            success: true,
            message: 'Configuration saved',
            apiId: savedConfig.TELEGRAM_API_ID,
            apiHash: savedConfig.TELEGRAM_API_HASH,
            channel: savedConfig.TELEGRAM_CHANNEL,
            keywords: savedConfig.FILTER_KEYWORDS,
            sensitiveWords: savedConfig.SENSITIVE_WORDS || []
        }));
        return;
    }
    
    if (parsedUrl.pathname === '/api/status') {
        res.setHeader('Content-Type', 'application/json');
        if (!isAuthenticated) {
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }
        
        const config = loadConfig();
        
        // Find target group name from groups list
        let targetGroupName = null;
        if (selectedTarget && groupsList.length > 0) {
            const foundGroup = groupsList.find(g => g.id === selectedTarget);
            if (foundGroup) {
                targetGroupName = foundGroup.name;
            }
        }
        
        // Find target group 2 name from groups list
        let targetGroup2Name = null;
        if (selectedTarget2 && groupsList.length > 0) {
            const foundGroup2 = groupsList.find(g => g.id === selectedTarget2);
            if (foundGroup2) {
                targetGroup2Name = foundGroup2.name;
            }
        }
        
        res.writeHead(200);
        res.end(JSON.stringify({
            whatsappConnected: isWhatsAppConnected,
            telegramConnected: isTelegramConnected,
            telegramLoginStep: telegramLoginState.step,
            targetGroup: selectedTarget,
            targetGroupName: targetGroupName,
            targetGroup2: selectedTarget2,
            targetGroup2Name: targetGroup2Name,
            target2Enabled: config.TARGET_2_ENABLED,
            telegramChannel: config.TELEGRAM_CHANNEL,
            telegramApiId: config.TELEGRAM_API_ID,
            forwardedCount: forwardedCount,
            lastForwarded: lastForwardedMessage,
            keywords: config.FILTER_KEYWORDS,
            sensitiveWords: config.SENSITIVE_WORDS || []
        }));
        return;
    }
    
    if (parsedUrl.pathname === '/api/whatsapp/qr') {
        res.setHeader('Content-Type', 'application/json');
        if (!isAuthenticated) {
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({
            connected: isWhatsAppConnected,
            qr: whatsappQR
        }));
        return;
    }
    
    if (parsedUrl.pathname === '/api/whatsapp/clear-auth') {
        res.setHeader('Content-Type', 'application/json');
        if (!isAuthenticated) {
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }

        try {
            // Clear any pending reconnect timer first
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }

            // Close existing socket first before deleting auth files
            if (sock) {
                try {
                    sock.ev.removeAllListeners();
                    if (sock.ws) sock.ws.close();
                    sock = null;
                } catch (err) {
                    console.error('Error closing socket:', err.message);
                }
            }

            // Delete auth_info folder contents
            if (fs.existsSync(AUTH_FOLDER)) {
                const files = fs.readdirSync(AUTH_FOLDER);
                for (const file of files) {
                    const filePath = AUTH_FOLDER + '/' + file;
                    try {
                        const stat = fs.statSync(filePath);
                        if (stat.isDirectory()) {
                            fs.rmSync(filePath, { recursive: true, force: true });
                        } else {
                            fs.unlinkSync(filePath);
                        }
                    } catch (err) {
                        console.error('Error deleting file:', file, err.message);
                    }
                }
            }

            // Reset WhatsApp connection state
            isWhatsAppConnected = false;
            isConnectingWhatsApp = false;
            reconnectAttempts = 0;
            whatsappQR = null;
            groupsList = [];
            selectedTarget = null;
            selectedTarget2 = null;

            console.log('WhatsApp auth cleared by user request');

            // Start fresh connection to generate new QR code
            setTimeout(() => {
                console.log('Starting fresh WhatsApp connection after auth clear...');
                connectToWhatsApp();
            }, 1500);

            res.writeHead(200);
            res.end(JSON.stringify({
                success: true,
                message: 'WhatsApp auth cleared. A new QR code will appear shortly. Click "Show QR Code" to scan.'
            }));
        } catch (err) {
            console.error('Error clearing WhatsApp auth:', err.message);
            res.writeHead(500);
            res.end(JSON.stringify({ success: false, error: err.message }));
        }
        return;
    }
    
    if (parsedUrl.pathname === '/api/telegram/login') {
        res.setHeader('Content-Type', 'application/json');
        if (!isAuthenticated) {
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }
        
        const phone = parsedUrl.query.phone;
        const code = parsedUrl.query.code;
        const tgPassword = parsedUrl.query.tg_password;
        
        // If no parameters, return connection status
        if (!phone && !code && !tgPassword) {
            res.writeHead(200);
            res.end(JSON.stringify({
                connected: isTelegramConnected,
                step: telegramLoginState.step
            }));
            return;
        }
        
        if (phone) {
            const result = await telegramSendCode(phone);
            res.writeHead(200);
            res.end(JSON.stringify(result));
            return;
        }
        
        if (code) {
            const result = await telegramSignIn(code);
            res.writeHead(200);
            res.end(JSON.stringify(result));
            return;
        }
        
        if (tgPassword) {
            const result = await telegramCheckPassword(tgPassword);
            res.writeHead(200);
            res.end(JSON.stringify(result));
            return;
        }
        
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, message: 'Invalid parameters' }));
        return;
    }
    
    if (parsedUrl.pathname === '/api/groups' || parsedUrl.pathname === '/api/whatsapp/groups') {
        res.setHeader('Content-Type', 'application/json');
        if (!isAuthenticated) {
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({
            connected: isWhatsAppConnected,
            groups: groupsList,
            currentTarget: selectedTarget
        }));
        return;
    }
    
    if (parsedUrl.pathname === '/api/set') {
        res.setHeader('Content-Type', 'application/json');
        if (!isAuthenticated) {
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }
        const target = parsedUrl.query.target;
        const target2 = parsedUrl.query.target2;
        
        if (target) {
            saveConfig({ WHATSAPP_TARGET_ID: target });
            selectedTarget = target;
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, message: 'Target saved!' }));
            return;
        }
        
        if (target2) {
            saveConfig({ WHATSAPP_TARGET_ID_2: target2 });
            selectedTarget2 = target2;
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, message: 'Target 2 saved!' }));
            return;
        }
        
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, message: 'Missing target' }));
        return;
    }
    
    if (parsedUrl.pathname === '/api/refresh') {
        res.setHeader('Content-Type', 'application/json');
        if (!isAuthenticated) {
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }
        
        try {
            if (sock && isWhatsAppConnected) {
                const groups = await sock.groupFetchAllParticipating();
                groupsList = Object.entries(groups).map(([id, group]) => ({
                    id,
                    name: group.subject,
                    participants: group.participants.length
                }));
                res.writeHead(200);
                res.end(JSON.stringify({ success: true, count: groupsList.length }));
            } else {
                res.writeHead(200);
                res.end(JSON.stringify({ success: false, message: 'Not connected' }));
            }
        } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ success: false, message: err.message }));
        }
        return;
    }
    
    if (parsedUrl.pathname === '/') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        if (!isAuthenticated) {
            res.writeHead(200);
            res.end(`<!DOCTYPE html>
<html><head><title>Login</title>
<meta charset="UTF-8">
<style>
body{font-family:Arial,sans-serif;background:#1a1a2e;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}
.box{background:#16213e;padding:40px;border-radius:10px;text-align:center;max-width:400px;width:100%}
h1{color:#e94560;margin-bottom:30px}
input{width:100%;padding:15px;margin:10px 0;border:none;border-radius:5px;font-size:16px;box-sizing:border-box}
.btn{background:#28a745;color:#fff;padding:15px;border:none;border-radius:5px;font-size:18px;cursor:pointer;width:100%;margin-top:20px}
.btn:hover{background:#218838}
</style></head><body>
<div class="box"><h1>Gold Signal Forwarder</h1><p>Enter password:</p>
<input type="password" id="pwd" placeholder="Password" onkeypress="if(event.key==='Enter')login()">
<button class="btn" onclick="login()">Unlock</button>
<script>function login(){var p=document.getElementById('pwd').value;if(p)window.location.href='/?password='+encodeURIComponent(p);}</script>
</div></body></html>`);
            return;
        }
        
        res.writeHead(200);
        res.end(`<!DOCTYPE html>
<html><head><title>Dashboard</title>
<meta charset="UTF-8">
<style>
body{font-family:Arial,sans-serif;background:#1a1a2e;color:#fff;padding:20px}
.container{max-width:900px;margin:0 auto}
.status{padding:15px;border-radius:8px;margin:10px 0;font-size:18px;text-align:center}
.connected{background:#28a745}.disconnected{background:#dc3545}
.group-item{background:#16213e;padding:15px;margin:10px 0;border-radius:8px;cursor:pointer}
.group-item:hover{background:#0f3460}
.group-item.selected{background:#28a745}
.btn{background:#28a745;color:#fff;padding:15px 30px;border:none;border-radius:8px;font-size:18px;cursor:pointer}
.btn-secondary{background:#007bff;margin-left:10px}
.info{background:#16213e;padding:15px;border-radius:8px;margin:10px 0}
h1{text-align:center;color:#e94560}h2{color:#ffd700}
.step{background:#0f3460;padding:15px;margin:10px 0;border-radius:8px}
.logout{text-align:right;margin-bottom:10px}.logout a{color:#aaa;text-decoration:none}
.stats{display:grid;grid-template-columns:1fr 1fr;gap:15px;margin:15px 0}
.stat-box{background:#16213e;padding:15px;border-radius:8px;text-align:center}
.stat-value{font-size:32px;color:#ffd700;font-weight:bold}
.stat-label{color:#aaa;font-size:14px}
.keyword-tag{background:#28a745;color:#fff;padding:5px 10px;border-radius:15px;margin:5px;display:inline-block;font-size:12px}
.last-message{background:#0f3460;padding:15px;border-radius:8px;margin:10px 0;font-family:monospace;white-space:pre-wrap}
</style></head><body>
<div class="container">
<div class="logout"><a href="/">Logout</a></div>
<h1>Gold Signal Forwarder</h1>
<p style="text-align:center;color:#aaa">Telegram to WhatsApp</p>

<div style="text-align:center;margin:20px 0">
<a href="/setup?password=***" style="text-decoration:none"><button class="btn">Open Setup</button></a>
</div>

<div class="stats">
<div class="stat-box">
<div class="stat-value" id="telegram-status">--</div>
<div class="stat-label">Telegram</div>
</div>
<div class="stat-box">
<div class="stat-value" id="whatsapp-status">--</div>
<div class="stat-label">WhatsApp</div>
</div>
<div class="stat-box">
<div class="stat-value" id="forwarded-count">0</div>
<div class="stat-label">Signals Forwarded</div>
</div>
<div class="stat-box">
<div class="stat-value" id="target-group">-</div>
<div class="stat-label">Target Group</div>
</div>
</div>

<div class="step">
<h2>Configuration</h2>
<p><strong>Telegram Channel:</strong> <span id="telegram-channel">Not set</span></p>
<p><strong>Target WhatsApp:</strong> <span id="current-target">Not set</span></p>
</div>

<div class="step">
<h2>Filter Keywords</h2>
<div id="keywords"></div>
</div>

<div class="step">
<h2>Last Forwarded Signal</h2>
<div id="last-message" class="last-message">No signals forwarded yet</div>
</div>

<div style="text-align:center;margin-top:20px">
<button class="btn btn-secondary" onclick="loadStatus()">Refresh</button>
</div>
</div>

<script>
var PASS='***';
async function loadStatus(){
try{
var res=await fetch('/api/status?password='+PASS);
var data=await res.json();
document.getElementById('telegram-status').textContent=data.telegramConnected?'ON':'OFF';
document.getElementById('telegram-status').style.color=data.telegramConnected?'#28a745':'#dc3545';
document.getElementById('whatsapp-status').textContent=data.whatsappConnected?'ON':'OFF';
document.getElementById('whatsapp-status').style.color=data.whatsappConnected?'#28a745':'#dc3545';
document.getElementById('forwarded-count').textContent=data.forwardedCount;
document.getElementById('target-group').textContent=data.targetGroup?'SET':'NOT SET';
document.getElementById('telegram-channel').textContent=data.telegramChannel||'Not set';
document.getElementById('current-target').textContent=data.targetGroup||'Not set';
var kwContainer=document.getElementById('keywords');
kwContainer.innerHTML='';
data.keywords.forEach(function(kw){
var tag=document.createElement('span');
tag.className='keyword-tag';
tag.textContent=kw;
kwContainer.appendChild(tag);
});
if(data.lastForwarded){
document.getElementById('last-message').textContent='Type: '+(data.lastForwarded.signalType||'Unknown')+'\nTime: '+new Date(data.lastForwarded.time).toLocaleString()+'\nMessage: '+data.lastForwarded.text;
}
}catch(err){console.error(err);}
}
loadStatus();
setInterval(loadStatus,5000);
</script></body></html>`);
        return;
    }
    
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(3000, '0.0.0.0', () => {
    console.log('Server running on port 3000');
    console.log('Setup: http://YOUR_SERVER_IP:3000/setup');
    console.log('Dashboard: http://YOUR_SERVER_IP:3000');
});

async function start() {
    await connectToWhatsApp();
    await initTelegram();
}

start().catch(err => {
    console.error('Failed to start:', err);
    process.exit(1);
});
