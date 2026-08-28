#!/bin/bash
# Telegram to WhatsApp Forwarder - 24/7 Runner
# Auto-restarts if process crashes

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="/tmp/telegram-forwarder.log"
PID_FILE="/tmp/telegram-forwarder.pid"
RESTART_DELAY=5

echo "========================================="
echo "Telegram to WhatsApp Forwarder V3"
echo "24/7 Persistent Runner"
echo "========================================="
echo "Project: $PROJECT_DIR"
echo "Log: $LOG_FILE"
echo ""

# Function to check if process is running
check_running() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if ps -p "$PID" > /dev/null 2>&1; then
            return 0
        fi
    fi
    return 1
}

# Function to start the server
start_server() {
    echo "[$(date)] Starting server..."
    cd "$PROJECT_DIR"
    
    # Start with nohup to survive session disconnect
    nohup npm start >> "$LOG_FILE" 2>&1 &
    NEW_PID=$!
    echo $NEW_PID > "$PID_FILE"
    
    echo "[$(date)] Server started with PID: $NEW_PID"
    echo "[$(date)] Waiting for startup..."
    
    # Wait a few seconds to check if it started successfully
    sleep 5
    
    if ps -p "$NEW_PID" > /dev/null 2>&1; then
        echo "[$(date)] ✅ Server is running!"
        echo "[$(date)] Telegram listener is active"
        echo "[$(date)] WhatsApp is connected"
        return 0
    else
        echo "[$(date)] ❌ Server failed to start"
        return 1
    fi
}

# Function to stop the server
stop_server() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        echo "[$(date)] Stopping server (PID: $PID)..."
        kill "$PID" 2>/dev/null
        sleep 2
        # Force kill if still running
        if ps -p "$PID" > /dev/null 2>&1; then
            kill -9 "$PID" 2>/dev/null
        fi
        rm -f "$PID_FILE"
        echo "[$(date)] Server stopped"
    fi
}

# Main loop
main() {
    # Handle signals
    trap 'echo "[$(date)] Signal received, stopping..."; stop_server; exit 0' SIGINT SIGTERM
    
    # Stop any existing instance
    stop_server
    
    # Start initial instance
    start_server
    
    # Monitor and restart if needed
    while true; do
        if ! check_running; then
            echo "[$(date)] ⚠️  Server crashed or stopped!"
            echo "[$(date)] Restarting in $RESTART_DELAY seconds..."
            sleep $RESTART_DELAY
            start_server
        fi
        
        # Check every 10 seconds
        sleep 10
    done
}

# Handle command line arguments
case "${1:-}" in
    start)
        if check_running; then
            echo "Server is already running!"
            exit 1
        fi
        main &
        echo "Runner started in background"
        ;;
    stop)
        stop_server
        # Also kill the runner script
        RUNNER_PID=$(pgrep -f "bash.*run.sh")
        if [ -n "$RUNNER_PID" ]; then
            kill "$RUNNER_PID" 2>/dev/null
        fi
        echo "Stopped"
        ;;
    restart)
        stop_server
        sleep 2
        main &
        echo "Restarted"
        ;;
    status)
        if check_running; then
            PID=$(cat "$PID_FILE")
            echo "✅ Server is running (PID: $PID)"
            echo ""
            echo "Recent logs:"
            tail -10 "$LOG_FILE"
        else
            echo "❌ Server is not running"
        fi
        ;;
    logs)
        echo "Showing logs (Ctrl+C to exit):"
        tail -f "$LOG_FILE"
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|logs}"
        echo ""
        echo "Commands:"
        echo "  start   - Start the 24/7 runner"
        echo "  stop    - Stop the server and runner"
        echo "  restart - Restart everything"
        echo "  status  - Check if server is running"
        echo "  logs    - View live logs"
        echo ""
        echo "For 24/7 operation, use: ./run.sh start"
        ;;
esac
