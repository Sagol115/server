const WebSocket = require('ws');
const admin     = require('firebase-admin');
const fs        = require('fs');

// ── FIREBASE ─────────────────────────────────────────────────────────────
let serviceAccount = null;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        log('Firebase', 'Loaded credentials from FIREBASE_SERVICE_ACCOUNT env');
    } catch (e) {
        log('Firebase', `⚠️ Failed to parse FIREBASE_SERVICE_ACCOUNT env: ${e.message}`);
    }
} else if (fs.existsSync('./serviceAccountKey.json')) {
    try {
        serviceAccount = require('./serviceAccountKey.json');
        log('Firebase', 'Loaded credentials from ./serviceAccountKey.json');
    } catch (e) {
        log('Firebase', `⚠️ Failed to read ./serviceAccountKey.json: ${e.message}`);
    }
}

let ref = null;
if (serviceAccount) {
    try {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: "https://kilvish-d1705-default-rtdb.firebaseio.com"
        });
        const db = admin.database();
        ref = db.ref("server_config");
        log('Firebase', '✓ Firebase initialized successfully');
    } catch (e) {
        log('Firebase', `⚠️ Firebase init error: ${e.message}`);
    }
} else {
    log('Firebase', '⚠️ Running without Firebase credentials. Pass FIREBASE_SERVICE_ACCOUNT env or serviceAccountKey.json to enable auto-URL push.');
}

// ── STATE ────────────────────────────────────────────────────────────────
let clientSocket = null;
let adminSocket  = null;

function resetServerState() {
    log('Server', '✓ Relay state reset');
}

function now() {
    return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function log(tag, msg) {
    console.log(`[${now()}] [${tag}] ${msg}`);
}

function sendToAdmin(data, isBinary = false) {
    if (adminSocket && adminSocket.readyState === WebSocket.OPEN) {
        // Protect server memory from buffer bloat if admin network is slow
        if (adminSocket.bufferedAmount > 8 * 1024 * 1024) {
            log('Buffer', `Admin buffer high (${(adminSocket.bufferedAmount / 1024 / 1024).toFixed(1)}MB) — dropping frame`);
            return false;
        }
        adminSocket.send(data, { binary: isBinary });
        return true;
    }
    return false;
}

function sendToClient(data, isBinary = false) {
    if (clientSocket && clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(data, { binary: isBinary });
        return true;
    }
    return false;
}

function isClientOnline() {
    return clientSocket && clientSocket.readyState === WebSocket.OPEN;
}

function isAdminOnline() {
    return adminSocket && adminSocket.readyState === WebSocket.OPEN;
}

/**
 * Write the public server URL to Firebase so Client and Admin apps auto-connect.
 */
function updateFirebaseURL(url) {
    if (!ref) {
        log('Firebase', '⚠️ Firebase ref not ready — cannot push URL');
        return;
    }
    ref.update({ url, updatedAt: Date.now() })
       .then(() => log('Firebase', `✓ URL pushed to Firebase → ${url}`))
       .catch(err => log('Firebase', `ERROR pushing URL: ${err.message}`));
}

// ── SERVER ───────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
const wss  = new WebSocket.Server({ port: PORT }, () => {
    // Check Render external URL, custom SERVER_URL env, or command line arg
    const serverUrl = process.env.RENDER_EXTERNAL_URL || process.env.SERVER_URL || process.argv[2];

    const G = '\x1b[92m'; // Bright Green
    const B = '\x1b[1m';  // Bold
    const R = '\x1b[0m';  // Reset
    const C = '\x1b[96m'; // Cyan

    const bannerLines = [
        "            ______",
        "         .-\"      \"-.",
        "        /            \\",
        "       |              |",
        "       |,  .-.  .-.  ,|",
        "       | )(__/  \\__)( |",
        "       |/     /\\     \\|",
        "       (_     ^^     _)",
        "        \\__|IIIIII|__/",
        "         | \\IIIIII/ |",
        "          \\        /",
        "           `------`",
        "",
        " ╔═════════════════════════════════════════════╗",
        ` ║   ANTI-GRAVITY ZERO-KNOWLEDGE RELAY        ║`,
        ` ║                 PORT ${PORT}                  ║`,
        " ╚═════════════════════════════════════════════╝"
    ];

    console.log(G + B);
    bannerLines.forEach(line => console.log(line));
    console.log(R);

    if (serverUrl) {
        const wsUrl = serverUrl.replace(/^https?:\/\//, (m) => m.startsWith('https') ? 'wss://' : 'ws://');
        console.log(C + `  [+] Server URL : ${serverUrl}`);
        console.log(`  [+] WSS URL    : ${wsUrl}` + R);
        console.log(G + "  ─────────────────────────────────────────\n" + R);
        updateFirebaseURL(serverUrl);
    } else {
        log('Info', 'Running without auto URL update — apps will connect via existing Firebase URL');
    }
});

// ── ZERO-KNOWLEDGE BLIND RELAY CONNECTION HANDLER ─────────────────────────
wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const ip = req.socket.remoteAddress;
    log('Server', `New connection from ${ip} | Active: ${wss.clients.size}`);

    ws.on('message', (message, isBinary) => {
        // ── 1. Binary stream (Screen, Camera, Audio, File Chunks) ──
        if (isBinary) {
            if (ws === clientSocket) {
                // Blindly forward encrypted binary stream to Admin (Zero inspection)
                sendToAdmin(message, true);
            }
            return;
        }

        // ── 2. Text / JSON Messages ──
        const textStr = message.toString();
        let data = null;
        try {
            data = JSON.parse(textStr);
        } catch (_) {
            // Not JSON or pure encrypted string — handled below
        }

        // Check for Client Handshake
        if (data && (data.action === 'client_login' || data.status === 'online')) {
            if (clientSocket && clientSocket !== ws && clientSocket.readyState === WebSocket.OPEN) {
                clientSocket.close(1000, 'Replaced by new client connection');
                log('CLIENT', 'Closed stale client socket');
            }
            clientSocket = ws;
            log('CLIENT', '✓ Client socket connected (Zero-Knowledge)');

            // Inform Admin of client connection
            sendToAdmin(JSON.stringify({
                action: 'status_update',
                message: 'Client Connected'
            }));

            // If an encrypted payload was attached in the greeting, forward it to Admin
            if (data.e2ee || data.payload) {
                sendToAdmin(textStr);
            }
            return;
        }

        // Check for Admin Handshake
        if (data && data.action === 'admin_login') {
            if (adminSocket && adminSocket !== ws && adminSocket.readyState === WebSocket.OPEN) {
                adminSocket.close(1000, 'Replaced by new admin connection');
                log('ADMIN', 'Closed stale admin socket');
            }
            adminSocket = ws;
            log('ADMIN', '✓ Admin socket connected');

            // Confirm connection to Admin
            ws.send(JSON.stringify({ action: 'connection_status', message: 'Server Connected' }));
            ws.send(JSON.stringify({
                action: 'status_update',
                message: isClientOnline() ? 'Client Connected' : 'Client Disconnected'
            }));
            return;
        }

        // Admin → Client forwarding
        if (ws === adminSocket) {
            // Server refresh command
            if (data && data.action === 'refresh_server') {
                log('ADMIN', 'Server state reset requested');
                resetServerState();
                return;
            }

            // Blindly forward command (encrypted E2EE payload) to Client
            if (isClientOnline()) {
                sendToClient(textStr);
            } else {
                ws.send(JSON.stringify({
                    action: 'ack',
                    message: 'Client is offline'
                }));
            }
            return;
        }

        // Client → Admin forwarding
        if (ws === clientSocket) {
            // Handle client disconnect warning
            if (data && data.action === 'client_dying') {
                log('CLIENT', 'Client is shutting down');
                resetServerState();
                sendToAdmin(JSON.stringify({ action: 'client_crashed' }));
                sendToAdmin(JSON.stringify({ action: 'status_update', message: 'Client Disconnected' }));
                return;
            }

            // Blindly forward encrypted message to Admin
            sendToAdmin(textStr);
            return;
        }

        log('Warn', `Unregistered message from ${ip}`);
    });

    // ── DISCONNECT ────────────────────────────────────────────────────────
    ws.on('close', (code) => {
        if (ws === clientSocket) {
            log('CLIENT', `X Client disconnected (code: ${code})`);
            clientSocket = null;
            resetServerState();
            sendToAdmin(JSON.stringify({ action: 'client_crashed' }));
            sendToAdmin(JSON.stringify({ action: 'status_update', message: 'Client Disconnected' }));
        } else if (ws === adminSocket) {
            log('ADMIN', `X Admin disconnected (code: ${code})`);
            adminSocket = null;
            resetServerState();

            if (isClientOnline()) {
                sendToClient(JSON.stringify({
                    action: 'stop_all',
                    reason: 'Admin disconnected'
                }));
            }
        }
    });

    ws.on('error', (err) => {
        log('Error', `WebSocket error: ${err.message}`);
    });
});

// ── STATS & HEARTBEAT ────────────────────────────────────────────────────
setInterval(() => {
    log('Status',
        `Admin: ${isAdminOnline() ? 'ONLINE' : 'OFFLINE'}` +
        ` | Client: ${isClientOnline() ? 'ONLINE' : 'OFFLINE'}` +
        ` | Connections: ${wss.clients.size}`
    );
}, 60_000);

setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 180_000);

// ── GRACEFUL SHUTDOWN ────────────────────────────────────────────────────
const shutdown = () => {
    log('Server', 'Shutting down gracefully...');
    wss.close(() => {
        log('Server', 'All connections closed. Bye!');
        process.exit(0);
    });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
