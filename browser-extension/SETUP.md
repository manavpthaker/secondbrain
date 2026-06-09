# Brownbot Browser Extension — Setup

One-time setup to connect brownbot to Chrome on the Mac mini.

## Prerequisites
- Chrome installed at `/Applications/Google Chrome.app`
- brownbot running (`npm run dev` or via launchd)
- Logged into LinkedIn, Gmail, etc. in Chrome

## Install the Extension

1. Open Screen Sharing to the Mac mini (or sit in front of it)
2. Open Chrome
3. Navigate to `chrome://extensions`
4. Enable **Developer Mode** (toggle in top-right)
5. Click **Load unpacked**
6. Select this folder: `~/Documents/GitHub/brownbot-browser-extension/`
7. Confirm **Brownbot Bridge** appears and is enabled

## Verify Connection

1. Restart brownbot: `cd ~/Documents/GitHub/brownbot && npm run dev`
2. Look for `[browser-bridge] Chrome extension connected` in the logs
3. Test from WhatsApp: `bb go to linkedin.com and tell me what you see`

## Auto-launch Chrome on Boot (optional)

```bash
cp ~/Documents/GitHub/brownbot/launchd/com.brownbot.chrome.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.brownbot.chrome.plist
```

## Troubleshooting

- **Extension disconnected**: Check Chrome is open. The extension auto-reconnects every 3 seconds.
- **"Chrome extension not connected"**: Open `chrome://extensions`, confirm Brownbot Bridge is enabled, then check the service worker console for errors.
- **LinkedIn auth wall**: Log into LinkedIn manually in Chrome — the extension uses your real session.
- **Port conflict on 9222**: Set `BROWSER_BRIDGE_PORT=9223` in `.env` and update the stored `bridgeUrl` (see token auth section above for the chrome.storage command).

## Optional: token-authenticated bridge

By default the bridge accepts any localhost WebSocket connection. To require authentication:

1. Pick a long random string. `openssl rand -hex 32` is fine.
2. Set `BROWSER_BRIDGE_TOKEN=<that string>` in brownbot's `.env`. Restart brownbot.
3. In Chrome, open `chrome://extensions`, find Brownbot Bridge, click **Service worker** to open DevTools.
4. In the console:
   ```js
   await chrome.storage.local.set({ bridgeToken: '<that string>' });
   // optional: override the URL if running on a custom port
   await chrome.storage.local.set({ bridgeUrl: 'ws://localhost:9222' });
   ```
5. Reload the extension. Watch the brownbot log for `auth ok — extension connected`.

Without a matching token the bridge rejects the connection with close code `4401`. Mismatches show up as `auth failed` or `auth timeout` in brownbot's logs.

You can also pin the bridge to a specific extension origin: set `BROWSER_EXTENSION_ID` in `.env` to the id Chrome assigns the extension (visible on `chrome://extensions`). Origin mismatches are logged and rejected with `4403 forbidden origin`.
