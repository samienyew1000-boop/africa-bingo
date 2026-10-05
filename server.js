const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT || "3000", 10);
const PUBLIC_DIR = __dirname;
const BOT_TOKEN = process.env.BOT_TOKEN || "8882887936:AAEXtkABLYGWPSC-r4tXRMAOzET9Jp21NUQ";
const WEB_APP_URL = (process.env.WEB_APP_URL || "https://africa-bingo.ethiodeploy.com/").replace(/\/+$/, "") + "/";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

// In-memory / fallback game & admin state
const gameState = {
  rooms: [
    { id: "10", stake: 10, players: 0, status: "waiting", roundId: "#AB-101", prizePool: 0, called: [] },
    { id: "20", stake: 20, players: 0, status: "waiting", roundId: "#AB-102", prizePool: 0, called: [] },
    { id: "50", stake: 50, players: 0, status: "waiting", roundId: "#AB-103", prizePool: 0, called: [] },
  ],
  settings: {
    commissionRate: 20,
    minDeposit: 50,
    depositBonus: 20,
    bonusThreshold: 100,
    depositTelebirrPhone: "0999909474",
    depositTelebirrName: "Africa Bingo",
    depositCbeBirrPhone: "1000 000 000",
    depositCbeBirrName: "Africa Bingo CBE Birr",
    depositMpesaPhone: "0700 000 000",
    depositMpesaName: "Africa Bingo M-Pesa",
  },
  metrics: {
    totalPlayers: 1,
    verifiedPlayers: 1,
    processedToday: 0,
  },
  users: [],
  transactions: [],
};

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE, HEAD",
    "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Init-Data, X-Telegram-User-Id, X-Telegram-User-Name, X-Admin-Token, X-Admin-Password, Authorization",
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE, HEAD",
      "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Init-Data, X-Telegram-User-Id, X-Telegram-User-Name, X-Admin-Token, X-Admin-Password, Authorization",
    });
    res.end();
    return;
  }

  const rawUrl = req.url || "/";
  const [pathname, search] = rawUrl.split("?");

  // Health checks for cloud platforms (Ethio Deploy / Docker)
  if (pathname === "/health" || pathname === "/healthz" || pathname === "/ping" || pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    if (req.method !== "HEAD") res.write("OK");
    res.end();
    return;
  }

  // API Endpoints
  if (pathname.startsWith("/api/")) {
    if (pathname === "/api/rooms") {
      return sendJson(res, { rooms: gameState.rooms, settings: gameState.settings });
    }
    if (pathname === "/api/settings") {
      return sendJson(res, gameState.settings);
    }
    if (pathname === "/api/admin/overview") {
      return sendJson(res, {
        rooms: gameState.rooms,
        users: gameState.users,
        transactions: gameState.transactions,
        metrics: gameState.metrics,
        settings: gameState.settings,
      });
    }
    if (pathname === "/api/admin/login") {
      return sendJson(res, { ok: true, token: "admin-auth-token-valid" });
    }
    if (pathname === "/api/me") {
      return sendJson(res, {
        id: 1,
        username: "Africa Player",
        first_name: "Africa Player",
        balance: 5.0,
        role: "player",
        is_verified: 1,
      });
    }
    return sendJson(res, { ok: true });
  }

  // Static file handling
  let reqPath = decodeURIComponent(pathname);
  if (reqPath === "/" || reqPath === "") {
    reqPath = "/index.html";
  }

  const safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, "");
  let filePath = path.join(PUBLIC_DIR, safePath);

  fs.stat(filePath, (err, stats) => {
    if (err) {
      filePath = path.join(PUBLIC_DIR, "index.html");
    } else if (stats.isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    if (req.method === "HEAD") {
      res.writeHead(200, {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
      });
      res.end();
      return;
    }

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("404 Not Found");
        return;
      }

      res.writeHead(200, {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=86400",
      });
      res.end(content);
    });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Africa Bingo server running on port ${PORT}`);
  startTelegramBot();
});

// ==============================================================================
// TELEGRAM BOT LONG-POLLING (Lightweight & Self-contained)
// ==============================================================================
function telegramApi(method, data) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data || {});
    const req = https.request(
      `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
        timeout: 10000,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            resolve({ ok: false, error: e.message });
          }
        });
      }
    );
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    req.write(postData);
    req.end();
  });
}

async function startTelegramBot() {
  if (!BOT_TOKEN) return;
  console.log("[INFO] Initializing Telegram Bot...");

  // Setup Menu Button
  try {
    await telegramApi("setChatMenuButton", {
      menu_button: {
        type: "web_app",
        text: "Play Bingo 🎰",
        web_app: { url: WEB_APP_URL },
      },
    });
  } catch (e) {}

  let offset = 0;
  async function poll() {
    try {
      const res = await telegramApi("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      });
      if (res && res.ok && Array.isArray(res.result)) {
        for (const update of res.result) {
          offset = update.update_id + 1;
          const msg = update.message;
          if (msg && msg.text) {
            const chatId = msg.chat.id;
            const text = msg.text.trim();
            const firstName = msg.from.first_name || "Player";

            if (text.startsWith("/start") || text.toLowerCase() === "play") {
              await telegramApi("sendMessage", {
                chat_id: chatId,
                text: `👋 ሰላም *${firstName}*! ወደ *Africa Bingo* እንኳን በደህና መጡ! 🎲\n\nለመጫወት ከታች ያለውን **Play Africa Bingo 🎮** የሚለውን ቁልፍ ይጫኑ!`,
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: "Play Africa Bingo 🎮",
                        web_app: { url: WEB_APP_URL },
                      },
                    ],
                    [
                      {
                        text: "Admin Panel 🛡️",
                        web_app: { url: `${WEB_APP_URL}admin.html` },
                      },
                    ],
                  ],
                },
              });
            }
          }
        }
      }
    } catch (err) {}
    setTimeout(poll, 1500);
  }

  poll();
}
