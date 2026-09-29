# Anti-Gravity Zero-Knowledge Relay Server

A lightweight, high-performance WebSocket relay server designed for End-to-End Encrypted (E2EE) real-time streaming and command routing between Android client and admin applications.

## Features
- **Zero-Knowledge Blind Relay:** Forwards encrypted AES-256-GCM payloads without inspecting, logging, or storing sensitive data.
- **Firebase Auto-Sync:** Automatically updates Firebase Realtime Database with the server URL on startup.
- **Render.com Ready:** Designed for seamless deployment on Render.com free web services.

## Deployment on Render
1. Create a new **Web Service** on [Render.com](https://render.com).
2. Connect this repository.
3. Configure settings:
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node index.js`
4. Set Environment Variable:
   - `FIREBASE_SERVICE_ACCOUNT`: *(Paste serviceAccountKey.json content)*
