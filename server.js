const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT || "3000", 10);
const PUBLIC_DIR = __dirname;
const STATE_FILE = path.join(__dirname, "game-state.json");
const BOT_TOKEN = process.env.BOT_TOKEN || "8882887936:AAEXtkABLYGWPSC-r4tXRMAOzET9Jp21NUQ";
const WEB_APP_URL = (process.env.WEB_APP_URL || "https://africa-bingo.ethiodeploy.com/").replace(/\/+$/, "") + "/";
const ADMIN_IDS = ["5663531258", "0999909474"];

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

// Initial state with 100 ETB default starting bonus
const DEFAULT_STATE = {
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
    startingBonus: 100,
    startingBonusEnabled: true,
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
  users: {},
  transactions: [],
};

let gameState = DEFAULT_STATE;

function loadGameState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      gameState = {
        ...DEFAULT_STATE,
        ...data,
        settings: { ...DEFAULT_STATE.settings, ...(data.settings || {}) },
        users: data.users || {},
        transactions: data.transactions || [],
      };
    }
  } catch (e) {
    console.warn("Failed to load game-state.json:", e.message);
  }
}

function saveGameState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(gameState, null, 2), "utf-8");
  } catch (e) {
    console.warn("Failed to save game-state.json:", e.message);
  }
}

loadGameState();

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE, HEAD",
    "Access-Control-Allow-Headers": "Content-Type, X-Telegram-Init-Data, X-Telegram-User-Id, X-Telegram-User-Name, X-Admin-Token, X-Admin-Password, Authorization",
  });
  res.end(JSON.stringify(data));
}

function parseJsonBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (e) {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function getUserFromHeaders(req) {
  const uid = req.headers["x-telegram-user-id"] || "LB-PLAYER";
  const uname = req.headers["x-telegram-user-name"] || "";
  const name = uname ? `@${uname}` : (uid !== "LB-PLAYER" ? `Player ${String(uid).slice(-4)}` : "Africa Player");
  return { id: uid, username: uname, name };
}

const server = http.createServer(async (req, res) => {
  // CORS Preflight
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
  const [pathname] = rawUrl.split("?");

  // Health checks
  if (pathname === "/health" || pathname === "/healthz" || pathname === "/ping" || pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" });
    if (req.method !== "HEAD") res.write("OK");
    res.end();
    return;
  }

  // ==============================================================================
  // API ENDPOINTS
  // ==============================================================================
  if (pathname.startsWith("/api/")) {
    const user = getUserFromHeaders(req);

    // 1. Get or create current user profile (with 100 ETB starting bonus!)
    if (pathname === "/api/me") {
      if (!gameState.users[user.id]) {
        gameState.users[user.id] = {
          id: user.id,
          username: user.username,
          first_name: user.name,
          balance: 100.0, // 100 ETB STARTING BONUS FOR NEW USERS!
          bonus_balance: 100.0,
          bonus_claimed: 1,
          role: "player",
          is_verified: 1,
          created_at: new Date().toISOString(),
        };
        saveGameState();
      }
      return sendJson(res, gameState.users[user.id]);
    }

    // 2. Submit Deposit Request (immediately visible in Admin Console!)
    if (pathname === "/api/deposit" && req.method === "POST") {
      const body = await parseJsonBody(req);
      const amount = Number(body.amount) || 0;
      const method = body.method || "Telebirr";
      const reference = body.reference || "";
      const phone = body.phone || "";

      const txId = `DEP-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 900 + 100)}`;
      const newTx = {
        id: txId,
        playerId: `LB-${String(user.id).slice(-5)}`,
        user_id: user.id,
        player: user.name,
        phone: phone,
        type: "deposit",
        method: method,
        amount: amount,
        reference: reference,
        requested: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        status: "pending",
        created_at: new Date().toISOString(),
      };

      gameState.transactions.unshift(newTx);
      saveGameState();

      // Notify Admin on Telegram
      notifyTelegramAdmin(`📩 *አዲስ የተቀማጭ ጥያቄ (New Deposit Request)*\n\n👤 *ተጫዋች:* ${user.name}\n💰 *መጠን:* \`${amount} ETB\`\n🏦 *መንገድ:* ${method}\n🧾 *ማጣቀሻ (Ref):* \`${reference}\`\n\n✅ ለማጽደቅ ወደ Admin Console ይሂዱ: ${WEB_APP_URL}admin.html`);

      return sendJson(res, { ok: true, id: txId, status: "pending" });
    }

    // 3. Submit Withdrawal Request
    if (pathname === "/api/withdraw" && req.method === "POST") {
      const body = await parseJsonBody(req);
      const amount = Number(body.amount) || 0;
      const method = body.method || "Telebirr";
      const phone = body.phone || "";

      const txId = `WTH-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 900 + 100)}`;
      const newTx = {
        id: txId,
        playerId: `LB-${String(user.id).slice(-5)}`,
        user_id: user.id,
        player: user.name,
        phone: phone,
        type: "withdraw",
        method: method,
        amount: amount,
        requested: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        status: "pending",
        created_at: new Date().toISOString(),
      };

      gameState.transactions.unshift(newTx);
      saveGameState();

      notifyTelegramAdmin(`📤 *የገንዘብ ማውጣት ጥያቄ (New Withdrawal Request)*\n\n👤 *ተጫዋች:* ${user.name}\n💰 *መጠን:* \`${amount} ETB\`\n📱 *ስልክ:* \`${phone}\`\n🏦 *መንገድ:* ${method}\n\n✅ ለማጽደቅ: ${WEB_APP_URL}admin.html`);

      return sendJson(res, { ok: true, id: txId, status: "pending" });
    }

    // 4. Admin Overview (Live feed of rooms, transactions, players, settings)
    if (pathname === "/api/admin/overview") {
      const pendingCount = gameState.transactions.filter((t) => t.status === "pending").length;
      const approvedTotal = gameState.transactions
        .filter((t) => t.status === "approved" || t.status === "completed")
        .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

      const usersList = Object.values(gameState.users);

      return sendJson(res, {
        rooms: gameState.rooms,
        users: usersList,
        transactions: gameState.transactions,
        metrics: {
          totalPlayers: Math.max(1, usersList.length),
          verifiedPlayers: Math.max(1, usersList.length),
          processedToday: approvedTotal,
          pendingTransactions: pendingCount,
        },
        settings: gameState.settings,
      });
    }

    // 5. Admin Approve / Reject Transaction
    if ((pathname === "/api/admin/transaction/update" || pathname === "/api/admin/transaction") && req.method === "POST") {
      const body = await parseJsonBody(req);
      const txId = body.id || body.tx_id;
      const action = body.action || "approve"; // "approve" or "reject"

      const tx = gameState.transactions.find((t) => t.id === txId);
      if (tx) {
        tx.status = action === "approve" ? "approved" : "rejected";
        tx.processedAt = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

        // If deposit approved, credit the user balance
        if (action === "approve" && tx.type === "deposit") {
          const bonus = tx.amount >= 100 ? Math.floor(tx.amount * 0.2) : 0;
          const totalCredit = tx.amount + bonus;
          if (tx.user_id && gameState.users[tx.user_id]) {
            gameState.users[tx.user_id].balance = (gameState.users[tx.user_id].balance || 0) + totalCredit;
          }
        }

        saveGameState();
        return sendJson(res, { ok: true, id: txId, status: tx.status });
      }
      return sendJson(res, { error: "Transaction not found" }, 404);
    }

    // 6. Admin Login
    if (pathname === "/api/admin/login") {
      return sendJson(res, { ok: true, token: "admin-auth-token-valid" });
    }

    // 7. Rooms & Settings
    if (pathname === "/api/rooms") {
      return sendJson(res, { rooms: gameState.rooms, settings: gameState.settings });
    }
    if (pathname === "/api/settings") {
      return sendJson(res, gameState.settings);
    }
    if (pathname === "/api/admin/settings/update" && req.method === "POST") {
      const body = await parseJsonBody(req);
      gameState.settings = { ...gameState.settings, ...body };
      saveGameState();
      return sendJson(res, { ok: true });
    }

    return sendJson(res, { ok: true });
  }

  // ==============================================================================
  // STATIC FILE SERVING
  // ==============================================================================
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

      const isDynamic = ext === ".html" || ext === ".js" || ext === ".css";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": isDynamic ? "no-cache, no-store, must-revalidate" : "public, max-age=86400",
        "Pragma": isDynamic ? "no-cache" : "public",
        "Expires": isDynamic ? "0" : "86400",
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
// TELEGRAM BOT & NOTIFICATIONS
// ==============================================================================
function telegramApi(method, data) {
  return new Promise((resolve) => {
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

async function notifyTelegramAdmin(text) {
  for (const adminId of ADMIN_IDS) {
    if (adminId && !adminId.startsWith("09")) {
      telegramApi("sendMessage", {
        chat_id: adminId,
        text: text,
        parse_mode: "Markdown",
      }).catch(() => {});
    }
  }
}

async function startTelegramBot() {
  if (!BOT_TOKEN) return;
  console.log("[INFO] Initializing Telegram Bot Menu Button...");

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
                text: `👋 ሰላም *${firstName}*! ወደ *Africa Bingo* እንኳን በደህና መጡ! 🎲\n\n🎁 *የ 100 ETB የመመዝገቢያ ቦነስ ተሰጥቷችኋል!*\n\nለመጫወት ከታች ያለውን **Play Africa Bingo 🎮** የሚለውን ቁልፍ ይጫኑ!`,
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: "Play Africa Bingo 🎮 (100 ETB Bonus)",
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
