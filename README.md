# Telegram to WhatsApp Forwarder V3

A powerful bot that forwards filtered messages from Telegram channels to WhatsApp groups. Perfect for gold/signal trading groups.

## Features

- **Message Filtering**: Only forwards messages containing specific keywords (e.g., "Gold sell now", "XAUUSD buy now")
- **Sensitive Word Removal**: Automatically removes sensitive/source words before forwarding (e.g., "Mike", "@mikegoldmaster")
- **Dual Target Support**: Send to 2 different WhatsApp groups simultaneously
- **Web Setup UI**: Easy configuration through browser - no coding needed
- **Auto-Login**: Remembers Telegram and WhatsApp sessions
- **Real-time Status**: Shows connection status for Telegram and WhatsApp

## How It Works

```
Telegram Channel (@piphunter2025)
    ↓ (monitors for keywords)
Bot detects "Gold sell now" message
    ↓ (removes sensitive words)
Removes "Mike", "@mikegoldmaster", etc.
    ↓ (forwards to WhatsApp)
WhatsApp Group (Target 1 & Target 2)
```

## Project Structure

```
├── telegram-forwarder.js    # Main server & forwarder logic
├── working.html             # Web setup UI (main interface)
├── config.js                # Configuration file
├── package.json             # Dependencies
├── auth_info/               # WhatsApp session data
├── telegram_session.txt     # Telegram session
└── README.md                # This file
```

## Prerequisites

- Node.js v18+
- Telegram API credentials (from my.telegram.org/apps)
- WhatsApp account with target groups

## Setup Guide

### Step 1: Install Dependencies

```bash
npm install
```

### Step 2: Get Telegram API Credentials

1. Go to https://my.telegram.org/apps
2. Create a new application
3. Note down:
   - **API ID** (e.g., 26449295)
   - **API Hash** (e.g., c5bc811832610ae1b056889e423680eb)

### Step 3: Configure via Web UI

1. Start the server:
```bash
npm start
```

2. Open browser:
```
http://localhost:3000/working.html
```

3. Fill in the setup form:
   - **API ID**: Your Telegram API ID
   - **API Hash**: Your Telegram API Hash
   - **Channel**: Telegram channel to monitor (e.g., @piphunter2025)
   - **Keywords**: One per line (e.g., "Gold sell now", "XAUUSD buy now")
   - **Sensitive Words**: Words to remove (e.g., "Mike", "@mikegoldmaster")

### Step 4: Login to Telegram

1. Enter your phone number with country code (e.g., +8801300812607)
2. Click "Send Code"
3. Enter the code received on Telegram
4. If you have 2FA, enter your password

### Step 5: Login to WhatsApp

1. Click "Show QR Code"
2. Open WhatsApp on your phone
3. Go to Settings → Linked Devices → Link a Device
4. Scan the QR code shown on screen

### Step 6: Select Target Groups

1. Click "Load Groups" under Target Group 1
2. Select your desired WhatsApp group
3. (Optional) Enable Target Group 2 and repeat

### Step 7: Done!

The bot is now running and will:
- Monitor the Telegram channel
- Filter messages by keywords
- Remove sensitive words
- Forward to your WhatsApp group(s)

## Configuration File (config.js)

```javascript
module.exports = {
    TELEGRAM_API_ID: 26449295,
    TELEGRAM_API_HASH: 'c5bc811832610ae1b056889e423680eb',
    TELEGRAM_CHANNEL: '@piphunter2025',
    WHATSAPP_TARGET_ID: '120363409268743119@g.us',
    WHATSAPP_TARGET_ID_2: 'null',
    TARGET_2_ENABLED: false,
    FILTER_KEYWORDS: [
        'Gold sell now',
        'Gold buy now',
        'XAUUSD buy now',
        'XAUUSD sell now',
        'Xauusd Buy Zone',
        'Xauusd Sell Zone',
        'Buying Xauusd Now',
        'Running',
        'running',
        'RUNNING',
        'running!'
    ],
    SENSITIVE_WORDS: [
        'Mike',
        'source',
        '@mikegoldmaster',
        '#Mikesyndicate',
        '#since2019',
        '#mikegoldmaster',
        '#mike',
        '@mike'
    ],
    ADMIN_NUMBERS: [],
};
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/config` | GET/POST | Get/update configuration |
| `/api/status` | GET | Get connection status |
| `/api/groups` | GET | List WhatsApp groups |
| `/api/whatsapp/qr` | GET | Get WhatsApp QR code |
| `/api/telegram/login` | POST | Telegram login flow |

## Environment Variables

Create a `.env` file (optional):
```
PORT=3000
DASHBOARD_PASSWORD=          # Leave empty for no password
```

## Errors Faced & Solutions

### Error 1: "Unauthorized" when loading saved data
**Cause**: Password parameter was `undefined` when not in URL, but server checked `undefined === ""` which is `false`
**Solution**: Changed server to use `parsedUrl.query.password || ''` to default to empty string

### Error 2: JavaScript not executing on setup page
**Cause**: Original `simple-setup.html` had complex JavaScript that failed to load
**Solution**: Created clean `working.html` with simpler, working JavaScript

### Error 3: Groups not loading
**Cause**: Frontend called `/api/whatsapp/groups` but server endpoint was `/api/groups`
**Solution**: Updated API endpoint to support both paths

### Error 4: Server crashes on WhatsApp disconnect
**Cause**: WhatsApp connection timeout (408) caused unhandled errors
**Solution**: Added reconnection logic with 5-second retry

### Error 5: Saved config not displaying
**Cause**: `loadSavedConfig()` function was `undefined` due to script not loading
**Solution**: Complete rewrite of setup page with proper error handling

## Troubleshooting

### "Not Found" error
- Make sure you're accessing `/working.html`
- Root `/` redirects to working.html

### WhatsApp QR not showing
- Check browser console for errors
- Ensure WhatsApp is not already connected

### Messages not forwarding
- Check Telegram is connected (green badge)
- Check WhatsApp is connected (green badge)
- Verify keywords match exactly
- Check target group is selected

### Server stops/crashes
- Check logs: `cat /tmp/dev-3000.log`
- Restart: `npm start`

## Tech Stack

- **Backend**: Node.js, Express-like HTTP server
- **Telegram**: gramJS library
- **WhatsApp**: Baileys library
- **Frontend**: Vanilla HTML/CSS/JS
- **QR Codes**: qrcode library

## Credits

- **Created by**: Tawhid (TraderTawhid)
- **GitHub**: https://github.com/designertawhid
- **Repo**: https://github.com/designertawhid/Telegram-to-WhatsApp-V3

## License

MIT License - Free to use and modify.

## Support

For issues or questions, create an issue on GitHub or contact via Telegram.
