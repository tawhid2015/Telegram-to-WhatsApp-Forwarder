#!/usr/bin/env node
/**
 * Telegram to WhatsApp Forwarder - Keepalive Monitor
 * Ensures the forwarder runs 24/7 with auto-restart
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROJECT_DIR = __dirname;
const LOG_FILE = '/tmp/telegram-forwarder.log';
const PID_FILE = '/tmp/telegram-forwarder.pid';
const RESTART_DELAY = 5000; // 5 seconds
const HEALTH_CHECK_INTERVAL = 30000; // 30 seconds

let childProcess = null;
let restartCount = 0;
let lastRestartTime = Date.now();

// Logger
function log(message) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}`;
    console.log(line);
    fs.appendFileSync(LOG_FILE, line + '\n');
}

// Check if process is healthy
function isHealthy() {
    if (!childProcess) return false;
    
    // Check if process is still running
    try {
        process.kill(childProcess.pid, 0);
        return true;
    } catch (e) {
        return false;
    }
}

// Kill any existing processes on port 3000
function killExistingProcesses() {
    try {
        // Find and kill any node processes using port 3000
        const { execSync } = require('child_process');
        try {
            const result = execSync('lsof -ti:3000', { encoding: 'utf8' });
            const pids = result.trim().split('\n');
            pids.forEach(pid => {
                if (pid) {
                    log(`Killing existing process on port 3000: ${pid}`);
                    try { process.kill(parseInt(pid), 'SIGKILL'); } catch (e) {}
                }
            });
        } catch (e) {
            // No processes found on port 3000
        }
    } catch (e) {
        log(`Error killing existing processes: ${e.message}`);
    }
}

// Start the forwarder
function startForwarder() {
    log('=========================================');
    log('Starting Telegram to WhatsApp Forwarder V3');
    log('=========================================');
    
    // Kill any existing processes first
    killExistingProcesses();
    
    // Wait a moment for port to be released
    const startDelay = childProcess ? 3000 : 0;
    
    setTimeout(() => {
        const env = {
            ...process.env,
            NODE_ENV: 'production'
        };
        
        childProcess = spawn('npm', ['start'], {
            cwd: PROJECT_DIR,
            env,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        
        // Save PID
    fs.writeFileSync(PID_FILE, childProcess.pid.toString());
    
    log(`Forwarder started with PID: ${childProcess.pid}`);
    
    // Handle stdout
    childProcess.stdout.on('data', (data) => {
        const lines = data.toString().trim().split('\n');
        lines.forEach(line => {
            if (line.trim()) {
                log(`[FORWARDER] ${line}`);
            }
        });
    });
    
    // Handle stderr
    childProcess.stderr.on('data', (data) => {
        const lines = data.toString().trim().split('\n');
        lines.forEach(line => {
            if (line.trim()) {
                log(`[FORWARDER ERROR] ${line}`);
            }
        });
    });
    
    // Handle exit
    childProcess.on('exit', (code, signal) => {
        log(`Forwarder exited with code ${code} (signal: ${signal})`);
        childProcess = null;
        
        // Auto-restart
        const now = Date.now();
        if (now - lastRestartTime > 60000) {
            // Reset counter if more than 1 minute since last restart
            restartCount = 0;
        }
        restartCount++;
        lastRestartTime = now;
        
        if (restartCount > 5) {
            log('⚠️  Too many restarts! Waiting 30 seconds before retry...');
            setTimeout(startForwarder, 30000);
        } else {
            log(`Restarting in ${RESTART_DELAY/1000} seconds... (attempt ${restartCount})`);
            setTimeout(startForwarder, RESTART_DELAY);
        }
    });
    
    // Handle error
    childProcess.on('error', (err) => {
        log(`Failed to start forwarder: ${err.message}`);
    });
    }, startDelay); // Close setTimeout
}

// Graceful shutdown
function shutdown() {
    log('Shutting down keepalive monitor...');
    
    if (childProcess) {
        log('Stopping forwarder...');
        childProcess.kill('SIGTERM');
        
        // Force kill after 5 seconds
        setTimeout(() => {
            if (childProcess) {
                childProcess.kill('SIGKILL');
            }
        }, 5000);
    }
    
    // Clean up PID file
    try {
        fs.unlinkSync(PID_FILE);
    } catch (e) {}
    
    setTimeout(() => {
        process.exit(0);
    }, 1000);
}

// Health check
function healthCheck() {
    if (!isHealthy()) {
        log('⚠️  Health check failed! Forwarder is not running.');
        // The exit handler will trigger restart
    } else {
        // Log status periodically
        const uptime = Math.floor((Date.now() - lastRestartTime) / 1000);
        if (uptime % 300 === 0) { // Every 5 minutes
            log(`✅ Health check passed. Uptime: ${uptime}s. Restarts: ${restartCount}`);
        }
    }
}

// Main
function main() {
    log('');
    log('=========================================');
    log('Keepalive Monitor Started');
    log('=========================================');
    log(`Project: ${PROJECT_DIR}`);
    log(`Log file: ${LOG_FILE}`);
    log(`PID file: ${PID_FILE}`);
    log('');
    
    // Handle signals
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('SIGUSR1', () => {
        log('Received SIGUSR1 - checking health');
        healthCheck();
    });
    
    // Start health check interval
    setInterval(healthCheck, HEALTH_CHECK_INTERVAL);
    
    // Start the forwarder
    startForwarder();
    
    // Keep process alive
    setInterval(() => {}, 1000);
}

// Run
main();
