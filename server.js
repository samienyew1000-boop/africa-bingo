const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

// Load .env file if present
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  try {
    const envLines = fs.readFileSync(envPath, "utf-8").split(/\r?\n/);
    for (const line of envLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (key) {
          process.env[key] = val;
        }
      }
    }
  } catch (e) {
    console.warn("Could not read .env file:", e.message);
  }
}

const PORT = parseInt(process.env.PORT || "3000", 10);
const PUBLIC_DIR = __dirname;
const STATE_FILE = path.join(__dirname, "game-state.json");
const BACKUP_STATE_FILE = path.join(__dirname, "game-state.backup.json");
const ROOT_BACKUP_FILE = "/var/backups/mega-bingo-state.json";
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const WEB_APP_URL = (process.env.WEB_APP_URL || "https://konjobetcom.et/mega/").replace(/\/+$/, "") + "/";
const rawAdminUsernames = process.env.ADMIN_USERNAMES || "admin,helen,samtesfa19,765609989,8722398377,5663531258";
const ADMIN_USERNAMES = rawAdminUsernames.split(",").map((u) => u.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);
const rawAdminIds = process.env.ADMIN_TELEGRAM_IDS || "765609989,8722398377,5663531258";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Ber343477";
const ADMIN_IDS = rawAdminIds.split(",").map((id) => id.trim()).filter(Boolean);

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

// Initial state with 10 ETB default starting bonus
const DEFAULT_STATE = {
  rooms: [
    { id: "10", stake: 10, name: "10 No 1", players: 0, status: "waiting", roundId: "#MB-101", prizePool: 0, called: [] },
    { id: "10-2", stake: 10, name: "10 No 2", players: 0, status: "waiting", roundId: "#MB-102", prizePool: 0, called: [] },
    { id: "20", stake: 20, name: "20 No 1", players: 0, status: "waiting", roundId: "#MB-103", prizePool: 0, called: [] },
    { id: "50", stake: 50, name: "50 No 1", players: 0, status: "waiting", roundId: "#MB-104", prizePool: 0, called: [] },
  ],
  settings: {
    countdown: 30,
    commissionRate: 20,
    minDeposit: 50,
    depositBonus: 20,
    bonusThreshold: 100,
    startingBonus: 0,
    startingBonusEnabled: false,
    depositTelebirrPhone: "0941434534",
    depositTelebirrName: "helen",
    depositCbeBirrPhone: "",
    depositCbeBirrName: "",
    depositMpesaPhone: "",
    depositMpesaName: "",
  },
  metrics: {
    totalPlayers: 0,
    verifiedPlayers: 0,
    processedToday: 0,
  },
  users: {},
  transactions: [],
  usedDepositReferences: {},
  roundHistory: [],
};

let gameState = DEFAULT_STATE;

const BLACKLISTED_DEPOSIT_TOKENS = new Set([
  // Admin recipient phones & variations
  "0941434534", "251941434534", "941434534", "+251941434534",
  // Names
  "HELEN", "ሄለን", "MEGA", "BINGO",
  // Common URLs, domains & protocols
  "HTTP", "HTTPS", "WWW", "COM", "ET", "MBRECIEPT", "ETHIOTELECOM",
  "TRANSACTIONINFO", "RECEIPT", "FORMS", "GLE", "FORMS.GLE",
  // Common English SMS words and bank terms
  "CUSTOMER", "TRANSFERRED", "TRANSACTION", "COMPLETED", "SUCCESSFUL",
  "SUCCESSFULLY", "DEPOSITED", "CONFIRMED", "PAYMENT", "ACCOUNT",
  "TELEBIRR", "SERVICE", "TRANSFER", "RECEIVED", "BALANCE", "TELECOM",
  "ETHIOTELECOM", "COMMERCIAL", "DEAR", "YOUR", "HAVE", "WITH", "FROM", "FOR",
  "NUMBER", "RECOVERY", "DISASTER", "BANKING", "FEEDBACK", "CHARGE", "CURRENT",
  "ETHIOPIA", "INVOICE", "BRANCH", "REMARK", "REMARKS", "TOTAL", "AMOUNT", "VAT",
  "THANK", "THANKS", "USING", "CLICK", "LINK", "DOWNLOAD", "MONEY", "E-MONEY",
  "BIRR", "ETB"
]);

const COMMON_SMS_WORDS = BLACKLISTED_DEPOSIT_TOKENS;

function isInvalidTxCode(code) {
  if (!code || typeof code !== "string") return true;
  const s = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length < 5 || s.length > 36) return true;
  if (BLACKLISTED_DEPOSIT_TOKENS.has(s)) return true;
  // Pure digits: account numbers or phone numbers or amounts
  if (/^\d+$/.test(s)) {
    if (/^1000\d{8,10}$/.test(s)) return true; // CBE accounts
    if (/^(?:251|0)?[79]\d{8}$/.test(s)) return true; // Phone numbers
    if (s.length <= 8) return true; // short numbers like amounts
    return true; // Any pure numeric code is unsafe to treat as unique tx id without letters!
  }
  // Pure letters: dictionary words
  if (/^[A-Z]+$/.test(s)) return true;
  return false;
}

function extractTxCodes(text) {
  if (!text || typeof text !== "string") return [];
  const trimmed = text.trim();
  const codes = new Set();

  // If user entered a single code directly
  if (!trimmed.includes(" ") && !trimmed.includes("\n")) {
    const cleanSingle = trimmed.toUpperCase().replace(/[^A-Z0-9_-]/g, "").replace(/^V2-/, "");
    if (!isInvalidTxCode(cleanSingle)) {
      codes.add(cleanSingle);
    }
  }

  // 1. CBE Receipt URL: mbreciept.cbe.com.et/(?:v2-)?([a-zA-Z0-9]{8,36})
  const cbeUrlPattern = /mbreciept\.cbe\.com\.et\/(?:v2-)?([a-zA-Z0-9]{8,36})/gi;
  let cbeMatch;
  while ((cbeMatch = cbeUrlPattern.exec(trimmed)) !== null) {
    if (cbeMatch[1]) {
      const code = cbeMatch[1].toUpperCase().replace(/^V2-/, "");
      if (!isInvalidTxCode(code)) codes.add(code);
    }
  }

  // 2. Telebirr Receipt URL: transactioninfo.ethiotelecom.et/receipt/([a-zA-Z0-9]{6,25})
  const tbUrlPattern = /transactioninfo\.ethiotelecom\.et\/receipt\/([a-zA-Z0-9]{6,25})/gi;
  let tbMatch;
  while ((tbMatch = tbUrlPattern.exec(trimmed)) !== null) {
    if (tbMatch[1] && !isInvalidTxCode(tbMatch[1])) {
      codes.add(tbMatch[1].toUpperCase());
    }
  }

  // 3. Telebirr Txn Number (DK...): DKK4FHLW0E, DKL5GJ0C0D, etc.
  const tbCodePattern = /\b(DK[A-HJ-NP-Z0-9]{8,15})\b/gi;
  let tbCodeMatch;
  while ((tbCodeMatch = tbCodePattern.exec(trimmed)) !== null) {
    if (tbCodeMatch[1] && !isInvalidTxCode(tbCodeMatch[1])) {
      codes.add(tbCodeMatch[1].toUpperCase());
    }
  }

  // 4. CBE FT code: FT24... or TXN...
  const cbeFtPattern = /\b(FT\d{8,22}[A-Z0-9]*)\b/gi;
  let cbeFtMatch;
  while ((cbeFtMatch = cbeFtPattern.exec(trimmed)) !== null) {
    if (cbeFtMatch[1] && !isInvalidTxCode(cbeFtMatch[1])) {
      codes.add(cbeFtMatch[1].toUpperCase());
    }
  }

  // 5. Keyword patterns with label prefixes
  const keywordPatterns = [
    /(?:trans(?:action)?\.?\s*(?:id|no|number|num)?[:\s]+)([a-zA-Z0-9_-]{5,32})/gi,
    /(?:txn\s*(?:id|no|num)?[:\s]+)([a-zA-Z0-9_-]{5,32})/gi,
    /(?:ref(?:\.|erence)?[:\s]+)([a-zA-Z0-9_-]{5,32})/gi,
    /(?:fs\s*no[:\s]+)([a-zA-Z0-9_-]{5,32})/gi,
    /(?:የግብይት\s*(?:መለያ|ቁጥር)?[:\s]+)([a-zA-Z0-9_-]{5,32})/gi,
    /(?:የሂሳብ\s*እንቅስቃሴ\s*ቁጥር(?:ዎ)?[:\s]+)([a-zA-Z0-9_-]{5,32})/gi,
  ];
  for (const pat of keywordPatterns) {
    let match;
    while ((match = pat.exec(trimmed)) !== null) {
      if (match[1]) {
        const c = match[1].trim().toUpperCase().replace(/^V2-/, "");
        if (!isInvalidTxCode(c)) {
          codes.add(c);
        }
      }
    }
  }

  // 6. Alphanumeric token fallback (must have >= 2 letters AND >= 2 digits, length 8..32)
  const tokenMatches = trimmed.match(/\b([A-Za-z0-9_-]{8,32})\b/g);
  if (tokenMatches) {
    for (const rawToken of tokenMatches) {
      const token = rawToken.toUpperCase().replace(/^V2-/, "");
      const letters = (token.match(/[A-Z]/g) || []).length;
      const digits = (token.match(/\d/g) || []).length;
      if (letters >= 2 && digits >= 2 && !isInvalidTxCode(token)) {
        codes.add(token);
      }
    }
  }

  return Array.from(codes);
}

function seedInitialRoundHistory() {
  const seeded = [];
  const now = Date.now();
  const DAY_MS = 86400 * 1000;
  const userNames = Object.values(gameState?.users || {})
    .map((u) => u.first_name || u.username)
    .filter(Boolean);
  const fallbackNames = [
    "Almaz T.", "Dawit K.", "Selam G.", "Kalkidan E.", "Yonas B.",
    "Betelehem M.", "Henok A.", "Marta S.", "Ephrem T.", "Tigist D.",
    "Samuel T.", "Rahel F.", "Natnael Z.", "Tsion W.", "Abebe B.",
    "Amanuel D.", "Fikru M.", "Genet B.", "Haile K.", "Kidus T."
  ];
  const namePool = userNames.length >= 5 ? userNames : fallbackNames;

  let roundSeq = 100;
  for (let d = 13; d >= 0; d--) {
    const dayStart = new Date(now - d * DAY_MS);
    dayStart.setHours(9, 0, 0, 0);
    const dayStartTime = dayStart.getTime();

    // 10 ETB room
    const r10Count = 22 + Math.floor(Math.sin(d * 1.5) * 5 + Math.random() * 8);
    for (let i = 0; i < r10Count; i++) {
      roundSeq++;
      const rTime = dayStartTime + Math.floor((i / r10Count) * 14 * 3600 * 1000) + Math.floor(Math.random() * 30000);
      if (rTime > now) break;
      const cards = 7 + Math.floor(Math.random() * 11);
      const turnover = cards * 10;
      const prize = cards <= 5 ? turnover : Math.round(turnover * 0.8);
      const profit = turnover > prize ? (turnover - prize) : Math.round(turnover * 0.20);
      const winner = namePool[Math.floor(Math.random() * namePool.length)];
      seeded.push({
        id: `RND_10_${roundSeq}`,
        roomId: "10",
        stake: 10,
        roundId: roundSeq,
        totalCards: cards,
        playerCount: Math.min(cards, 3 + Math.floor(Math.random() * 4)),
        turnover,
        prize,
        profit,
        winnerId: `usr_${roundSeq}`,
        winnerName: winner,
        cardId: Math.floor(Math.random() * 50) + 1,
        pattern: "1 መስመር",
        created_at: new Date(rTime).toISOString(),
        timestamp: rTime,
      });
    }

    // 20 ETB room
    const r20Count = 14 + Math.floor(Math.cos(d * 1.2) * 4 + Math.random() * 6);
    for (let i = 0; i < r20Count; i++) {
      roundSeq++;
      const rTime = dayStartTime + Math.floor((i / r20Count) * 14 * 3600 * 1000) + Math.floor(Math.random() * 30000);
      if (rTime > now) break;
      const cards = 6 + Math.floor(Math.random() * 9);
      const turnover = cards * 20;
      const prize = cards <= 5 ? turnover : Math.round(turnover * 0.8);
      const profit = turnover > prize ? (turnover - prize) : Math.round(turnover * 0.20);
      const winner = namePool[Math.floor(Math.random() * namePool.length)];
      seeded.push({
        id: `RND_20_${roundSeq}`,
        roomId: "20",
        stake: 20,
        roundId: roundSeq,
        totalCards: cards,
        playerCount: Math.min(cards, 3 + Math.floor(Math.random() * 3)),
        turnover,
        prize,
        profit,
        winnerId: `usr_${roundSeq}`,
        winnerName: winner,
        cardId: Math.floor(Math.random() * 50) + 1,
        pattern: "1 መስመር",
        created_at: new Date(rTime).toISOString(),
        timestamp: rTime,
      });
    }

    // 50 ETB room
    const r50Count = 5 + Math.floor(Math.random() * 5);
    for (let i = 0; i < r50Count; i++) {
      roundSeq++;
      const rTime = dayStartTime + Math.floor((i / r50Count) * 14 * 3600 * 1000) + Math.floor(Math.random() * 30000);
      if (rTime > now) break;
      const cards = 4 + Math.floor(Math.random() * 6);
      const turnover = cards * 50;
      const prize = cards <= 5 ? turnover : Math.round(turnover * 0.8);
      const profit = turnover > prize ? (turnover - prize) : Math.round(turnover * 0.20);
      const winner = namePool[Math.floor(Math.random() * namePool.length)];
      seeded.push({
        id: `RND_50_${roundSeq}`,
        roomId: "50",
        stake: 50,
        roundId: roundSeq,
        totalCards: cards,
        playerCount: Math.min(cards, 2 + Math.floor(Math.random() * 3)),
        turnover,
        prize,
        profit,
        winnerId: `usr_${roundSeq}`,
        winnerName: winner,
        cardId: Math.floor(Math.random() * 50) + 1,
        pattern: "1 መስመር",
        created_at: new Date(rTime).toISOString(),
        timestamp: rTime,
      });
    }
  }

  seeded.sort((a, b) => a.timestamp - b.timestamp);
  return seeded;
}

function loadGameState() {
  try {
    let fileData = null;
    if (fs.existsSync(STATE_FILE)) {
      try {
        fileData = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      } catch (err) {
        console.warn("[STATE] Corrupt game-state.json:", err.message);
      }
    }

    // Always merge users from persistent backup files so git resets cannot wipe balances
    let backupUsers = {};
    let backupTxns = [];
    let backupRounds = [];
    [BACKUP_STATE_FILE, ROOT_BACKUP_FILE].forEach((bp) => {
      try {
        if (fs.existsSync(bp)) {
          const parsed = JSON.parse(fs.readFileSync(bp, "utf-8"));
          if (parsed && parsed.users && Object.keys(parsed.users).length > Object.keys(backupUsers).length) {
            backupUsers = parsed.users;
            backupTxns = parsed.transactions || [];
            if (Array.isArray(parsed.roundHistory) && parsed.roundHistory.length > 0) {
              backupRounds = parsed.roundHistory;
            }
          }
        }
      } catch (e) {}
    });

    const mergedUsers = {
      ...backupUsers,
      ...(fileData?.users || {}),
    };

    const allowedAdminIds = new Set(["765609989", "8722398377", "5663531258", "admin-1", ...(typeof ADMIN_IDS !== "undefined" ? ADMIN_IDS : [])]);
    for (const [uid, u] of Object.entries(mergedUsers)) {
      if (u && (u.role === "admin" || String(uid).startsWith("8888") || uid === "9029759446" || uid === "8934661197" || uid === "946983694")) {
        if (!allowedAdminIds.has(String(uid))) {
          delete mergedUsers[uid];
        }
      }
    }

    const mergedTxns = (fileData?.transactions && fileData.transactions.length > 0)
      ? fileData.transactions
      : (backupTxns.length > 0 ? backupTxns : []);

    const mergedRounds = (fileData?.roundHistory && fileData.roundHistory.length > 0)
      ? fileData.roundHistory
      : (backupRounds.length > 0 ? backupRounds : []);

    const cleanedRegistry = {};
    for (const [k, v] of Object.entries(fileData?.usedDepositReferences || {})) {
      if (!isInvalidTxCode(k)) {
        cleanedRegistry[k] = v;
      }
    }

    gameState = {
      ...DEFAULT_STATE,
      ...(fileData || {}),
      settings: {
        ...DEFAULT_STATE.settings,
        ...(fileData?.settings || {}),
        countdown: 30,
        startingBonus: 0,
        startingBonusEnabled: false,
        depositTelebirrPhone: fileData?.settings?.depositTelebirrPhone || "0941434534",
        depositTelebirrName: fileData?.settings?.depositTelebirrName || "helen",
        depositCbeBirrPhone: fileData?.settings?.depositCbeBirrPhone || "",
        depositCbeBirrName: fileData?.settings?.depositCbeBirrName || "",
      },
      users: mergedUsers,
      transactions: mergedTxns,
      roundHistory: mergedRounds,
      usedDepositReferences: cleanedRegistry,
    };

    if (!Array.isArray(gameState.roundHistory) || gameState.roundHistory.length === 0) {
      gameState.roundHistory = seedInitialRoundHistory();
      saveGameState();
    }

    if (Array.isArray(gameState.transactions)) {
      for (const tx of gameState.transactions) {
        if (tx.type === "deposit" || tx.reference) {
          const rawRef = String(tx.reference || "").trim();
          if (rawRef) {
            const rawUpper = rawRef.replace(/\s+/g, " ").toUpperCase();
            if (rawUpper.length >= 50 && !isInvalidTxCode(rawUpper)) {
              if (!gameState.usedDepositReferences[rawUpper]) {
                gameState.usedDepositReferences[rawUpper] = { txId: tx.id, at: tx.created_at || "" };
              }
            }
            const codes = extractTxCodes(rawRef);
            for (const c of codes) {
              if (!isInvalidTxCode(c) && !gameState.usedDepositReferences[c]) {
                gameState.usedDepositReferences[c] = { txId: tx.id, at: tx.created_at || "" };
              }
            }
          }
        }
      }
    }

    if (Object.keys(backupUsers).length > Object.keys(fileData?.users || {}).length) {
      console.log(`[STATE] Auto-recovered ${Object.keys(backupUsers).length} users from backup!`);
      saveGameState();
    }
  } catch (e) {
    console.warn("Failed to load game-state.json:", e.message);
  }
}

function saveGameState() {
  try {
    const jsonStr = JSON.stringify(gameState, null, 2);
    fs.writeFileSync(STATE_FILE, jsonStr, "utf-8");

    // Write persistent backup whenever we have users to ensure durability
    if (gameState.users && Object.keys(gameState.users).length > 0) {
      try { fs.writeFileSync(BACKUP_STATE_FILE, jsonStr, "utf-8"); } catch (e) {}
      try { fs.writeFileSync(ROOT_BACKUP_FILE, jsonStr, "utf-8"); } catch (e) {}
    }
  } catch (e) {
    console.warn("Failed to save game-state.json:", e.message);
  }
}


// Synchronize registered users from SQLite lucky_bingo.db / players.json
let lastDbSyncTime = 0;

function cleanPhone(p) {
  if (!p) return "";
  let phone = String(p).trim().replace(/[\s\-()]+/g, "");
  if (phone.startsWith("+251")) phone = "0" + phone.slice(4);
  else if (phone.startsWith("251")) phone = "0" + phone.slice(3);
  else if (phone.startsWith("9") && phone.length === 9) phone = "0" + phone;
  else if (phone.startsWith("7") && phone.length === 9) phone = "0" + phone;
  return phone;
}

function updateSqliteUserBalance(userId, newBalance) {
  try {
    const { execFile } = require("child_process");
    const numBal = Math.max(0, Math.round(Number(newBalance) * 100) / 100);
    const cleanId = String(userId).trim();
    const helperPath = path.join(__dirname, "db_helper.py");

    execFile("python3", [helperPath, "update_balance", cleanId, String(numBal)], (err, stdout) => {
      if (err) console.warn("[DB] Failed to update balance in SQLite:", err.message);
    });
  } catch (e) {
    console.warn("[DB] SQLite balance update error:", e.message);
  }
}

function recordSqliteTransaction(txId, userId, type, method, amount, phone, status = "pending") {
  try {
    const { execFile } = require("child_process");
    const helperPath = path.join(__dirname, "db_helper.py");
    execFile("python3", [helperPath, "insert_transaction", String(txId), String(userId), String(type), String(method), String(amount), String(phone), String(status)], (err, stdout) => {
      if (err) console.warn("[DB] Failed to insert transaction into SQLite:", err.message);
    });
  } catch (e) {
    console.warn("[DB] SQLite transaction insert error:", e.message);
  }
}

function updateSqliteTransactionStatus(txId, status) {
  try {
    const { execFile } = require("child_process");
    const helperPath = path.join(__dirname, "db_helper.py");
    execFile("python3", [helperPath, "update_tx_status", String(txId), String(status)], (err, stdout) => {
      if (err) console.warn("[DB] Failed to update transaction status in SQLite:", err.message);
    });
  } catch (e) {
    console.warn("[DB] SQLite transaction status update error:", e.message);
  }
}

function syncFromSQLite(force = false) {
  const now = Date.now();
  if (!force && now - lastDbSyncTime < 15000) return;
  lastDbSyncTime = now;

  let updated = false;

  // 1. Fix user 9266193525 (who entered their phone 0939292694 in the Name field)
  if (gameState.users["9266193525"]) {
    const u = gameState.users["9266193525"];
    if (u.phone === "1234567890" || u.name === "0939292694" || u.first_name === "0939292694") {
      u.phone = "0939292694";
      u.username = "0939292694";
      u.first_name = "Player 2694";
      u.name = "Player 2694";
      updated = true;
    }
  }

  // 2. Read mega_bingo.db via python
  const dbPaths = [
    path.join(__dirname, "data", "mega_bingo.db"),
    "/var/www/mega-bingo/data/mega_bingo.db",
  ];
  const dbPath = dbPaths.find((p) => fs.existsSync(p));

  if (dbPath) {
    try {
      const { execSync } = require("child_process");
      const pyExec = process.platform === "win32" ? "python" : "python3";
      const safeDbPath = dbPath.replace(/\\/g, "/");
      const pyCmd = `${pyExec} -c "import sqlite3, json; conn = sqlite3.connect('${safeDbPath}'); conn.row_factory = sqlite3.Row; c = conn.cursor(); rows = [dict(r) for r in c.execute('SELECT * FROM users').fetchall()]; print(json.dumps(rows))"`;
      const out = execSync(pyCmd, { encoding: "utf-8", timeout: 4000 });
      const dbUsers = JSON.parse(out);

      for (const r of dbUsers) {
        const uid = String(r.id);
        const uname = String(r.username || "").trim();
        const fname = String(r.first_name || "").trim();
        const lname = String(r.last_name || "").trim();
        const fullName = [fname, lname].filter(Boolean).join(" ") ||
          (uname ? (uname.startsWith("@") ? uname : "@" + uname) : `Player ${uid.slice(-4)}`);

        let phone = String(r.phone_number || "").trim().replace(/[\s\-()]+/g, "");
        if (!phone && (/^(?:\+251|251|0)?[97]\d{8}$/.test(uname))) {
          phone = uname;
        }
        if (phone.startsWith("+251")) phone = "0" + phone.slice(4);
        else if (phone.startsWith("251")) phone = "0" + phone.slice(3);
        else if (phone.startsWith("9") && phone.length === 9) phone = "0" + phone;
        else if (phone.startsWith("7") && phone.length === 9) phone = "0" + phone;

        if (!gameState.users[uid]) {
          gameState.users[uid] = {
            id: uid,
            phone: phone || null,
            username: uname || uid,
            first_name: fullName,
            name: fullName,
            password: "",
            avatar: "TG",
            balance: Number(r.balance) || 0,
            bonus_balance: Number(r.bonus_balance) || 0,
            bonus_claimed: Number(r.bonus_claimed) || 1,
            role: r.role || "player",
            is_verified: Number(r.is_verified) || 1,
            status: r.status || "active",
            created_at: r.registered_at || new Date().toISOString(),
            source: "telegram",
          };
          updated = true;
        } else {
          const dbBal = Number(r.balance) || 0;
          if (dbBal > Number(gameState.users[uid].balance || 0)) {
            gameState.users[uid].balance = dbBal;
            updated = true;
          }
          if (phone && (!gameState.users[uid].phone || gameState.users[uid].phone === uid)) {
            gameState.users[uid].phone = phone;
            updated = true;
          }
          if (!gameState.users[uid].first_name || gameState.users[uid].first_name.startsWith("@")) {
            if (fullName && !fullName.startsWith("@")) {
              gameState.users[uid].first_name = fullName;
              gameState.users[uid].name = fullName;
              updated = true;
            }
          }
        }
      }
    } catch (err) {
      console.warn("[STATE] Error reading lucky_bingo.db:", err.message);
    }
  }

  // 3. Fallback: Also check players.json if present
  const playersJsonPaths = [
    path.join(__dirname, "data", "players.json"),
  ];
  const pJsonPath = playersJsonPaths.find((p) => fs.existsSync(p));
  if (pJsonPath) {
    try {
      const pData = JSON.parse(fs.readFileSync(pJsonPath, "utf-8"));
      const pList = pData.players || [];
      for (const p of pList) {
        const uid = String(p.userId || p.id).replace(/^TG-/, "");
        if (!gameState.users[uid]) {
          let phone = String(p.phone || "").trim();
          if (phone === "N/A" || phone === "—") phone = "";
          gameState.users[uid] = {
            id: uid,
            phone: phone || null,
            username: String(p.username || "").replace(/^@/, ""),
            first_name: p.name || `Player ${uid.slice(-4)}`,
            name: p.name || `Player ${uid.slice(-4)}`,
            password: "",
            avatar: "TG",
            balance: Number(p.balance) || 0,
            bonus_balance: 0,
            bonus_claimed: 1,
            role: "player",
            is_verified: 1,
            status: p.status || "active",
            created_at: new Date().toISOString(),
            source: "telegram",
          };
          updated = true;
        }
      }
    } catch (e) {}
  }

  if (updated) {
    saveGameState();
    console.log(`[STATE] Synchronized users from external DB/JSON. Total users: ${Object.keys(gameState.users).length}`);
  }
}

loadGameState();
syncFromSQLite(true);

// Load 1000 bingo cards from card number.json
const CARDS_FILE = path.join(__dirname, "card number.json");
let cardCatalog = {};
try {
  if (fs.existsSync(CARDS_FILE)) {
    cardCatalog = JSON.parse(fs.readFileSync(CARDS_FILE, "utf-8"));
  }
} catch (e) {
  console.warn("Failed to load card number.json:", e.message);
}

// 13 Bingo lines on 5x5 card (index 12 is FREE): 5 rows, 5 cols, 2 diagonals, 1 four-corners
const WINNING_LINES = [
  [0, 1, 2, 3, 4],
  [5, 6, 7, 8, 9],
  [10, 11, 12, 13, 14],
  [15, 16, 17, 18, 19],
  [20, 21, 22, 23, 24],
  [0, 5, 10, 15, 20],
  [1, 6, 11, 16, 21],
  [2, 7, 12, 17, 22],
  [3, 8, 13, 18, 23],
  [4, 9, 14, 19, 24],
  [0, 6, 12, 18, 24],
  [4, 8, 12, 16, 20],
  [0, 4, 20, 24], // 4 Corners (4 ማዕዘን / 4 Corner)
];

const BINGO_PATTERNS = [
  { id: "1_line", name: "1 መስመር", targetLines: 1, label: "1 መስመር ዝግ", description: "1 መስመር ሲዘጋ" }
];

const HABESHA_NAMES = [
  "Abebe T.", "Dawit K.", "Tigist M.", "Kalkidan E.", "Bereket F.",
  "Selamawit T.", "Yohannes A.", "Samuel G.", "Sara B.", "Henok L.",
  "Meron K.", "Feven M.", "Natnael D.", "Eden W.", "Eyob T.",
  "Bethlehem D.", "Robel H.", "Hanan S.", "Alazar B.", "Hiwot Z.",
  "Daniel M.", "Tsion A.", "Binyam Y.", "Marta G.", "Solomon K.",
  "Nahom E.", "Lidia S.", "Abel D.", "Rahel T.", "Ermias B.",
  "Sosina H.", "Fitsum T.", "Genet A.", "Kirubel A.", "Desta W.",
  "Meseret T.", "Tamirat B.", "Eyerusalem W.", "Girma A.", "Senait K.",
  "Kassahun M.", "Danait G.", "Mulugeta T.", "Blen S.", "Fikirte N.",
  "Hermela A.", "Zelalem F.", "Amanuel G.", "Aster T.", "Getachew D.",
  "Worku B.", "Tewodros K.", "Helen S.", "Mahlet T.", "Elias M.",
  "Nebiyu A.", "Saron T.", "Biruk D.", "Rediet M.", "Yared B."
];

function getCardCompletedLines(cardNumbers, calledSet) {
  if (!Array.isArray(cardNumbers) || cardNumbers.length !== 25) return [];
  const lines = [];
  for (const line of WINNING_LINES) {
    if (line.every((idx) => idx === 12 || cardNumbers[idx] === 0 || cardNumbers[idx] === "FREE" || calledSet.has(Number(cardNumbers[idx])))) {
      lines.push(line);
    }
  }
  return lines;
}

function countCompletedLines(cardNumbers, calledSet) {
  return getCardCompletedLines(cardNumbers, calledSet).length;
}

function getCardWinningKind(cardNumbers, calledSet) {
  const completed = getCardCompletedLines(cardNumbers, calledSet);
  if (!completed.length) return null;
  const onlyCorners = completed.length === 1 && completed[0].length === 4;
  return onlyCorners ? "4 Corner" : "1 መስመር";
}

function cardHasWinningLineWithBall(cardNumbers, calledSet, lastBall) {
  if (!Array.isArray(cardNumbers) || cardNumbers.length !== 25) return false;
  const lines = getCardCompletedLines(cardNumbers, calledSet);
  if (!lines.length) return false;
  if (lastBall == null) return lines.length >= 1;
  const targetNum = Number(lastBall);
  // Ensure the completed winning line specifically contains the last called ball
  return lines.some((line) => line.some((idx) => idx !== 12 && Number(cardNumbers[idx]) === targetNum));
}

function checkCardBingo(cardNumbers, calledSet, pattern, lastBall = null) {
  if (!Array.isArray(cardNumbers) || cardNumbers.length !== 25) return false;
  if (lastBall != null) {
    return cardHasWinningLineWithBall(cardNumbers, calledSet, lastBall);
  }
  return countCompletedLines(cardNumbers, calledSet) >= 1;
}

class LiveBingoRoom {
  constructor(id, stake) {
    this.id = String(id);
    this.stake = Number(stake);
    this.status = "open"; // "open", "countdown", "live", "ended"
    this.roundId = 100 + (parseInt(id) || 10) + (String(id).includes("-2") ? 1 : 0);
    this.patternIndex = 0;
    this.players = []; // [{ user_id, username, first_name, card_ids: [1, 2], is_bot, joined_at }]
    this.calls = []; // [14, 55, ...]
    this.deck = [];
    this.countdownEndsAt = 0;
    this.callIntervalMs = 3500;
    this.callTimer = null;
    this.countdownTimer = null;
    this.botJoinTimer = null;
    this.targetBotCards = 0;
    this.availableBotNames = [];
    this.botNameIndex = 0;
    this.lastResult = null;
    this.enabled = true;
    if (this.id === "20") {
      this.initBotRound();
      this.startCountdown();
    }
  }

  getEthiopianScheduleTarget() {
    let hour = 12;
    try {
      const eatHourStr = new Date().toLocaleTimeString("en-US", {
        timeZone: "Africa/Addis_Ababa",
        hour: "2-digit",
        hour12: false,
      });
      hour = parseInt(eatHourStr, 10);
      if (isNaN(hour)) {
        hour = (new Date().getUTCHours() + 3) % 24;
      }
    } catch (e) {
      hour = (new Date().getUTCHours() + 3) % 24;
    }

    let minDerash = 600;
    let maxDerash = 800;
    let slotName = "ጧት 12:00 - 4:00";

    // Ethiopian Time Schedule:
    // 1. ጧት 12:00 እስከ 4:00 (06:00 - 10:00 EAT): 600 - 800 derash
    // 2. ከ 4:00 እስከ 8:00 (10:00 - 14:00 EAT): 1,500 - 1,700 derash
    // 3. ከ 8:00 እስከ ለሊት 6:00 (14:00 - 00:00 EAT): 2,400 - 2,600 derash
    // 4. ከለሊቱ 6:00 እስከ ጧት 12:00 (00:00 - 06:00 EAT): 300 - 400 derash
    if (hour >= 6 && hour < 10) {
      minDerash = 600;
      maxDerash = 800;
      slotName = "ጧት 12:00 - 4:00";
    } else if (hour >= 10 && hour < 14) {
      minDerash = 1500;
      maxDerash = 1700;
      slotName = "ከ 4:00 - 8:00";
    } else if (hour >= 14 && hour < 24) {
      minDerash = 2400;
      maxDerash = 2600;
      slotName = "ከ 8:00 - ለሊት 6:00";
    } else {
      minDerash = 300;
      maxDerash = 400;
      slotName = "ለሊት 6:00 - ጧት 12:00";
    }

    // Pick random target derash in the time slot range
    const targetDerash = Math.floor(Math.random() * (maxDerash - minDerash + 1)) + minDerash;
    const commPct = Number(gameState.settings?.commissionRate || 20);
    const cardValue = Math.max(1, this.stake * (1 - (commPct / 100)));
    const targetCards = Math.max(5, Math.round(targetDerash / cardValue));

    return { minDerash, maxDerash, targetDerash, targetCards, slotName, hour };
  }

  initBotRound() {
    if (this.botJoinTimer) {
      clearInterval(this.botJoinTimer);
      this.botJoinTimer = null;
    }
    const isBotRoom = this.id === "20" || (gameState.settings?.systemBotsRooms && gameState.settings.systemBotsRooms.includes(this.id));
    if (!isBotRoom) return;

    const schedule = this.getEthiopianScheduleTarget();
    this.targetBotCards = schedule.targetCards;
    this.currentSlotName = schedule.slotName;

    this.availableBotNames = [...HABESHA_NAMES].sort(() => Math.random() - 0.5);
    this.botNameIndex = 0;

    // Retain only real players, wipe old bots
    this.players = this.players.filter(p => !p.is_bot);

    // Initial small seed: 2 to 4 cards at second 30 so cards start low and grow gradually
    const seedCount = Math.min(this.targetBotCards, Math.floor(Math.random() * 3) + 2);
    this.addBotPlayersWithCards(seedCount);
  }

  addBotPlayersWithCards(count) {
    if (count <= 0) return;
    const existingCards = new Set();
    for (const p of this.players) {
      for (const cid of (p.card_ids || [])) existingCards.add(Number(cid));
    }

    const catalogKeys = Object.keys(cardCatalog);
    const maxCatalogId = catalogKeys.length > 0 ? catalogKeys.length : 1000;
    const available = [];
    for (let i = 1; i <= maxCatalogId; i++) {
      if (!existingCards.has(i)) available.push(i);
    }

    for (let i = available.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [available[i], available[j]] = [available[j], available[i]];
    }

    const selectedCards = available.slice(0, count);
    if (!selectedCards.length) return;

    let cardIdx = 0;
    while (cardIdx < selectedCards.length) {
      const take = Math.min(selectedCards.length - cardIdx, Math.floor(Math.random() * 3) + 1);
      const bCards = selectedCards.slice(cardIdx, cardIdx + take);
      const botName = this.availableBotNames[this.botNameIndex % this.availableBotNames.length];
      this.botNameIndex++;

      this.players.push({
        user_id: `bot_${this.id}_${this.botNameIndex}_${this.roundId}`,
        username: "",
        first_name: botName,
        card_ids: bCards,
        is_bot: true,
        joined_at: new Date().toISOString(),
      });

      cardIdx += take;
    }
  }

  startGradualBotJoins() {
    if (this.botJoinTimer) clearInterval(this.botJoinTimer);
    const isBotRoom = this.id === "20" || (gameState.settings?.systemBotsRooms && gameState.settings.systemBotsRooms.includes(this.id));
    if (!isBotRoom) return;

    this.botJoinTimer = setInterval(() => {
      if (this.status !== "countdown") {
        clearInterval(this.botJoinTimer);
        this.botJoinTimer = null;
        return;
      }

      const timeLeft = Math.max(0, Math.ceil((this.countdownEndsAt - Date.now()) / 1000));
      const currentBotCards = this.players.filter(p => p.is_bot).reduce((sum, p) => sum + (p.card_ids?.length || 0), 0);
      const remaining = Math.max(0, this.targetBotCards - currentBotCards);

      if (timeLeft <= 1 || remaining <= 0) {
        if (remaining > 0 && timeLeft <= 2) {
          this.addBotPlayersWithCards(remaining);
        }
        clearInterval(this.botJoinTimer);
        this.botJoinTimer = null;
        return;
      }

      const rate = remaining / Math.max(1, timeLeft - 1);
      const jitter = (Math.random() * 1.6 - 0.8);
      const take = Math.max(1, Math.min(remaining, Math.round(rate + jitter)));
      this.addBotPlayersWithCards(take);
    }, 1200);
  }

  getDerash(totalCards) {
    if (totalCards <= 0) return this.stake;
    const pot = totalCards * this.stake;
    if (totalCards <= 5) {
      return pot; // Up to 5 registered cards: 0% commission (minm saykinse)
    }
    const commPct = Number(gameState.settings?.commissionRate || 20);
    return Math.max(this.stake, Math.round(pot * (1 - commPct / 100)));
  }

  get currentPattern() {
    return BINGO_PATTERNS[this.patternIndex % BINGO_PATTERNS.length];
  }

  get nextPattern() {
    return BINGO_PATTERNS[(this.patternIndex + 1) % BINGO_PATTERNS.length];
  }

  getState() {
    const now = Date.now();
    const cdEnds = this.countdownEndsAt;
    const cdRem = this.status === "countdown" && cdEnds > now ? Math.ceil((cdEnds - now) / 1000) : 0;
    const totalCards = this.players.reduce((sum, p) => sum + (p.card_ids?.length || 0), 0);
    const derash = this.getDerash(totalCards);

    return {
      room_id: this.id,
      id: this.id,
      stake: this.stake,
      status: this.status,
      round_id: this.roundId,
      pattern: this.currentPattern,
      next_pattern: this.nextPattern,
      countdown_ends_at: Math.floor(cdEnds / 1000),
      countdown_remaining: cdRem,
      server_time: Math.floor(now / 1000),
      players: this.status === "ended" ? [] : this.players,
      player_count: this.status === "ended" ? 0 : this.players.length,
      total_cards: this.status === "ended" ? 0 : totalCards,
      derash: this.status === "ended" ? this.stake : derash,
      calls: this.calls,
      last_result: this.lastResult,
      enabled: this.enabled,
    };
  }

  join(user, cardIds) {
    if (this.status === "live" || this.status === "ended") {
      return { error: "Game in progress, please wait" };
    }
    const cleanCardIds = Array.from(new Set(cardIds.map(Number))).filter(id => id >= 1 && id <= 1000);
    if (!cleanCardIds.length || cleanCardIds.length > 50) {
      return { error: "Choose up to 50 valid cartelas" };
    }

    const otherTaken = new Set();
    for (const p of this.players) {
      if (String(p.user_id) !== String(user.id)) {
        for (const cid of (p.card_ids || [])) otherTaken.add(cid);
      }
    }
    for (const cid of cleanCardIds) {
      if (otherTaken.has(cid)) {
        return { error: `Card #${cid} is already taken by another player` };
      }
    }

    if (!gameState.users[user.id]) {
      const bonus = Number(gameState.settings?.startingBonus != null && gameState.settings?.startingBonusEnabled ? gameState.settings.startingBonus : 0);
      gameState.users[user.id] = {
        id: user.id,
        username: user.username,
        first_name: user.name,
        phone: "",
        contactShared: false,
        balance: bonus,
        role: ADMIN_IDS.includes(String(user.id)) ? "admin" : "player",
        status: "active",
        createdAt: new Date().toISOString(),
      };
      saveGameState();
    }

    const existingPlayer = this.players.find(p => String(p.user_id) === String(user.id));
    const oldCards = existingPlayer ? (existingPlayer.card_ids || []) : [];
    const costDelta = (cleanCardIds.length - oldCards.length) * this.stake;

    const uRecord = gameState.users[user.id];
    const currentBal = Number(uRecord?.balance || 0);
    if (costDelta > 0 && currentBal < costDelta) {
      return { error: "Insufficient balance" };
    }

    if (uRecord && costDelta !== 0) {
      uRecord.balance = Math.max(0, currentBal - costDelta);
      saveGameState();
      updateSqliteUserBalance(user.id, uRecord.balance);
    }

    if (existingPlayer) {
      existingPlayer.card_ids = cleanCardIds;
      existingPlayer.joined_at = new Date().toISOString();
    } else {
      this.players.push({
        user_id: user.id,
        username: user.username || "",
        first_name: user.name || `Player ${String(user.id).slice(-4)}`,
        card_ids: cleanCardIds,
        joined_at: new Date().toISOString(),
      });
    }

    if (this.status === "open") {
      this.startCountdown();
    }

    return {
      ok: true,
      balance: uRecord ? uRecord.balance : 0,
      ...this.getState(),
    };
  }

  leave(userId) {
    const idx = this.players.findIndex(p => String(p.user_id) === String(userId));
    if (idx !== -1) {
      const p = this.players[idx];
      if (this.status !== "live" && this.status !== "ended") {
        const refund = (p.card_ids?.length || 0) * this.stake;
        const uRecord = gameState.users[userId];
        if (uRecord && refund > 0) {
          uRecord.balance = (uRecord.balance || 0) + refund;
          saveGameState();
          updateSqliteUserBalance(userId, uRecord.balance);
        }
      }
      this.players.splice(idx, 1);
      const hasRealPlayers = this.players.some(player => !player.is_bot);
      if (!hasRealPlayers && this.status === "countdown") {
        if (this.countdownTimer) clearTimeout(this.countdownTimer);
        this.status = "open";
        this.countdownEndsAt = 0;
      }
    }
    return { ok: true };
  }

  startCountdown() {
    this.status = "countdown";
    const durationSec = Math.max(10, Number(gameState.settings?.countdown || 30));
    this.countdownEndsAt = Date.now() + durationSec * 1000;

    this.startGradualBotJoins();

    if (this.countdownTimer) clearTimeout(this.countdownTimer);
    this.countdownTimer = setTimeout(() => {
      this.startLiveGame();
    }, durationSec * 1000);
  }

  startLiveGame() {
    if (this.botJoinTimer) {
      clearInterval(this.botJoinTimer);
      this.botJoinTimer = null;
    }
    const totalCards = this.players.reduce((sum, p) => sum + (p.card_ids?.length || 0), 0);
    if (totalCards === 0) {
      this.status = "open";
      this.countdownEndsAt = 0;
      this.calls = [];
      if (this.callTimer) clearInterval(this.callTimer);
      this.callTimer = null;
      return;
    }
    this.status = "live";
    this.countdownEndsAt = 0;
    this.calls = [];
    const nums = Array.from({ length: 75 }, (_, i) => i + 1);
    for (let i = nums.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [nums[i], nums[j]] = [nums[j], nums[i]];
    }
    this.deck = nums;

    const intervalSec = Number(gameState.settings?.call_interval || 3.5);
    this.callIntervalMs = Math.max(2000, Math.min(6000, Math.round(intervalSec * 1000)));

    if (this.callTimer) clearInterval(this.callTimer);
    this.callTimer = setInterval(() => {
      this.callNextBall();
    }, this.callIntervalMs);
  }

  callNextBall() {
    if (this.status !== "live") {
      if (this.callTimer) clearInterval(this.callTimer);
      return;
    }

    if (!this.deck.length) {
      this.endRoundNoWinner();
      return;
    }

    // In rooms with bots and real players, ensure system card wins
    const hasRealPlayers = this.players.some(p => !p.is_bot);
    const hasBots = this.players.some(p => p.is_bot);

    if (hasRealPlayers && hasBots && this.deck.length > 1) {
      const calledSet = new Set(this.calls);
      const realCards = [];
      const botCards = [];
      for (const p of this.players) {
        for (const cid of (p.card_ids || [])) {
          const cNums = cardCatalog[String(cid)];
          if (cNums) {
            if (p.is_bot) botCards.push(cNums);
            else realCards.push(cNums);
          }
        }
      }

      const testBall = this.deck[0];
      const testSet = new Set(calledSet);
      testSet.add(testBall);

      const realWins = realCards.some(cNums => cardHasWinningLineWithBall(cNums, testSet, testBall));
      const botWins = botCards.some(cNums => cardHasWinningLineWithBall(cNums, testSet, testBall));

      if (realWins && !botWins) {
        let swapIdx = -1;
        for (let i = 1; i < this.deck.length; i++) {
          const altBall = this.deck[i];
          const altSet = new Set(calledSet);
          altSet.add(altBall);
          if (!realCards.some(cNums => cardHasWinningLineWithBall(cNums, altSet, altBall))) {
            swapIdx = i;
            break;
          }
        }
        if (swapIdx !== -1) {
          const tmp = this.deck[0];
          this.deck[0] = this.deck[swapIdx];
          this.deck[swapIdx] = tmp;
        }
      }
    }

    const ball = this.deck.shift();
    this.calls.push(ball);

    const calledSet = new Set(this.calls);
    const winningEntries = [];

    // Find ALL players and cards that completed Bingo on THIS winning ball!
    for (const player of this.players) {
      for (const cardId of (player.card_ids || [])) {
        const cardNumbers = cardCatalog[String(cardId)];
        if (cardNumbers && cardHasWinningLineWithBall(cardNumbers, calledSet, ball)) {
          winningEntries.push({
            userId: player.user_id,
            username: player.username,
            firstName: player.first_name || player.username || `Player ${String(player.user_id).slice(-4)}`,
            cardId: cardId,
            winKind: getCardWinningKind(cardNumbers, calledSet) || "1 መስመር",
            isBot: Boolean(player.is_bot),
          });
        }
      }
    }

    if (winningEntries.length > 0) {
      this.endRoundWithWinners(winningEntries, ball);
      return;
    }
  }

  claimBingo(userId, cardId) {
    if (this.status !== "live") {
      return { error: "Game not in progress" };
    }
    const player = this.players.find(p => String(p.user_id) === String(userId));
    if (!player || !player.card_ids?.includes(Number(cardId))) {
      return { error: "Card not registered to you" };
    }

    const cardNumbers = cardCatalog[String(cardId)];
    const calledSet = new Set(this.calls);
    const lastBall = this.calls.length ? this.calls[this.calls.length - 1] : null;

    if (!cardNumbers || !cardHasWinningLineWithBall(cardNumbers, calledSet, lastBall)) {
      return { error: "Bingo not complete yet on the latest called number" };
    }

    // Collect all players/cards that completed bingo on this call
    const winningEntries = [];
    for (const p of this.players) {
      for (const cid of (p.card_ids || [])) {
        const cNums = cardCatalog[String(cid)];
        if (cNums && cardHasWinningLineWithBall(cNums, calledSet, lastBall)) {
          winningEntries.push({
            userId: p.user_id,
            username: p.username,
            firstName: p.first_name || p.username || `Player ${String(p.user_id).slice(-4)}`,
            cardId: cid,
            winKind: getCardWinningKind(cNums, calledSet) || "1 መስመር",
            isBot: Boolean(p.is_bot),
          });
        }
      }
    }

    this.endRoundWithWinners(winningEntries, lastBall);
    return { ok: true, winners: winningEntries.map(w => w.firstName), prize: this.lastResult?.prize };
  }

  endRoundWithWinners(winningEntries, winningCall) {
    if (this.callTimer) clearInterval(this.callTimer);
    this.callTimer = null;
    this.status = "ended";

    const totalCards = this.players.reduce((sum, p) => sum + (p.card_ids?.length || 0), 0);
    const turnover = totalCards * this.stake;
    const totalPrize = this.getDerash(totalCards);
    const profit = turnover > totalPrize ? (turnover - totalPrize) : Math.round(turnover * 0.20);

    if (!winningEntries || !winningEntries.length) {
      this.endRoundNoWinner(turnover, profit);
      return;
    }

    // Split prize equally among winning cards / players
    const winningCardCount = winningEntries.length;
    const prizePerCard = Math.floor(totalPrize / winningCardCount);

    // Group by user so if a player has multiple winning cards, they receive their full multiple share
    const userWinningMap = new Map();
    for (const entry of winningEntries) {
      const uid = String(entry.userId);
      if (!userWinningMap.has(uid)) {
        userWinningMap.set(uid, {
          userId: entry.userId,
          username: entry.username,
          firstName: entry.firstName,
          cardIds: [],
          winKinds: [],
          isBot: Boolean(entry.isBot || uid.startsWith("bot_")),
        });
      }
      const uObj = userWinningMap.get(uid);
      uObj.cardIds.push(entry.cardId);
      uObj.winKinds.push(entry.winKind);
    }

    // Distribute balance to each winner
    let totalCredited = 0;
    const winnersDetail = [];
    for (const [uid, uObj] of userWinningMap.entries()) {
      const playerPrize = prizePerCard * uObj.cardIds.length;
      uObj.prize = playerPrize;

      if (!uObj.isBot) {
        totalCredited += playerPrize;
        let u = gameState.users[uid];
        if (!u) {
          for (const [k, v] of Object.entries(gameState.users || {})) {
            if (v && (String(v.id) === uid || (v.phone && v.phone.endsWith(uid.slice(-9))))) {
              u = v;
              break;
            }
          }
        }
        if (u) {
          u.balance = (u.balance || 0) + playerPrize;
          u.games = (u.games || 0) + 1;
          saveGameState();
          updateSqliteUserBalance(u.id || uid, u.balance);
        }
      }
      winnersDetail.push({
        user_id: uid,
        name: uObj.firstName,
        card_ids: uObj.cardIds,
        prize: playerPrize,
        is_bot: uObj.isBot,
      });
    }

    const winnerNames = Array.from(userWinningMap.values()).map(u => u.firstName);
    const winnerIds = Array.from(userWinningMap.keys());
    const allCardIds = winningEntries.map(e => e.cardId);
    const allWinKinds = Array.from(new Set(winningEntries.map(e => e.winKind))).join(", ");
    const displayWinnerName = winnerNames.join(" & ");

    const patternLabel = allWinKinds || (this.currentPattern ? (this.currentPattern.label || this.currentPattern.name) : "1 መስመር");
    const resultId = `RES_${this.id}_R${this.roundId}_${Math.floor(Date.now() / 1000)}`;

    this.lastResult = {
      result_id: resultId,
      round_id: this.roundId,
      winner_id: winnerIds.join(","),
      winner_ids: winnerIds,
      winner_name: displayWinnerName,
      winner_names: winnerNames,
      prize: totalPrize,
      prize_per_winner: prizePerCard,
      card_id: allCardIds,
      card_ids: allCardIds,
      pattern: patternLabel,
      ended_at: Math.floor(Date.now() / 1000),
      winning_call: winningCall,
      winners: winnersDetail,
    };

    const realPlayers = (this.players || []).filter(p => !p.is_bot && !String(p.user_id).startsWith("bot_"));
    const realPlayerCards = realPlayers.reduce((sum, p) => sum + (p.card_ids?.length || 0), 0);
    const realPlayerStake = realPlayerCards * this.stake;
    const realWinners = winnersDetail.filter(w => !w.is_bot && !String(w.user_id).startsWith("bot_"));
    const realPlayerPayout = realWinners.reduce((sum, w) => sum + (Number(w.prize) || 0), 0);
    const realGameProfit = realPlayerStake - realPlayerPayout;

    if (totalCards > 0) {
      if (!Array.isArray(gameState.roundHistory)) gameState.roundHistory = [];
      const roundRecord = {
        id: resultId,
        roomId: this.id,
        stake: this.stake,
        roundId: this.roundId,
        totalCards: totalCards,
        realCards: realPlayerCards,
        realStake: realPlayerStake,
        realPayout: realPlayerPayout,
        realProfit: realGameProfit,
        playerCount: this.players.length,
        realPlayerCount: realPlayers.length,
        turnover: turnover,
        prize: totalPrize,
        profit: profit,
        winnerId: winnerIds.join(","),
        winnerName: displayWinnerName,
        cardId: allCardIds.join(", "),
        pattern: patternLabel,
        winningCall: winningCall,
        created_at: new Date().toISOString(),
        timestamp: Date.now(),
      };
      gameState.roundHistory.push(roundRecord);
      if (gameState.roundHistory.length > 10000) {
        gameState.roundHistory = gameState.roundHistory.slice(-10000);
      }
      saveGameState();
    }

    // Give 12 seconds: 2.8s for winning ball voice + 7s for winner overlay + 2s clean transition
    setTimeout(() => {
      this.resetRound();
    }, 12000);
  }

  endRoundNoWinner(turnover = 0, profit = 0) {
    if (this.callTimer) clearInterval(this.callTimer);
    this.callTimer = null;
    this.status = "ended";
    const resultId = `RES_${this.id}_R${this.roundId}_${Math.floor(Date.now() / 1000)}`;
    this.lastResult = {
      result_id: resultId,
      round_id: this.roundId,
      winner_id: null,
      winner_ids: [],
      winner_name: "No Winner",
      winner_names: [],
      prize: 0,
      card_id: null,
      pattern: "No Winner",
      ended_at: Math.floor(Date.now() / 1000),
      winning_call: null,
      winners: [],
    };
    setTimeout(() => {
      this.resetRound();
    }, 6000);
  }

  endRound(winnerId, winnerName, prize, cardId, winKind = null) {
    if (!winnerId) {
      this.endRoundNoWinner();
      return;
    }
    this.endRoundWithWinners([{
      userId: winnerId,
      username: winnerName,
      firstName: winnerName,
      cardId: cardId,
      winKind: winKind || "1 መስመር",
    }], this.calls.length ? this.calls[this.calls.length - 1] : null);
  }

  resetRound() {
    this.status = "open";
    this.roundId += 1;
    this.patternIndex = (this.patternIndex + 1) % BINGO_PATTERNS.length;
    this.players = [];
    this.calls = [];
    this.deck = [];
    this.countdownEndsAt = 0;
    this.lastResult = null;
    if (this.botJoinTimer) {
      clearInterval(this.botJoinTimer);
      this.botJoinTimer = null;
    }
    if (this.id === "20") {
      this.initBotRound();
      this.startCountdown();
    }
  }
}

const activeRooms = {
  "20": new LiveBingoRoom("20", 20),
  "10": new LiveBingoRoom("10", 10),
  "10-2": new LiveBingoRoom("10-2", 10),
  "50": new LiveBingoRoom("50", 50),
};
const ACTIVE_ROOM_ORDER = ["20", "10", "10-2", "50"];

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

function extractUserFromInitData(initData) {
  if (!initData || typeof initData !== "string") return null;
  try {
    const params = new URLSearchParams(initData);
    const userJson = params.get("user");
    if (userJson) {
      const parsed = JSON.parse(userJson);
      if (parsed && parsed.id) return parsed;
    }
  } catch (e) {}
  return null;
}

function getUserFromHeaders(req, body = null) {
  let urlUid = null;
  let urlUname = null;
  try {
    const parsedUrl = new URL(req.url, "http://127.0.0.1");
    urlUid = parsedUrl.searchParams.get("u") || parsedUrl.searchParams.get("user_id") || parsedUrl.searchParams.get("tg_user_id");
    urlUname = parsedUrl.searchParams.get("username") || parsedUrl.searchParams.get("phone");
  } catch (_) {}

  const initUser = extractUserFromInitData(req.headers["x-telegram-init-data"]);
  const initUid = initUser ? String(initUser.id) : null;

  const rawUid = (body && body.user_id) || urlUid || req.headers["x-telegram-user-id"] || req.headers["x-mobile-user-id"] || initUid || "LB-PLAYER";
  // If the passed header is a guest/fake ID (e.g. starts with 8/9 and 10 digits) but we have a real Telegram initUser or urlUid, use the real Telegram ID!
  const uid = (urlUid && /^\d+$/.test(urlUid))
    ? urlUid
    : ((initUid && String(rawUid).startsWith("9") && !gameState.users[rawUid]) ? initUid : (initUid || rawUid));

  const uname = (body && body.username) || urlUname || (initUser && initUser.username) || req.headers["x-telegram-user-name"] || req.headers["x-mobile-phone"] || "";
  const name = (initUser && (initUser.first_name || initUser.name)) || (uname ? (uname.startsWith("09") || uname.startsWith("+") || uname.startsWith("07") ? uname : `@${uname}`) : (uid !== "LB-PLAYER" ? `Player ${String(uid).slice(-4)}` : "Mega Player"));
  return { id: uid, username: uname, name };
}

function getReportsData(range = "last7days") {
  const now = new Date();
  let cutoff = 0;

  if (range === "today") {
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    cutoff = startOfToday.getTime();
  } else if (range === "last30days") {
    cutoff = Date.now() - 30 * 86400 * 1000;
  } else {
    // default last7days
    cutoff = Date.now() - 7 * 86400 * 1000;
  }

  const allRounds = Array.isArray(gameState.roundHistory) ? gameState.roundHistory : [];
  const rounds = allRounds.filter((r) => {
    const ts = r.timestamp || (r.created_at ? new Date(r.created_at).getTime() : 0);
    return ts >= cutoff;
  });

  const totalRounds = rounds.length;
  let totalTurnover = 0;
  let totalPayouts = 0;
  let totalProfit = 0;
  let totalCards = 0;

  const roomsMap = {
    "10": { roomId: "10", name: "10 ETB room", stake: 10, rounds: 0, totalCards: 0, turnover: 0, payouts: 0, profit: 0, percentage: 0 },
    "20": { roomId: "20", name: "20 ETB room", stake: 20, rounds: 0, totalCards: 0, turnover: 0, payouts: 0, profit: 0, percentage: 0 },
    "50": { roomId: "50", name: "50 ETB room", stake: 50, rounds: 0, totalCards: 0, turnover: 0, payouts: 0, profit: 0, percentage: 0 },
  };

  for (const r of rounds) {
    const stake = Number(r.stake) || 10;
    const rTurnover = Number(r.turnover) || (Number(r.totalCards) * stake) || 0;
    const rPrize = Number(r.prize) || 0;
    // 20% Profit rule: house profit is 20% of turnover or (turnover - prize)
    const rProfit = Number(r.profit) || (rTurnover > rPrize ? (rTurnover - rPrize) : Math.round(rTurnover * 0.20));
    const rCards = Number(r.totalCards) || 0;

    totalTurnover += rTurnover;
    totalPayouts += rPrize;
    totalProfit += rProfit;
    totalCards += rCards;

    const key = String(stake);
    if (!roomsMap[key]) {
      roomsMap[key] = {
        roomId: key,
        name: `${stake} ETB room`,
        stake: stake,
        rounds: 0,
        totalCards: 0,
        turnover: 0,
        payouts: 0,
        profit: 0,
        percentage: 0,
      };
    }
    roomsMap[key].rounds += 1;
    roomsMap[key].totalCards += rCards;
    roomsMap[key].turnover += rTurnover;
    roomsMap[key].payouts += rPrize;
    roomsMap[key].profit += rProfit;
  }

  // Calculate percentages
  Object.values(roomsMap).forEach((rm) => {
    rm.percentage = totalRounds > 0 ? Math.round((rm.rounds / totalRounds) * 100) : 0;
  });

  // Chart data generation
  const chartPoints = [];
  if (range === "today") {
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).getTime();
    for (let h = 0; h < 24; h += 3) {
      const slotStart = startOfToday + h * 3600 * 1000;
      const slotEnd = slotStart + 3 * 3600 * 1000;
      const slotRounds = rounds.filter((r) => {
        const ts = r.timestamp || (r.created_at ? new Date(r.created_at).getTime() : 0);
        return ts >= slotStart && ts < slotEnd;
      });
      const tOver = slotRounds.reduce((sum, r) => sum + (Number(r.turnover) || 0), 0);
      const pOut = slotRounds.reduce((sum, r) => sum + (Number(r.prize) || 0), 0);
      const prof = slotRounds.reduce((sum, r) => sum + (Number(r.profit) || Math.round((Number(r.turnover) || 0) * 0.2)), 0);
      const label = `${String(h).padStart(2, "0")}:00`;
      chartPoints.push({ label, dayName: label, turnover: tOver, payouts: pOut, profit: prof, rounds: slotRounds.length, cards: slotRounds.reduce((s, r) => s + (r.totalCards || 0), 0) });
    }
  } else {
    const dayCount = range === "last30days" ? 30 : 7;
    for (let i = dayCount - 1; i >= 0; i--) {
      const dStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i, 0, 0, 0).getTime();
      const dEnd = dStart + 86400 * 1000;
      const dRounds = rounds.filter((r) => {
        const ts = r.timestamp || (r.created_at ? new Date(r.created_at).getTime() : 0);
        return ts >= dStart && ts < dEnd;
      });
      const tOver = dRounds.reduce((sum, r) => sum + (Number(r.turnover) || 0), 0);
      const pOut = dRounds.reduce((sum, r) => sum + (Number(r.prize) || 0), 0);
      const prof = dRounds.reduce((sum, r) => sum + (Number(r.profit) || Math.round((Number(r.turnover) || 0) * 0.2)), 0);
      const dDate = new Date(dStart);
      const label = dDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const dayName = dDate.toLocaleDateString("en-US", { weekday: "short" });
      chartPoints.push({ label, dayName, turnover: tOver, payouts: pOut, profit: prof, rounds: dRounds.length, cards: dRounds.reduce((s, r) => s + (r.totalCards || 0), 0) });
    }
  }

  return {
    range,
    summary: {
      totalRounds,
      totalTurnover,
      totalPayouts,
      totalProfit,
      totalCards,
      commissionRate: 20,
    },
    rooms: roomsMap,
    chart: chartPoints,
  };
}



function generateProfitReportMessage() {
  const now = new Date();
  const eatOptions = { timeZone: "Africa/Addis_Ababa" };
  const eatDateStr = now.toLocaleDateString("en-CA", eatOptions); // "YYYY-MM-DD"
  const eatTimeStr = now.toLocaleTimeString("en-US", { ...eatOptions, hour: "2-digit", minute: "2-digit" });
  const startOfEatToday = new Date(`${eatDateStr}T00:00:00+03:00`).getTime();
  const endOfEatToday = startOfEatToday + 24 * 60 * 60 * 1000;

  // 1. Approved Deposits & Withdrawals for Today
  const txList = Array.isArray(gameState.transactions) ? gameState.transactions : [];
  let approvedDepositsTotal = 0;
  let approvedDepositsCount = 0;
  let approvedWithdrawalsTotal = 0;
  let approvedWithdrawalsCount = 0;

  for (const tx of txList) {
    let ts = 0;
    if (tx.approved_at && typeof tx.approved_at === "number") {
      ts = tx.approved_at;
    } else if (tx.processed_timestamp && typeof tx.processed_timestamp === "number") {
      ts = tx.processed_timestamp;
    } else if (tx.timestamp && typeof tx.timestamp === "number") {
      ts = tx.timestamp;
    } else if (tx.created_at) {
      ts = new Date(tx.created_at).getTime();
    } else if (tx.createdAt) {
      ts = new Date(tx.createdAt).getTime();
    }

    if (ts >= startOfEatToday && ts < endOfEatToday) {
      const isApproved = tx.status === "approved" || tx.status === "completed";
      if (isApproved) {
        const amt = Number(tx.amount) || 0;
        if (tx.type === "deposit") {
          if (tx.method !== "Welcome Bonus" && !tx.is_bonus) {
            approvedDepositsTotal += amt;
            approvedDepositsCount++;
          }
        } else if (tx.type === "withdraw") {
          approvedWithdrawalsTotal += amt;
          approvedWithdrawalsCount++;
        }
      }
    }
  }

  // 2. Real Players Wallet Balance (Total balance currently on players, excluding admins)
  let totalPlayerBalance = 0;
  for (const u of Object.values(gameState.users || {})) {
    if (u && !u.is_bot && !String(u.id).startsWith("bot_")) {
      const uidStr = String(u.id);
      const isUserAdmin = u.role === "admin" ||
        (typeof ADMIN_IDS !== "undefined" && ADMIN_IDS.includes(uidStr)) ||
        (Array.isArray(gameState.settings?.adminChatIds) && gameState.settings.adminChatIds.includes(uidStr));
      if (isUserAdmin) continue;
      const bal = Number(u.balance) || 0;
      if (bal > 0) totalPlayerBalance += bal;
    }
  }

  // 3. Real Player Cartelas & Games Today
  let realCardsToday = 0;
  let realStakeToday = 0;
  let realPayoutToday = 0;
  const history = Array.isArray(gameState.roundHistory) ? gameState.roundHistory : [];
  for (const r of history) {
    let ts = r.timestamp;
    if (!ts && r.created_at) ts = new Date(r.created_at).getTime();
    if (ts >= startOfEatToday && ts < endOfEatToday) {
      realCardsToday += (Number(r.realCards) || 0);
      realStakeToday += (Number(r.realStake) || 0);
      realPayoutToday += (Number(r.realPayout) || 0);
    }
  }

  // 4. Net Profit / Loss Calculation
  const netCashProfit = approvedDepositsTotal - approvedWithdrawalsTotal;
  let profitBadge = "";
  if (netCashProfit > 0) {
    profitBadge = `👉 \`+${netCashProfit.toLocaleString()} ETB\` (አዎንታዊ / Positive) 🟢`;
  } else if (netCashProfit < 0) {
    profitBadge = `👉 \`-${Math.abs(netCashProfit).toLocaleString()} ETB\` (አሉታዊ / Negative) 🔴`;
  } else {
    profitBadge = `👉 \`0 ETB\` (ገለልተኛ / Neutral) ⚪`;
  }

  let msg = `📊 *ሜጋ ቢንጎ — የቀኑ የፋይናንስ ሪፖርት (Daily Profit Report)*\n`;
  msg += `🕒 *ቀን:* \`${eatDateStr} | ${eatTimeStr} EAT\`\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `💰 *የቤቱ የተጣራ ትርፍ (Net Profit):*\n`;
  msg += `${profitBadge}\n\n`;

  msg += `📥 *የቀኑ ገቢ (Approved Deposits):* \`+${approvedDepositsTotal.toLocaleString()} ETB\` (${approvedDepositsCount} ተቀማጭ)\n`;
  msg += `📤 *የቀኑ ወጪ (Approved Withdrawals):* \`-${approvedWithdrawalsTotal.toLocaleString()} ETB\` (${approvedWithdrawalsCount} ወጪ)\n\n`;

  msg += `👥 *የተጫዋቾች ቀሪ ሂሳብ (Players Balance):* \`${totalPlayerBalance.toLocaleString()} ETB\`\n`;
  msg += `_(በተጫዋቾች ዋሌት ውስጥ ያለ ጠቅላላ ገንዘብ)_\n\n`;

  msg += `🎟️ *በተጫዋቾች የተገዙ ካርቴላዎች:* \`${realCardsToday.toLocaleString()} ካርቴላ\`\n`;
  if (realStakeToday > 0 || realPayoutToday > 0) {
    msg += `💵 *የተጫዋቾች ውርርድ:* \`${realStakeToday.toLocaleString()} ETB\`\n`;
    msg += `🏆 *ለተጫዋቾች የተከፈለ:* \`${realPayoutToday.toLocaleString()} ETB\`\n`;
  }
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `👉 ${WEB_APP_URL}admin.html`;

  return msg;
}

let lastReportNotificationTime = 0;
function sendAdminProfitReportThrottled(minIntervalMs = 15000) {
  const now = Date.now();
  if (now - lastReportNotificationTime < minIntervalMs) return;
  lastReportNotificationTime = now;
  setTimeout(() => {
    try {
      const reportText = generateProfitReportMessage();
      notifyTelegramAdmin(reportText);
    } catch (e) {
      console.warn("[ADMIN REPORT NOTIFICATION ERROR]", e.message);
    }
  }, 1200);
}

const server = http.createServer(async (req, res) => {
  // CORS Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE, HEAD",
      "Access-Control-Allow-Headers": "Content-Type, X-Mobile-Phone, X-Mobile-User-Id, X-Telegram-Init-Data, X-Telegram-User-Id, X-Telegram-User-Name, X-Admin-Token, X-Admin-Password, Authorization",
    });
    res.end();
    return;
  }

  const rawUrl = req.url || "/";
  let [pathname] = rawUrl.split("?");
  if (pathname.startsWith("/bingo/")) {
    pathname = pathname.slice(6);
  } else if (pathname === "/bingo") {
    pathname = "/";
  } else if (pathname.startsWith("/mega/")) {
    pathname = pathname.slice(5);
  } else if (pathname === "/mega") {
    pathname = "/";
  } else if (pathname.startsWith("/waliya/")) {
    pathname = pathname.slice(7);
  } else if (pathname === "/waliya") {
    pathname = "/";
  }

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

    // 1. Get or create current user profile
    if (pathname === "/api/me") {
      // Special protection for Admin user
      if (user.id === "admin-1" || (user.username && user.username.toLowerCase() === "admin")) {
        if (!gameState.users["admin-1"]) {
          gameState.users["admin-1"] = {
            id: "admin-1",
            username: "admin",
            phone: "admin",
            first_name: "Admin",
            role: "admin",
            balance: 200,
            bonus_balance: 0,
            bonus_claimed: 1,
            is_verified: 1,
            created_at: new Date().toISOString(),
          };
          saveGameState();
        } else {
          gameState.users["admin-1"].role = "admin";
          if (typeof gameState.users["admin-1"].balance !== "number") {
            gameState.users["admin-1"].balance = 200;
            saveGameState();
          }
        }
        return sendJson(res, gameState.users["admin-1"]);
      }

      if (!gameState.users[user.id]) {
        const bonus = Number(gameState.settings?.startingBonus != null && gameState.settings?.startingBonusEnabled ? gameState.settings.startingBonus : 0);
        gameState.users[user.id] = {
          id: user.id,
          username: user.username,
          first_name: user.name,
          balance: bonus,
          bonus_balance: bonus,
          bonus_claimed: bonus > 0 ? 1 : 0,
          role: "player",
          is_verified: 1,
          created_at: new Date().toISOString(),
        };
        saveGameState();
      }
      return sendJson(res, gameState.users[user.id]);
    }

    // 1b. Mobile App Registration
    if (pathname === "/api/auth/register-mobile" && req.method === "POST") {
      const body = await parseJsonBody(req);
      let phone = String(body.phone || "").trim().replace(/[\s\-()]+/g, "");
      let fullName = String(body.name || body.fullName || body.nickname || "").trim();
      const password = String(body.password || "").trim();
      const avatar = String(body.avatar || "").trim();

      // Smart check: Did the user type their phone number in the Full Name field?
      const isEthiopianPhone = (p) => /^(?:\+251|251|0)?[97]\d{8}$/.test(String(p || "").replace(/[\s\-()]+/g, ""));
      if (!isEthiopianPhone(phone) && isEthiopianPhone(fullName)) {
        const temp = phone;
        phone = fullName.replace(/[\s\-()]+/g, "");
        fullName = isEthiopianPhone(temp) ? "" : temp;
      }

      if (phone.startsWith("+251")) phone = "0" + phone.slice(4);
      else if (phone.startsWith("251")) phone = "0" + phone.slice(3);
      else if (phone.startsWith("9") && phone.length === 9) phone = "0" + phone;
      else if (phone.startsWith("7") && phone.length === 9) phone = "0" + phone;

      if (!phone || phone.length < 9) {
        return sendJson(res, { ok: false, error: "invalid_phone", message: "ትክክለኛ ስልክ ቁጥር ያስገቡ" }, 400);
      }

      // Check if user with this phone already exists in gameState.users
      let existingUser = Object.values(gameState.users).find(
        (u) => (u.phone && u.phone === phone) || (u.username && u.username === phone)
      );

      if (existingUser) {
        // If account exists from Telegram sync without a password, link & set their password
        if (!existingUser.password) {
          existingUser.password = password;
          if (fullName && (!existingUser.first_name || existingUser.first_name.startsWith("@") || existingUser.first_name.startsWith("Player "))) {
            existingUser.first_name = fullName;
            existingUser.name = fullName;
          }
          if (avatar) existingUser.avatar = avatar;
          existingUser.is_verified = 1;
          saveGameState();
          return sendJson(res, { ok: true, user: existingUser, isNew: false, bonusGranted: false });
        }
        return sendJson(res, { ok: false, error: "already_exists", message: "ይህ ስልክ ቁጥር ቀድሞ ተመዝግቧል፤ እባክዎ ይግቡ (Login)።" });
      }

      // Generate unique user id
      const userId = String(Math.floor(9000000000 + Math.random() * 999999999));
      const bonus = Number(gameState.settings?.startingBonus != null && gameState.settings?.startingBonusEnabled ? gameState.settings.startingBonus : 0);
      const dispName = fullName || `Player ${phone.slice(-4)}`;
      const newUser = {
        id: userId,
        phone: phone,
        username: phone,
        first_name: dispName,
        name: dispName,
        password: password,
        avatar: avatar || "AB",
        balance: bonus,
        bonus_balance: bonus,
        bonus_claimed: bonus > 0 ? 1 : 0,
        role: "player",
        is_verified: 1,
        created_at: new Date().toISOString(),
        source: "mobile",
      };

      gameState.users[userId] = newUser;
      saveGameState();

      // Record bonus transaction
      const txId = `BONUS-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 900 + 100)}`;
      gameState.transactions.unshift({
        id: txId,
        playerId: `LB-${userId.slice(-5)}`,
        user_id: userId,
        player: newUser.first_name,
        phone: phone,
        type: "bonus",
        method: "Welcome Bonus",
        amount: bonus,
        status: "approved",
        reference: "New Mobile App Registration",
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        createdAt: new Date().toISOString(),
      });
      saveGameState();

      return sendJson(res, { ok: true, user: newUser, isNew: true, bonusGranted: true });
    }

    // 1c. Mobile App Login
    if (pathname === "/api/auth/login-mobile" && req.method === "POST") {
      const body = await parseJsonBody(req);
      let phone = String(body.phone || "").trim().replace(/[\s\-()]+/g, "");
      const password = String(body.password || "").trim();

      if (!phone) {
        return sendJson(res, { ok: false, error: "invalid_phone", message: "ስልክ ቁጥር ወይም Username ያስገቡ" }, 400);
      }

      // Check for Admin Login (by 'admin' or admin phone numbers + password)
      const cleanPhoneForAdmin = phone.toLowerCase();
      const cleanPhoneNoPrefix = cleanPhoneForAdmin.replace(/^(\+251|251|0)/, "");
      const adminUserList = [
        "admin", "helen", "0941434534", "+251941434534", "941434534",
        "765609989", "8722398377", "5663531258", "samtesfa19", "megabingo1bot", "megabingo"
      ];
      const isPassAdmin = password.toLowerCase() === ADMIN_PASSWORD.toLowerCase() ||
                          password.toLowerCase() === "ber343477" ||
                          password === "Ber343477" ||
                          password === "ber343477" ||
                          password === "Ber23@ret" ||
                          password === "AF7694";

      if ((adminUserList.includes(cleanPhoneForAdmin) || adminUserList.includes(cleanPhoneNoPrefix) || cleanPhoneForAdmin === "admin") && isPassAdmin) {
        let adminUser = gameState.users["admin-1"];
        if (!adminUser) {
          adminUser = {
            id: "admin-1",
            username: "admin",
            phone: phone,
            first_name: "Admin",
            role: "admin",
            balance: 200,
            bonus_balance: 0,
            bonus_claimed: 1,
            is_verified: 1,
            created_at: new Date().toISOString(),
          };
          gameState.users["admin-1"] = adminUser;
        } else {
          adminUser.role = "admin";
          adminUser.username = "admin";
          if (typeof adminUser.balance !== "number") {
            adminUser.balance = 200;
          }
        }
        saveGameState();
        return sendJson(res, {
          ok: true,
          isAdmin: true,
          token: "admin-auth-token-valid",
          user: adminUser,
        });
      }

      if (phone.startsWith("+251")) phone = "0" + phone.slice(4);
      else if (phone.startsWith("251")) phone = "0" + phone.slice(3);

      let existingUser = Object.values(gameState.users).find(
        (u) => (u.phone && u.phone === phone) || (u.username && u.username === phone)
      );

      if (!existingUser) {
        return sendJson(res, { ok: false, error: "not_found", message: "ይህ ስልክ ቁጥር አልተመዘገበም፤ እባክዎ መጀመሪያ ይመዝገቡ።" }, 404);
      }

      if (existingUser.status === "blocked") {
        return sendJson(res, { ok: false, error: "account_blocked", message: "ይህ አካውንት ታግዷል፤ እባክዎ አስተዳዳሪውን ያነጋግሩ።" }, 403);
      }

      if (existingUser.password && password && existingUser.password !== password) {
        return sendJson(res, { ok: false, error: "wrong_password", message: "የተሳሳተ የይለፍ ቃል። እባክዎ እንደገና ይሞክሩ።" }, 401);
      }

      return sendJson(res, { ok: true, user: existingUser });
    }

    // 1d. Get My Transactions (filtered strictly for this player)
    if (pathname === "/api/my-transactions") {
      const authUser = getUserFromHeaders(req);
      const userPhone = authUser.username || req.headers["x-mobile-phone"] || "";
      const userId = String(authUser.id || "");
      if (!userId || userId === "LB-PLAYER") {
        return sendJson(res, { ok: false, error: "unauthorized", transactions: [] }, 401);
      }
      const userTxns = (gameState.transactions || []).filter((t) =>
        (t.user_id && String(t.user_id) === userId) ||
        (userPhone && t.phone && t.phone === userPhone)
      );
      return sendJson(res, { ok: true, transactions: userTxns });
    }

    // 2. Submit Deposit Request (immediately visible in Admin Console!)
    if (pathname === "/api/deposit" && req.method === "POST") {
      const body = await parseJsonBody(req);
      const amount = Number(body.amount) || 0;
      const method = body.method || "Telebirr";
      const reference = (body.reference || "").trim();
      const phone = body.phone || "";

      if (amount <= 0) {
        return sendJson(res, { ok: false, error: "ትክክለኛ የገንዘብ መጠን ያስገቡ (Invalid amount)" }, 400);
      }
      if (amount < 10) {
        return sendJson(res, { ok: false, error: "ዝቅተኛው የዲፖዚት መጠን 10 ብር ነው (Minimum deposit is 10 ETB)" }, 400);
      }
      if (!reference || reference.length < 4) {
        return sendJson(res, { ok: false, error: "ትክክለኛ የግብይት ማጣቀሻ (Reference / SMS) ያስገቡ" }, 400);
      }

      if (!gameState.usedDepositReferences) {
        gameState.usedDepositReferences = {};
      }

      const cleanSingle = reference.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (cleanSingle && (BLACKLISTED_DEPOSIT_TOKENS.has(cleanSingle) || cleanSingle === "1000817750552" || cleanSingle === "0963344995")) {
        return sendJson(res, {
          ok: false,
          error: "ያስገቡት ቁጥር የተቀባይ ሂሳብ ወይም ስልክ ቁጥር ነው። እባክዎ ከባንክ የደረሰዎትን የግብይት ቁጥር (Txn Ref) ወይም የ SMS መልዕክት ያስገቡ።"
        }, 400);
      }

      const cleanRefUpper = reference.replace(/\s+/g, " ").toUpperCase();
      const newCodes = extractTxCodes(reference);

      let isDuplicate = false;
      let matchedRef = "";

      // 1. Check against the persistent usedDepositReferences registry
      if (cleanRefUpper.length >= 40 && !isInvalidTxCode(cleanRefUpper) && gameState.usedDepositReferences[cleanRefUpper]) {
        isDuplicate = true;
        matchedRef = cleanRefUpper;
      } else {
        for (const code of newCodes) {
          if (!isInvalidTxCode(code) && gameState.usedDepositReferences[code]) {
            isDuplicate = true;
            matchedRef = code;
            break;
          }
        }
      }

      // 2. Check against past transactions in memory
      if (!isDuplicate && Array.isArray(gameState.transactions)) {
        for (const tx of gameState.transactions) {
          if (tx.type !== "deposit" && !tx.reference) continue;
          const existingRef = String(tx.reference || "").trim();
          if (!existingRef) continue;
          const existingUpper = existingRef.replace(/\s+/g, " ").toUpperCase();

          // Full identical SMS text match
          if (cleanRefUpper.length >= 40 && existingUpper === cleanRefUpper) {
            isDuplicate = true;
            matchedRef = existingUpper;
            break;
          }

          // Exact matching on valid unique transaction codes
          if (newCodes.length > 0) {
            const existingCodes = extractTxCodes(existingRef);
            for (const c of newCodes) {
              if (!isInvalidTxCode(c) && existingCodes.includes(c)) {
                isDuplicate = true;
                matchedRef = c;
                break;
              }
            }
          }
          if (isDuplicate) break;
        }
      }

      if (isDuplicate) {
        console.warn(`[DEPOSIT DUPLICATE BLOCKED] Reference "${reference}" (matched "${matchedRef}") already used. User: ${user.id} (${user.name})`);
        return sendJson(res, {
          ok: false,
          error: "ይህ የግብይት ቁጥር ቀደም ሲል ጥቅም ላይ ውሏል! (This transaction reference has already been used)"
        }, 400);
      }

      const activeUser = getUserFromHeaders(req, body);
      let depositUid = activeUser.id;
      let depositUname = activeUser.name;
      let depositPhone = phone || (cleanPhone(activeUser.username) || "");

      if (!depositUid || depositUid === "LB-PLAYER") {
        if (body.user_id && body.user_id !== "LB-PLAYER") {
          depositUid = String(body.user_id);
        } else if (phone && cleanPhone(phone)) {
          depositUid = cleanPhone(phone);
        }
      }

      if (gameState.users[depositUid]) {
        depositUname = gameState.users[depositUid].name || gameState.users[depositUid].first_name || depositUname;
        if (!depositPhone && gameState.users[depositUid].phone) {
          depositPhone = gameState.users[depositUid].phone;
        }
      }

      const txId = `DEP-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 900 + 100)}`;
      const newTx = {
        id: txId,
        playerId: `LB-${String(depositUid).slice(-5)}`,
        user_id: String(depositUid),
        player: depositUname,
        phone: depositPhone,
        type: "deposit",
        method: method,
        amount: amount,
        reference: reference,
        requested: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        status: "pending",
        created_at: new Date().toISOString(),
      };

      // Record into persistent used registry so this reference/SMS can never be submitted again
      if (cleanRefUpper.length >= 50 && !isInvalidTxCode(cleanRefUpper)) {
        gameState.usedDepositReferences[cleanRefUpper] = {
          txId: txId,
          user_id: String(depositUid),
          player: depositUname,
          amount: amount,
          created_at: new Date().toISOString()
        };
      }
      for (const code of newCodes) {
        if (!isInvalidTxCode(code)) {
          gameState.usedDepositReferences[code] = {
            txId: txId,
            user_id: String(depositUid),
            player: depositUname,
            amount: amount,
            created_at: new Date().toISOString()
          };
        }
      }

      gameState.transactions.unshift(newTx);
      saveGameState();

      // Record transaction into SQLite database so Telegram bot & admin see it
      recordSqliteTransaction(txId, String(depositUid), "deposit", method, amount, depositPhone || String(depositUid), "pending");

      // Sanitize fields for Telegram Markdown to prevent parse entity failure
      const safePlayerName = String(depositUname || "Player").replace(/[_*`\[\]]/g, " ").trim();
      const safeRef = String(reference || "").slice(0, 160).replace(/[`*]/g, "").trim();
      const safeMethod = String(method || "Telebirr").replace(/[_*`\[\]]/g, " ").trim();

      // Notify Admin on Telegram
      notifyTelegramAdmin(`📩 *አዲስ የተቀማጭ ጥያቄ (New Deposit Request)*\n\n👤 *ተጫዋች:* ${safePlayerName}\n💰 *መጠን:* \`${amount} ETB\`\n🏦 *መንገድ:* ${safeMethod}\n🧾 *ማጣቀሻ (Ref):* \`${safeRef}\`\n\n✅ ለማጽደቅ ወደ Admin Console ይሂዱ: ${WEB_APP_URL}admin.html`);
      sendAdminProfitReportThrottled();

      return sendJson(res, { ok: true, id: txId, status: "pending" });
    }

    // 3. Submit Withdrawal Request (Deducts balance immediately upon submission)
    if (pathname === "/api/withdraw" && req.method === "POST") {
      const body = await parseJsonBody(req);
      const activeUser = (body && body.user_id) ? getUserFromHeaders(req, body) : user;
      const amount = Number(body.amount) || 0;
      const method = body.method || "Telebirr";
      const phone = cleanPhone(body.phone || activeUser.username || "");

      if (amount <= 0) {
        return sendJson(res, { ok: false, error: "ትክክለኛ የገንዘብ መጠን ያስገቡ (Invalid amount)" }, 400);
      }
      if (amount < 50) {
        return sendJson(res, { ok: false, error: "ዝቅተኛው የማውጣት መጠን 50 ብር ነው (Minimum withdrawal is 50 ETB)" }, 400);
      }

      // Find user in gameState
      let targetUser = gameState.users[activeUser.id];
      if (!targetUser && body.user_id) {
        targetUser = gameState.users[body.user_id];
      }
      if (!targetUser) {
        targetUser = Object.values(gameState.users).find(
          (u) => (u.id && (String(u.id) === String(activeUser.id) || (body.user_id && String(u.id) === String(body.user_id)))) ||
                 (phone && u.phone && cleanPhone(u.phone) === phone) ||
                 (activeUser.username && u.username && u.username.toLowerCase() === activeUser.username.toLowerCase())
        );
      }

      if (targetUser && (Number(targetUser.balance) || 0) < amount) {
        return sendJson(res, {
          ok: false,
          error: `ያለዎት ቀሪ ሂሳብ ${targetUser.balance} ETB ነው። ${amount} ETB ማውጣት አይቻልም። (Insufficient balance)`,
          balance: targetUser.balance
        }, 400);
      }

      // Deduct from player balance immediately upon request
      if (targetUser) {
        targetUser.balance = Math.max(0, (Number(targetUser.balance) || 0) - amount);
        targetUser.updated_at = new Date().toISOString();
        updateSqliteUserBalance(targetUser.id, targetUser.balance);
        if (targetUser.phone) updateSqliteUserBalance(targetUser.phone, targetUser.balance);
        if (activeUser.id && gameState.users[activeUser.id]) {
          gameState.users[activeUser.id].balance = targetUser.balance;
        }
      }

      const txId = `WTH-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 900 + 100)}`;
      const newTx = {
        id: txId,
        playerId: `LB-${String(targetUser ? targetUser.id : activeUser.id).slice(-5)}`,
        user_id: targetUser ? targetUser.id : activeUser.id,
        player: targetUser ? (targetUser.name || targetUser.first_name || activeUser.name) : activeUser.name,
        phone: phone || (targetUser ? targetUser.phone : ""),
        type: "withdraw",
        method: method,
        amount: amount,
        requested: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        status: "pending",
        heldFromBalance: true,
        deducted: true,
        created_at: new Date().toISOString(),
      };

      gameState.transactions.unshift(newTx);
      saveGameState();

      // Record transaction into SQLite database so Telegram bot & admin see it
      recordSqliteTransaction(txId, newTx.user_id, "withdraw", method, amount, newTx.phone, "pending");

      const safePlayer = String(newTx.player || "Player").replace(/[_*`\[\]]/g, " ").trim();
      const safePhone = String(newTx.phone || "").replace(/[`*]/g, "").trim();
      const safeMethod = String(method || "Telebirr").replace(/[_*`\[\]]/g, " ").trim();

      notifyTelegramAdmin(`📤 *የገንዘብ ማውጣት ጥያቄ (New Withdrawal Request)*\n\n👤 *ተጫዋች:* ${safePlayer}\n💰 *መጠን:* \`${amount} ETB\`\n📱 *ስልክ:* \`${safePhone}\`\n🏦 *መንገድ:* ${safeMethod}\n\n✅ ለማጽደቅ: ${WEB_APP_URL}admin.html`);
      sendAdminProfitReportThrottled();

      return sendJson(res, {
        ok: true,
        id: txId,
        status: "pending",
        balance: targetUser ? targetUser.balance : 0
      });
    }



    // 4. Admin Overview (Live feed of rooms, transactions, players, settings, reports)
    if (pathname === "/api/admin/overview") {
      syncFromSQLite();
      const pendingCount = gameState.transactions.filter((t) => t.status === "pending").length;
      const approvedTotal = gameState.transactions
        .filter((t) => t.status === "approved" || t.status === "completed")
        .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

      const usersList = Object.values(gameState.users);
      usersList.sort((a, b) => {
        const aScore = (a.phone ? 2 : 0) + (a.password ? 1 : 0) + (a.source === "telegram" ? 1 : 0);
        const bScore = (b.phone ? 2 : 0) + (b.password ? 1 : 0) + (b.source === "telegram" ? 1 : 0);
        if (bScore !== aScore) return bScore - aScore;
        return new Date(b.created_at || 0) - new Date(a.created_at || 0);
      });
      const roomsOverview = ACTIVE_ROOM_ORDER.map((id) => activeRooms[id]?.getState()).filter(Boolean);
      const totalPlayers = usersList.length;
      const verifiedPlayers = usersList.filter(u => u.is_verified).length || totalPlayers;
      const blockedPlayers = usersList.filter(u => u.status === "blocked").length;
      const thisMonth = new Date().toISOString().slice(0, 7);
      const newPlayers = usersList.filter(u => (u.created_at || u.createdAt || "").startsWith(thisMonth)).length;

      const reports = {
        today: getReportsData("today"),
        last7days: getReportsData("last7days"),
        last30days: getReportsData("last30days"),
      };

      return sendJson(res, {
        rooms: roomsOverview,
        users: usersList,
        players: usersList,
        transactions: gameState.transactions,
        metrics: {
          totalPlayers: totalPlayers,
          verifiedPlayers: verifiedPlayers,
          newPlayers: newPlayers,
          blockedPlayers: blockedPlayers,
          processedToday: approvedTotal,
          pendingTransactions: pendingCount,
        },
        settings: gameState.settings,
        reports: reports,
      });
    }

    // 4b. Admin Reports Direct API
    if (pathname === "/api/admin/reports") {
      const url = new URL(req.url, "http://localhost");
      const range = url.searchParams.get("range") || "last7days";
      return sendJson(res, getReportsData(range));
    }

    // 5. Admin Approve / Reject Transaction (Deducts balance for withdraw, refunds on reject)
    if ((pathname === "/api/admin/transaction/update" || pathname === "/api/admin/transaction") && req.method === "POST") {
      const body = await parseJsonBody(req);
      const txId = body.id || body.tx_id;
      const action = body.action || "approve"; // "approve" or "reject"

      const tx = gameState.transactions.find((t) => t.id === txId);
      if (tx) {
        tx.status = action === "approve" ? "approved" : "rejected";
        tx.processedAt = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        tx.processed_timestamp = Date.now();
        if (action === "approve") {
          tx.approved_at = Date.now();
        }

        // Find target user with flexible matching
        const cleanTxPhone = cleanPhone(tx.phone);
        const txUid = tx.user_id ? String(tx.user_id).trim() : "";
        let targetUser = txUid ? gameState.users[txUid] : null;

        if (!targetUser && txUid) {
          targetUser = Object.values(gameState.users).find((u) => String(u.id) === txUid);
        }
        if (!targetUser && cleanTxPhone) {
          targetUser = Object.values(gameState.users).find((u) => u.phone && cleanPhone(u.phone) === cleanTxPhone);
        }
        if (!targetUser && tx.playerId) {
          const pidDigits = String(tx.playerId).replace(/\D/g, "");
          if (pidDigits) {
            targetUser = Object.values(gameState.users).find((u) => String(u.id).endsWith(pidDigits));
          }
        }
        if (!targetUser && tx.player) {
          const normPlayer = String(tx.player).toLowerCase().replace(/^@/, "").trim();
          targetUser = Object.values(gameState.users).find((u) => {
            const uName = String(u.name || "").toLowerCase().replace(/^@/, "").trim();
            const uFname = String(u.first_name || "").toLowerCase().replace(/^@/, "").trim();
            const uUname = String(u.username || "").toLowerCase().replace(/^@/, "").trim();
            return (uName && uName === normPlayer) || (uFname && uFname === normPlayer) || (uUname && uUname === normPlayer);
          });
        }

        // Check SQLite if user not found in memory
        if (!targetUser) {
          try {
            const { execSync } = require("child_process");
            const pyExec = process.platform === "win32" ? "python" : "python3";
            const helperPath = path.join(__dirname, "data", "mega_bingo.db").replace(/\\/g, "/");
            const safeId = (txUid || "").replace(/[^a-zA-Z0-9_\-+]/g, "");
            const safePhone = (cleanTxPhone || "").replace(/[^0-9]/g, "");
            const safeCheck = `${pyExec} -c "import sqlite3, json; conn = sqlite3.connect('${helperPath}'); conn.row_factory = sqlite3.Row; c = conn.cursor(); r = c.execute('SELECT * FROM users WHERE id = ? OR phone_number = ? OR phone_number LIKE ?', ('${safeId}', '${safePhone}', '%${safePhone.slice(-9)}')).fetchone(); print(json.dumps(dict(r) if r else None))"`;
            const out = execSync(safeCheck, { encoding: "utf-8", timeout: 3000 });
            const dbU = JSON.parse(out);
            if (dbU) {
              const uid = String(dbU.id);
              gameState.users[uid] = {
                id: uid,
                username: dbU.username || uid,
                phone: dbU.phone_number || cleanTxPhone || null,
                first_name: dbU.first_name || tx.player || `Player ${uid.slice(-4)}`,
                name: dbU.first_name || tx.player || `Player ${uid.slice(-4)}`,
                balance: Number(dbU.balance) || 0,
                bonus_balance: Number(dbU.bonus_balance) || 0,
                bonus_claimed: 1,
                role: dbU.role || "player",
                status: dbU.status || "active",
                created_at: dbU.registered_at || new Date().toISOString(),
                source: "sqlite",
              };
              targetUser = gameState.users[uid];
            }
          } catch (e) {}
        }

        // If STILL not found, auto-create user record so balance is NEVER lost!
        if (!targetUser) {
          const finalUid = txUid || cleanTxPhone || `user_${Date.now()}`;
          const finalPhone = cleanTxPhone || (finalUid.startsWith("09") ? finalUid : null);
          const finalName = tx.player || `Player ${finalUid.slice(-4)}`;
          targetUser = {
            id: finalUid,
            username: finalPhone || finalUid,
            phone: finalPhone,
            first_name: finalName,
            name: finalName,
            balance: 0,
            bonus_balance: 0,
            bonus_claimed: 1,
            role: "player",
            status: "active",
            created_at: new Date().toISOString(),
            source: "deposit",
          };
          gameState.users[finalUid] = targetUser;
          console.log(`[APPROVE] Created missing user record for ${finalUid} (${finalName})`);
        }

        // DEPOSIT APPROVAL: Credit amount + 20% bonus
        if (action === "approve" && tx.type === "deposit") {
          const bonus = tx.amount >= 100 ? Math.floor(tx.amount * 0.2) : 0;
          const totalCredit = tx.amount + bonus;
          targetUser.balance = (Number(targetUser.balance) || 0) + totalCredit;
          targetUser.updated_at = new Date().toISOString();
          saveGameState();
          updateSqliteUserBalance(targetUser.id, targetUser.balance);
          if (targetUser.phone) {
            updateSqliteUserBalance(targetUser.phone, targetUser.balance);
          }
          updateSqliteTransactionStatus(txId, "approved");

          console.log(`[DEPOSIT APPROVED] tx=${txId}, amount=${tx.amount}, bonus=${bonus}, totalCredit=${totalCredit}, targetUser=${targetUser.id} (${targetUser.name}), newBalance=${targetUser.balance}`);

          if (targetUser.id && /^\d+$/.test(targetUser.id) && !String(targetUser.id).startsWith("09")) {
            telegramApi("sendMessage", {
              chat_id: targetUser.id,
              text: `✅ *ተቀማጭ ገንዘብዎ ጸድቋል!*\n\n💰 *የተጨመረ:* \`${totalCredit} ETB\`${bonus > 0 ? ` (ከ20% ቦነስ \`${bonus} ETB\` ጋር)` : ""}\n💵 *አሁን ያለዎት ቀሪ ሂሳብ:* \`${targetUser.balance} ETB\`\n\nመልካም ጨዋታ! 🎰`,
              parse_mode: "Markdown",
            }).catch(() => {});
          }
          sendAdminProfitReportThrottled();
        }

        // WITHDRAW APPROVAL: Ensure balance is deducted from user
        if (action === "approve" && tx.type === "withdraw") {
          if (!tx.deducted) {
            if (targetUser) {
              targetUser.balance = Math.max(0, (Number(targetUser.balance) || 0) - tx.amount);
              targetUser.updated_at = new Date().toISOString();
              updateSqliteUserBalance(targetUser.id, targetUser.balance);
            }
            tx.deducted = true;
          }
          updateSqliteTransactionStatus(txId, "approved");
          if (targetUser && targetUser.id && /^\d+$/.test(targetUser.id) && !String(targetUser.id).startsWith("09")) {
            telegramApi("sendMessage", {
              chat_id: targetUser.id,
              text: `✅ *የገንዘብ ማውጣት ጥያቄዎ ጸድቋል!*\n\n💰 *መጠን:* \`${tx.amount} ETB\`\n📱 *ስልክ:* \`${tx.phone}\`\n🏦 *መንገድ:* ${tx.method}\n💵 *አሁን ያለዎት ቀሪ ሂሳብ:* \`${targetUser.balance} ETB\``,
              parse_mode: "Markdown",
            }).catch(() => {});
          }
          sendAdminProfitReportThrottled();
        }

        // WITHDRAW REJECTION: Refund back to user if it was held/deducted
        if (action === "reject" && tx.type === "withdraw") {
          if (tx.deducted || tx.heldFromBalance) {
            if (targetUser) {
              targetUser.balance = (Number(targetUser.balance) || 0) + tx.amount;
              targetUser.updated_at = new Date().toISOString();
              updateSqliteUserBalance(targetUser.id, targetUser.balance);
            }
            tx.deducted = false;
            tx.refunded = true;
          }
          updateSqliteTransactionStatus(txId, "rejected");
          if (targetUser && targetUser.id && /^\d+$/.test(targetUser.id) && !String(targetUser.id).startsWith("09")) {
            telegramApi("sendMessage", {
              chat_id: targetUser.id,
              text: `❌ *የገንዘብ ማውጣት ጥያቄዎ ውድቅ ተደርጓል*\n\n💰 *መጠን:* \`${tx.amount} ETB\`\n💵 *ገንዘቡ ወደ ቀሪ ሂሳብዎ ተመልሷል:* \`${targetUser.balance} ETB\``,
              parse_mode: "Markdown",
            }).catch(() => {});
          }
        }

        saveGameState();
        return sendJson(res, { ok: true, id: txId, status: tx.status, user: targetUser || null });
      }
      return sendJson(res, { error: "Transaction not found" }, 404);
    }

    // 6. Admin Login
    if (pathname === "/api/admin/login") {
      const body = await parseJsonBody(req);
      const username = String(body.username || "").trim().toLowerCase().replace(/^@/, "");
      const cleanUserNoPrefix = username.replace(/^(\+251|251|0)/, "");
      const password = String(body.password || "").trim();
      const validAdminUsers = [
        "admin", "helen", "0941434534", "+251941434534", "941434534",
        "765609989", "8722398377", "5663531258", "samtesfa19", "megabingo1bot", "megabingo"
      ];
      const isPassValid = password.toLowerCase() === ADMIN_PASSWORD.toLowerCase() ||
                          password.toLowerCase() === "ber343477" ||
                          password === "Ber343477" ||
                          password === "ber343477" ||
                          password === "Ber23@ret" ||
                          password === "AF7694";

      if ((validAdminUsers.includes(username) || validAdminUsers.includes(cleanUserNoPrefix)) && isPassValid) {
        return sendJson(res, { ok: true, token: "admin-auth-token-valid", username: "admin" });
      }
      return sendJson(res, { ok: false, error: "Invalid credentials" }, 401);
    }

    // 7. Authoritative Multiplayer Room State
    if (pathname === "/api/room-state" || pathname === "/api/room/state") {
      const urlObj = new URL(rawUrl, "http://localhost");
      const roomId = urlObj.searchParams.get("room_id") || "10";
      const room = activeRooms[String(roomId)];
      if (!room) return sendJson(res, { error: "Room not found" }, 404);
      return sendJson(res, room.getState());
    }

    // 8. Join Room (Deducts balance, adds cards, starts shared countdown)
    if (pathname === "/api/join-room" || pathname === "/api/room/join") {
      const body = await parseJsonBody(req);
      const activeUser = body.user_id ? getUserFromHeaders(req, body) : user;
      const roomId = String(body.room_id || "10");
      const room = activeRooms[roomId];
      if (!room) return sendJson(res, { error: "Room not found" }, 404);
      const result = room.join(activeUser, body.card_ids || []);
      return sendJson(res, result, result.error ? 400 : 200);
    }

    // 9. Leave Room
    if (pathname === "/api/leave-room" || pathname === "/api/room/leave") {
      const body = await parseJsonBody(req);
      const activeUser = body.user_id ? getUserFromHeaders(req, body) : user;
      const roomId = String(body.room_id || "10");
      const room = activeRooms[roomId];
      const result = room ? room.leave(activeUser.id) : { ok: true };
      return sendJson(res, result);
    }

    // 10. Claim Bingo
    if (pathname === "/api/claim-bingo" || pathname === "/api/room/claim") {
      const body = await parseJsonBody(req);
      const activeUser = body.user_id ? getUserFromHeaders(req, body) : user;
      const roomId = String(body.room_id || "10");
      const room = activeRooms[roomId];
      if (!room) return sendJson(res, { error: "Room not found" }, 404);
      const result = room.claimBingo(activeUser.id, body.card_id);
      return sendJson(res, result, result.error ? 400 : 200);
    }

    // 11. Rooms & Settings
    if (pathname === "/api/rooms") {
      const rList = ACTIVE_ROOM_ORDER.map((id) => activeRooms[id]?.getState()).filter(Boolean);
      return sendJson(res, { rooms: rList, settings: gameState.settings });
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

    // 12. Admin User Update (Deposit / Withdraw / Status / Password / Balance Sync)
    if (pathname === "/api/admin/user/update" && req.method === "POST") {
      const body = await parseJsonBody(req);
      const searchKey = String(body.user_id || body.userId || body.phone || body.username || "").trim();
      if (!searchKey) {
        return sendJson(res, { error: "Missing user_id" }, 400);
      }

      let targetUser = gameState.users[searchKey];
      if (!targetUser) {
        targetUser = Object.values(gameState.users).find(
          (u) => (u.id && String(u.id) === searchKey) ||
                 (u.phone && (u.phone === searchKey || u.phone.replace(/^0/, "") === searchKey.replace(/^0/, ""))) ||
                 (u.username && u.username.toLowerCase() === searchKey.toLowerCase())
        );
      }

      if (!targetUser) {
        targetUser = {
          id: searchKey,
          username: body.username || searchKey,
          phone: body.phone || searchKey,
          first_name: body.first_name || ('Player ' + searchKey.slice(-4)),
          balance: 0,
          bonus_balance: 0,
          bonus_claimed: 0,
          role: "player",
          status: "active",
          is_verified: 1,
          created_at: new Date().toISOString(),
        };
        gameState.users[searchKey] = targetUser;
      }

      if (body.balance !== undefined && !isNaN(Number(body.balance))) {
        targetUser.balance = Math.max(0, Math.round(Number(body.balance) * 100) / 100);
        updateSqliteUserBalance(targetUser.id, targetUser.balance);
        if (targetUser.phone) updateSqliteUserBalance(targetUser.phone, targetUser.balance);
      }
      if (body.bonus_balance !== undefined && !isNaN(Number(body.bonus_balance))) {
        targetUser.bonus_balance = Math.max(0, Math.round(Number(body.bonus_balance) * 100) / 100);
      }
      if (body.status !== undefined) {
        targetUser.status = body.status;
      }
      if (body.password !== undefined && String(body.password).trim()) {
        targetUser.password = String(body.password).trim();
      }
      if (body.first_name !== undefined && String(body.first_name).trim()) {
        targetUser.first_name = String(body.first_name).trim();
      }
      targetUser.updated_at = new Date().toISOString();
      saveGameState();
      return sendJson(res, { ok: true, user: targetUser });
    }

    // 13. Test / Demo Game Starter (Allows running live round for testing)
    if (pathname === "/api/admin/start-demo-game" || pathname === "/api/start-demo-game") {
      const rId = new URL(req.url, "http://localhost").searchParams.get("room_id") || "10";
      const room = activeRooms[rId];
      if (room) {
        room.status = "open";
        room.players = [
          { user_id: "bot_101", username: "Almaz_B", first_name: "Almaz", card_ids: [12, 14] },
          { user_id: "bot_102", username: "Dawit_K", first_name: "Dawit", card_ids: [45, 88] },
          { user_id: "bot_103", username: "Selam_T", first_name: "Selam", card_ids: [102, 115] },
        ];
        room.startCountdown();
        return sendJson(res, { ok: true, message: `Started demo countdown for room ${rId}`, room: room.getState() });
      }
      return sendJson(res, { error: "Room not found" }, 404);
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
  console.log(`Mega Bingo server running on port ${PORT}`);
  startTelegramBot();

  // Scheduled Daily Profit Report at 23:59 EAT every night
  setInterval(() => {
    try {
      const now = new Date();
      const utcHours = now.getUTCHours();
      const utcMins = now.getUTCMinutes();
      // 20:59 UTC is 23:59 EAT (Addis Ababa)
      if (utcHours === 20 && utcMins === 59 && now.getUTCSeconds() < 30) {
        console.log("[SCHEDULED] Sending daily profit report to admins (23:59 EAT)...");
        notifyTelegramAdmin(`📢 *የቀኑ ማጠቃለያ ሪፖርት (End of Day Daily Profit Report)*\n\n` + generateProfitReportMessage());
      }
    } catch (e) {
      console.warn("[SCHEDULED REPORT ERROR]", e.message);
    }
  }, 30000);
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
  const targetIds = new Set();

  for (const id of ADMIN_IDS) {
    const s = String(id).trim();
    if (s && /^\d+$/.test(s) && !s.startsWith("09") && !s.startsWith("8888") && s.length >= 8) {
      targetIds.add(s);
    }
  }

  if (Array.isArray(gameState.settings?.adminChatIds)) {
    for (const cid of gameState.settings.adminChatIds) {
      const s = String(cid).trim();
      if (s && /^\d+$/.test(s) && !s.startsWith("09") && !s.startsWith("8888") && s.length >= 8) {
        targetIds.add(s);
      }
    }
  }

  console.log(`[NOTIFY ADMIN] Dispatching notification to ${targetIds.size} admin(s):`, Array.from(targetIds));

  // Clean plain text fallback (strip markdown tokens)
  const plainText = text.replace(/[*_`\[\]]/g, "");

  for (const adminId of targetIds) {
    telegramApi("sendMessage", {
      chat_id: adminId,
      text: text,
      parse_mode: "Markdown",
    }).then(async (res) => {
      if (res && res.ok) {
        console.log(`[NOTIFY ADMIN SUCCESS] Notification delivered to ${adminId}`);
      } else {
        console.warn(`[NOTIFY ADMIN FAILED] Markdown failed for ${adminId}:`, res?.description || res?.error, "-> Retrying with plain text...");
        try {
          const retryRes = await telegramApi("sendMessage", {
            chat_id: adminId,
            text: plainText,
          });
          if (retryRes && retryRes.ok) {
            console.log(`[NOTIFY ADMIN SUCCESS (FALLBACK)] Plain text delivered to ${adminId}`);
          } else {
            console.warn(`[NOTIFY ADMIN RETRY FAILED] Could not send plain text to ${adminId}:`, retryRes?.description || retryRes?.error);
          }
        } catch (retryErr) {
          console.warn(`[NOTIFY ADMIN RETRY ERROR] Network error sending fallback to ${adminId}:`, retryErr.message);
        }
      }
    }).catch(async (err) => {
      console.warn(`[NOTIFY ADMIN ERROR] Network error sending to ${adminId}:`, err.message, "-> Retrying with plain text...");
      try {
        await telegramApi("sendMessage", {
          chat_id: adminId,
          text: plainText,
        });
      } catch (e2) {}
    });
  }
}

async function startTelegramBot() {
  if (!BOT_TOKEN) return;
  console.log("[INFO] Initializing Telegram Bot Menu Button...");

  try {
    await telegramApi("setChatMenuButton", {
      menu_button: {
        type: "web_app",
        text: "Play Mega Bingo 🎰",
        web_app: { url: WEB_APP_URL },
      },
    });
  } catch (e) {}

  try {
    await telegramApi("deleteWebhook", { drop_pending_updates: true });
    console.log("[INFO] Successfully configured Telegram bot polling.");
  } catch (e) {}

  const botUserStates = {};

  function getMainKeyboard(chatId = null, userPhone = "", userName = "") {
    let playUrl = WEB_APP_URL;
    if (chatId) {
      playUrl = `${WEB_APP_URL}?u=${chatId}${userPhone ? `&phone=${encodeURIComponent(userPhone)}` : ""}${userName ? `&name=${encodeURIComponent(userName)}` : ""}`;
    }
    return {
      keyboard: [
        [
          { text: "🎮 Play Game", web_app: { url: playUrl } }
        ],
        [
          { text: "💰 Deposit" },
          { text: "💸 Withdraw" }
        ],
        [
          { text: "💳 Balance" }
        ],
        [
          { text: "📞 Support" },
          { text: "📖 Instructions" }
        ],
        [
          { text: "🎁 Invite Friends" }
        ]
      ],
      resize_keyboard: true,
      is_persistent: true
    };
  }

  const DEFAULT_MAIN_REPLY_KEYBOARD = getMainKeyboard();
  const MAIN_REPLY_KEYBOARD = DEFAULT_MAIN_REPLY_KEYBOARD;

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

          // 1. Handle Callback Query (Inline buttons)
          if (update.callback_query) {
            const cq = update.callback_query;
            const cqId = cq.id;
            const cqChatId = cq.message?.chat?.id || cq.from?.id;
            const cqData = cq.data || "";

            try {
              telegramApi("answerCallbackQuery", { callback_query_id: cqId }).catch(() => {});
            } catch (e) {}

            if (cqData === "admin_get_report") {
              const reportMsg = generateProfitReportMessage();
              await telegramApi("sendMessage", {
                chat_id: cqChatId,
                text: reportMsg,
                parse_mode: "Markdown",
                reply_markup: MAIN_REPLY_KEYBOARD,
              });
              continue;
            }

            if (cqData.startsWith("dep_m:")) {
              const parts = cqData.split(":");
              const method = parts[1] || "Telebirr";
              const amount = parseFloat(parts[2]) || botUserStates[cqChatId]?.amount || 10;

              botUserStates[cqChatId] = {
                step: "awaiting_deposit_sms",
                amount: amount,
                method: method,
                updatedAt: Date.now()
              };

              const telePhone = gameState.settings.depositTelebirrPhone || "0963344995";
              const teleName = gameState.settings.depositTelebirrName || "ቃልኪዳን እንየው";
              const cbePhone = gameState.settings.depositCbeBirrPhone || "1000817750552";
              const cbeName = gameState.settings.depositCbeBirrName || "ቃልኪዳን እንየው";

              if (method === "Telebirr") {
                await telegramApi("sendMessage", {
                  chat_id: cqChatId,
                  text: `📱 *Tele-Birr*\n\n\`${telePhone}\` (${teleName})\n\n*የቴሌቢር መመሪያ:-*\n\n1. በላይ ላለው የ Tele-Birr አካውንት \`${amount.toFixed(2)} ብር\` ያስገቡ\n2. የከፈሉበትን የግብይት መረጃ የያዘ አጭር መልእክት (SMS) ከ Tele-Birr ይደርስዎታል\n3. ያገኙትን SMS በሙሉ ኮፒ በማድረግ እዚህ በታች ያለው ቴሌግራም መልእክት ቦታ ውስጥ ፔስት በማድረግ ይላኩ\n\n📞 *ለ ድጋፍ ወይም ላጋጠመዎት ችግር*\n1. Mega bingo support (@megabingo1bot)`,
                  parse_mode: "Markdown",
                  reply_markup: MAIN_REPLY_KEYBOARD,
                });
              } else {
                await telegramApi("sendMessage", {
                  chat_id: cqChatId,
                  text: `📱 *Tele-Birr*\n\n\`${telePhone}\` (${teleName})\n\n*የቴሌቢር መመሪያ:-*\n\n1. በላይ ላለው የ Tele-Birr አካውንት \`${amount.toFixed(2)} ብር\` ያስገቡ\n2. የከፈሉበትን የግብይት መረጃ የያዘ አጭር መልእክት (SMS) ከ Tele-Birr ይደርስዎታል\n3. ያገኙትን SMS በሙሉ ኮፒ በማድረግ እዚህ በታች ያለው ቴሌግራም መልእክት ቦታ ውስጥ ፔስት በማድረግ ይላኩ\n\n📞 *ለ ድጋፍ ወይም ላጋጠመዎት ችግር*\n1. Mega bingo support (@megabingo1bot)`,
                  parse_mode: "Markdown",
                  reply_markup: MAIN_REPLY_KEYBOARD,
                });
              }
            } else if (cqData === "dep_sms_help") {
              await telegramApi("sendMessage", {
                chat_id: cqChatId,
                text: `ℹ️ *የ SMS ማረጋገጫ እርዳታ*\n\n1. በቴሌብር አፕሊኬሽን ወይም በ *127# የግብይት ታሪክ (Transaction History) ውስጥ የግብይት ቁጥሩን ይመልከቱ።\n2. የግብይት ቁጥሩን (Transaction ID ወይም Ref) ኮፒ በማድረግ እዚህ ይላኩ።\n3. ማንኛውም ችግር ካጋጠመዎት ድጋፍ ሰጪዎቻችንን ያነጋግሩ:\n👉 @megabingo1bot\n📞 \`+251941434534\``,
                parse_mode: "Markdown",
                reply_markup: MAIN_REPLY_KEYBOARD,
              });
            } else if (cqData.startsWith("wth_m:")) {
              const parts = cqData.split(":");
              const method = parts[1] || "Telebirr";
              const amount = parseFloat(parts[2]) || botUserStates[cqChatId]?.amount || 50;

              botUserStates[cqChatId] = {
                step: "awaiting_withdraw_phone",
                amount: amount,
                method: method,
                updatedAt: Date.now()
              };

              await telegramApi("sendMessage", {
                chat_id: cqChatId,
                text: `📱 *${method} — ገንዘብ ማውጣት*\n\n💰 *መጠን:* \`${amount.toFixed(2)} ETB\`\n\nእባክዎ ገንዘቡ እንዲላክልዎ የሚፈልጉትን የ ${method} ሂሳብ ወይም ስልክ ቁጥር እዚህ ይላኩ::\n*(ለምሳሌ: \`0912345678\`)*`,
                parse_mode: "Markdown",
                reply_markup: MAIN_REPLY_KEYBOARD,
              });
            } else if (cqData.startsWith("wth_use_reg:")) {
              const parts = cqData.split(":");
              const amount = parseFloat(parts[1]) || 50;
              const regPhone = parts[2] || "";
              const strChatId = String(cqChatId);
              let targetUser = gameState.users[strChatId];
              if (!targetUser) {
                targetUser = Object.values(gameState.users).find(u => String(u.id) === strChatId);
              }

              const curBal = Number(targetUser?.balance || 0);
              if (curBal < amount) {
                await telegramApi("sendMessage", {
                  chat_id: cqChatId,
                  text: `⛔ *ያለዎት ቀሪ ሂሳብ በቂ አይደለም!*\n\n💳 *ያለዎት ቀሪ ሂሳብ:* \`${curBal} ETB\``,
                  parse_mode: "Markdown",
                  reply_markup: MAIN_REPLY_KEYBOARD,
                });
                delete botUserStates[cqChatId];
                continue;
              }

              if (targetUser) {
                targetUser.balance = Math.max(0, curBal - amount);
                targetUser.updated_at = new Date().toISOString();
                saveGameState();
                updateSqliteUserBalance(targetUser.id, targetUser.balance);
                if (targetUser.phone) updateSqliteUserBalance(targetUser.phone, targetUser.balance);
              }

              const txId = `WTH-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 900 + 100)}`;
              const playerName = targetUser ? (targetUser.name || targetUser.first_name) : `User_${strChatId.slice(-4)}`;
              const newTx = {
                id: txId,
                playerId: `TG-${strChatId.slice(-5)}`,
                user_id: strChatId,
                player: playerName,
                phone: regPhone,
                type: "withdraw",
                method: "Telebirr",
                amount: amount,
                requested: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                status: "pending",
                heldFromBalance: true,
                deducted: true,
                created_at: new Date().toISOString(),
              };

              gameState.transactions.unshift(newTx);
              saveGameState();
              recordSqliteTransaction(txId, strChatId, "withdraw", "Telebirr", amount, regPhone, "pending");

              const safePlayer = String(playerName).replace(/[_*`\[\]]/g, " ").trim();
              const safePhone = String(regPhone).replace(/[`*]/g, "").trim();

              notifyTelegramAdmin(`📤 *አዲስ የገንዘብ ማውጣት ጥያቄ (New Bot Withdrawal Request)*\n\n👤 *ተጫዋች:* ${safePlayer} (\`${cqChatId}\`)\n💰 *መጠን:* \`${amount} ETB\`\n📱 *ስልክ:* \`${safePhone}\`\n🏦 *መንገድ:* Telebirr\n\n✅ ለማጽደቅ: ${WEB_APP_URL}admin.html`);
              sendAdminProfitReportThrottled();

              await telegramApi("sendMessage", {
                chat_id: cqChatId,
                text: `✅ *የገንዘብ ማውጣት ጥያቄዎ በተሳካ ሁኔታ ቀርቧል!*\n\n💰 *መጠን:* \`${amount} ETB\`\n📱 *ስልክ:* \`${safePhone}\`\n🏦 *መንገድ:* Telebirr\n💵 *አሁን ያለዎት ቀሪ ሂሳብ:* \`${targetUser ? targetUser.balance : 0} ETB\`\n\n📌 ጥያቄዎ በአስተዳዳሪው ተረጋግጦ በቴሌብር ይላክልዎታል። ጥቂት ደቂቃዎች ይጠብቁ!`,
                parse_mode: "Markdown",
                reply_markup: MAIN_REPLY_KEYBOARD,
              });

              delete botUserStates[cqChatId];
            }
            continue;
          }

          // 2. Handle Message
          const msg = update.message;
          if (msg && (msg.text || msg.contact)) {
            const chatId = msg.chat.id;
            const text = (msg.text || "").trim();
            const firstName = msg.from?.first_name || "Player";
            const rawUname = msg.from && msg.from.username ? msg.from.username : "";
            const uname = rawUname.toLowerCase().replace(/^@/, "");

            const userPhone = gameState.users[chatId]?.phone || "";
            const userName = gameState.users[chatId]?.first_name || firstName;
            const MAIN_REPLY_KEYBOARD = getMainKeyboard(chatId, userPhone, userName);

            // Sync Telegram bottom menu button directly to user account
            try {
              telegramApi("setChatMenuButton", {
                chat_id: chatId,
                menu_button: {
                  type: "web_app",
                  text: "Play Mega Bingo 🎰",
                  web_app: { url: `${WEB_APP_URL}?u=${chatId}${userPhone ? `&phone=${encodeURIComponent(userPhone)}` : ""}` },
                },
              }).catch(() => {});
            } catch (_) {}

            console.log(`[TG BOT INCOMING] chatId: ${chatId}, uname: @${uname}, name: ${firstName}, text: "${text}"`);

            if (!gameState.settings.adminChatIds) {
              gameState.settings.adminChatIds = ["765609989", "8722398377", "5663531258"];
            }
            const isAdmin = ADMIN_IDS.includes(String(chatId)) || (uname && ADMIN_USERNAMES.includes(uname));

            // Automatically register admin chat_id so notifications reach them
            if (isAdmin) {
              const strChatId = String(chatId);
              if (!gameState.settings.adminChatIds.includes(strChatId)) {
                gameState.settings.adminChatIds.push(strChatId);
                console.log(`[TG BOT] Registered new admin chatId: ${strChatId} (@${uname})`);
              }
              if (!gameState.users[chatId]) {
                gameState.users[chatId] = {
                  id: strChatId,
                  username: rawUname || uname,
                  first_name: firstName,
                  role: "admin",
                  is_verified: 1,
                  created_at: new Date().toISOString(),
                  source: "telegram",
                };
              } else {
                gameState.users[chatId].role = "admin";
                if (rawUname) gameState.users[chatId].username = rawUname;
              }
              saveGameState();
            }

            // Handle shared contact registration
            if (msg && msg.contact && msg.contact.phone_number) {
              const phone = String(msg.contact.phone_number).replace(/[\s\-\+]/g, "");
              if (!gameState.users[chatId]) {
                gameState.users[chatId] = {
                  id: String(chatId),
                  username: rawUname || uname,
                  first_name: firstName,
                  phone: phone,
                  balance: 0,
                  created_at: new Date().toISOString(),
                  source: "telegram",
                  is_verified: 1,
                };
              } else {
                gameState.users[chatId].phone = phone;
                gameState.users[chatId].is_verified = 1;
              }
              saveGameState();
              const uBal = Number(gameState.users[chatId]?.balance != null ? gameState.users[chatId].balance : 0);
              await telegramApi("sendMessage", {
                chat_id: chatId,
                text: `✅ *በተሳካ ሁኔታ ተመዝግበዋል*\n💰 *ቀሪ ሂሳብ:* \`${uBal} ETB\`\n\nለመቀጠል ማውጫውን ይጠቀሙ::\n\nአንድ አማራጭ ይምረጡ:-`,
                parse_mode: "Markdown",
                reply_markup: MAIN_REPLY_KEYBOARD,
              });
              continue;
            }

            if (text.startsWith("/start") || text.toLowerCase() === "play" || text === "🎮 Play Game") {
              let userRecord = gameState.users[chatId];
              if (!userRecord) {
                userRecord = {
                  id: String(chatId),
                  username: rawUname || uname,
                  first_name: firstName,
                  balance: 0,
                  created_at: new Date().toISOString(),
                  source: "telegram",
                  is_verified: 1,
                };
                gameState.users[chatId] = userRecord;
                saveGameState();
              }
              const uBal = Number(userRecord.balance != null ? userRecord.balance : 0);

              if (isAdmin) {
                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: `👋 ሰላም *${firstName}* (@${rawUname || uname || "Admin"})! ወደ *Mega Bingo* እንኳን በደህና መጡ! 🎲\n\n🛡️ *የአስተዳዳሪ (Admin) መለያዎ ነቅቷል!*\n\n✅ *በተሳካ ሁኔታ ተመዝግበዋል*\n💰 *ቀሪ ሂሳብ:* \`${uBal} ETB\`\n\nለመቀጠል ማውጫውን ይጠቀሙ::\n\nአንድ አማራጭ ይምረጡ:-`,
                  parse_mode: "Markdown",
                  reply_markup: MAIN_REPLY_KEYBOARD,
                });
              } else {
                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: `✅ *በተሳካ ሁኔታ ተመዝግበዋል*\n💰 *ቀሪ ሂሳብ:* \`${uBal} ETB\`\n\nለመቀጠል ማውጫውን ይጠቀሙ::\n\nአንድ አማራጭ ይምረጡ:-`,
                  parse_mode: "Markdown",
                  reply_markup: MAIN_REPLY_KEYBOARD,
                });
              }
            } else if (text.includes("Deposit") || text.includes("ተቀማጭ") || text.includes("ዲፖዚት") || text === "/deposit") {
              botUserStates[chatId] = {
                step: "awaiting_deposit_amount",
                updatedAt: Date.now()
              };

              await telegramApi("sendMessage", {
                chat_id: chatId,
                text: `💰 *ማስገባት የሚፈልጉትን መጠን ከ10 ብር ጀምሮ ያስገቡ::*`,
                parse_mode: "Markdown",
                reply_markup: MAIN_REPLY_KEYBOARD,
              });
            } else if (text.includes("Withdraw") || text.includes("ማውጣት") || text === "/withdraw") {
              const strChatId = String(chatId);
              let curUser = gameState.users[strChatId];
              if (!curUser) {
                curUser = Object.values(gameState.users).find(u => String(u.id) === strChatId || (u.username && u.username.toLowerCase() === (uname || "").toLowerCase()));
              }
              const curBal = Number(curUser?.balance != null ? curUser.balance : 0);

              if (curBal < 50) {
                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: `💸 *ገንዘብ ማውጣት (Withdraw)*\n\n💳 *አሁን ያለዎት ቀሪ ሂሳብ:* \`${curBal} ETB\`\n📌 *ዝቅተኛው ማውጣት የሚቻለው:* \`50 ETB\`\n\n⚠️ *ይቅርታ! ገንዘብ ለማውጣት በቂ ቀሪ ሂሳብ የለዎትም። ለማውጣት ቢያንስ 50 ETB ሊኖርዎት ይገባል።*\n\n🎲 ለመጫወት ከታች **🎮 Play Game** የሚለውን ይጫኑ!`,
                  parse_mode: "Markdown",
                  reply_markup: MAIN_REPLY_KEYBOARD,
                });
              } else {
                botUserStates[chatId] = {
                  step: "awaiting_withdraw_amount",
                  updatedAt: Date.now()
                };

                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: `💸 *ገንዘብ ማውጣት (Withdraw)*\n\n💳 *አሁን ያለዎት ቀሪ ሂሳብ:* \`${curBal} ETB\`\n📌 *ዝቅተኛው ማውጣት የሚቻለው:* \`50 ETB\`\n\n💰 *ማውጣት የሚፈልጉትን የገንዘብ መጠን ያስገቡ (ለምሳሌ: 50, 100, 200):*`,
                  parse_mode: "Markdown",
                  reply_markup: MAIN_REPLY_KEYBOARD,
                });
              }
            } else if (text.includes("Balance") || text.includes("ሂሳብ") || text === "/balance") {
              const curUser = gameState.users[chatId] || {};
              const curBal = Number(curUser.balance != null ? curUser.balance : 0);
              await telegramApi("sendMessage", {
                chat_id: chatId,
                text: `💳 *የሂሳብዎ ቀሪ (Your Balance)*\n\n👤 *ተጠቃሚ:* ${firstName}\n💰 *የዋና ሂሳብ ቀሪ:* \`${curBal}\` ETB\n\n🎲 ለመጫወት ከታች **🎮 Play Game** የሚለውን ይጫኑ!`,
                parse_mode: "Markdown",
                reply_markup: MAIN_REPLY_KEYBOARD,
              });
            } else if (text.includes("Support") || text.includes("ድጋፍ") || text === "/support") {
              await telegramApi("sendMessage", {
                chat_id: chatId,
                text: `📞 *የደንበኞች አገልግሎት እና ድጋፍ (Customer Support)*\n\nለማንኛውም አይነት ጥያቄ፣ አስተያየት ወይም የክፍያ እርዳታ አድሚኖችን ያግኙ:\n\n👉 *ቴሌግራም:* @megabingo1bot\n📞 *ስልክ:* \`+251941434534\`\n\nእርስዎን ለማገልገል 24/7 ዝግጁ ነን!`,
                parse_mode: "Markdown",
                reply_markup: MAIN_REPLY_KEYBOARD,
              });
            } else if (text.includes("Instructions") || text.includes("ህግ") || text.includes("መመሪያ") || text === "/help") {
              await telegramApi("sendMessage", {
                chat_id: chatId,
                text: `📖 *የጨዋታ ህጎች እና መመሪያዎች (Instructions)*\n\n1. 🎮 *Play Game* የሚለውን ተጭነው ወደ ጨዋታው ይግቡ።\n2. የሚፈልጉትን ክፍል (10, 20 ወይም 50 ETB) ይምረጡ።\n3. የካርቴላ ቁጥር ይምረጡ (እስከ 50 ካርቴላ መምረጥ ይችላሉ)።\n4. የ 30 ሰከንድ የምዝገባ ቆጣሪው ሲያልቅ ጨዋታው በራሱ ይጀምራል።\n5. ኳሶች በድምጽ እና በስክሪኑ ላይ አንድ በአንድ ይወጣሉ።\n6. ማንኛውም 1 መስመር (አግድም፣ ቁልቁል ወይም ዲያጎናል) የሞላ ተጫዋች አሸናፊ ይሆናል!\n\nመልካም እድል! 🍀`,
                parse_mode: "Markdown",
                reply_markup: MAIN_REPLY_KEYBOARD,
              });
            } else if (text.includes("Invite Friends") || text.includes("መጋበዝ") || text === "/invite") {
              await telegramApi("sendMessage", {
                chat_id: chatId,
                text: `🎁 *ጓደኞችዎን ይጋብዙ (Invite Friends)*\n\nየእርስዎን መጋበዣ ሊንክ ለጓደኞችዎ ያጋሩ:\n👉 \`https://t.me/megabingo1bot?start=ref_${chatId}\`\n\nጓደኛዎ በእርስዎ ሊንክ ተመዝግቦ አብሮዎት መጫወት ይችላል!`,
                parse_mode: "Markdown",
                reply_markup: MAIN_REPLY_KEYBOARD,
              });
            } else if (text.startsWith("/report") || text.startsWith("/profit") || text === "📊 Report" || text === "ሪፖርት" || text === "Report") {
              if (isAdmin) {
                const reportMsg = generateProfitReportMessage();
                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: reportMsg,
                  parse_mode: "Markdown",
                  reply_markup: MAIN_REPLY_KEYBOARD,
                });
              } else {
                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: `⛔ *ይቅርታ! ይህንን ሪፖርት ለመመልከት የአስተዳዳሪ (Admin) ፈቃድ ያስፈልጋል።*`,
                  parse_mode: "Markdown",
                  reply_markup: MAIN_REPLY_KEYBOARD,
                });
              }
            } else if (text.startsWith("/admin")) {
              if (isAdmin) {
                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: `🛡️ *Mega Bingo — Admin Control Center*\n\n📊 ወቅታዊውን የቀንና የሳምንት ትርፍ ሪፖርት ለማየት: \`/report\` ይላኩ ወይም ከታች ያለውን ይጫኑ።\n👉 [Admin Console መክፈቻ](${WEB_APP_URL}admin.html?role=admin&u=${chatId})`,
                  parse_mode: "Markdown",
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: "📊 የቀንና የሳምንት ትርፍ ሪፖርት", callback_data: "admin_get_report" }],
                      [{ text: "🖥️ Admin Console", url: `${WEB_APP_URL}admin.html?role=admin&u=${chatId}` }]
                    ]
                  }
                });
              } else {
                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: `⛔ *ይቅርታ! ይህንን ትዕዛዝ ለመጠቀም የአስተዳዳሪ (Admin) ፈቃድ የለዎትም።*`,
                  parse_mode: "Markdown",
                  reply_markup: MAIN_REPLY_KEYBOARD,
                });
              }
            } else if (text.startsWith("/id") || text.startsWith("/myid") || text.startsWith("/status")) {
              await telegramApi("sendMessage", {
                chat_id: chatId,
                text: `ℹ️ *የመለያ መረጃ (Account Info)*\n\n🆔 *Chat ID:* \`${chatId}\`\n👤 *Username:* \`@${rawUname || "None"}\`\n🛡️ *Role:* ${isAdmin ? "👑 Admin (Receives Alerts)" : "Player"}`,
                parse_mode: "Markdown",
                reply_markup: MAIN_REPLY_KEYBOARD,
              });
            } else if (botUserStates[chatId]?.step === "awaiting_withdraw_amount") {
              const amountMatch = text.replace(/,/g, "").trim().match(/^(\d+(?:\.\d+)?)/);
              const wAmount = amountMatch ? parseFloat(amountMatch[1]) : 0;
              const strChatId = String(chatId);
              let curUser = gameState.users[strChatId];
              if (!curUser) {
                curUser = Object.values(gameState.users).find(u => String(u.id) === strChatId || (u.username && u.username.toLowerCase() === (uname || "").toLowerCase()));
              }
              const curBal = Number(curUser?.balance != null ? curUser.balance : 0);

              if (!wAmount || isNaN(wAmount) || wAmount <= 0) {
                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: `⚠️ *እባክዎ ትክክለኛ የገንዘብ መጠን ያስገቡ (ለምሳሌ: 50, 100):*`,
                  parse_mode: "Markdown",
                  reply_markup: MAIN_REPLY_KEYBOARD,
                });
              } else if (wAmount < 50) {
                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: `⚠️ *ዝቅተኛው የማውጣት መጠን 50 ETB ነው።* እባክዎ ከ50 ብር ጀምሮ ያስገቡ::`,
                  parse_mode: "Markdown",
                  reply_markup: MAIN_REPLY_KEYBOARD,
                });
              } else if (wAmount > curBal) {
                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: `⛔ *ያለዎት ቀሪ ሂሳብ በቂ አይደለም!*\n\n💳 *ያለዎት ቀሪ ሂሳብ:* \`${curBal} ETB\`\n💰 *እርስዎ የጠየቁት መጠን:* \`${wAmount} ETB\`\n\nእባክዎ ካለዎት ቀሪ ሂሳብ እኩል ወይም ያነሰ መጠን ያስገቡ::`,
                  parse_mode: "Markdown",
                  reply_markup: MAIN_REPLY_KEYBOARD,
                });
              } else {
                botUserStates[chatId] = {
                  step: "awaiting_withdraw_phone",
                  amount: wAmount,
                  method: "Telebirr",
                  updatedAt: Date.now()
                };

                const regPhone = curUser?.phone ? cleanPhone(curUser.phone) : "";
                const inlineKb = [
                  [
                    { text: "🟩 Telebirr", callback_data: `wth_m:Telebirr:${wAmount}` },
                    { text: "🟨 CBE Birr", callback_data: `wth_m:CBE Birr:${wAmount}` }
                  ]
                ];
                if (regPhone) {
                  inlineKb.push([{ text: `📱 በተመዘገበው ስልክ (${regPhone}) ላክ`, callback_data: `wth_use_reg:${wAmount}:${regPhone}` }]);
                }

                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: `💸 *የማውጣት ዝርዝር (Withdraw Details)*\n\n💰 *መጠን:* \`${wAmount.toFixed(2)} ETB\`\n\n*ዘዴ ይምረጡ ወይም ገንዘቡ እንዲላክልዎ የሚፈልጉትን ስልክ ቁጥር ያስገቡ:-*`,
                  parse_mode: "Markdown",
                  reply_markup: {
                    inline_keyboard: inlineKb
                  }
                });
              }
            } else if (botUserStates[chatId]?.step === "awaiting_withdraw_phone") {
              const phoneInput = text.trim();
              const wAmount = botUserStates[chatId]?.amount || 50;
              const method = botUserStates[chatId]?.method || (/^1000\d{8,}/.test(phoneInput) ? "CBE Birr" : "Telebirr");

              const strChatId = String(chatId);
              let targetUser = gameState.users[strChatId];
              if (!targetUser) {
                targetUser = Object.values(gameState.users).find(u => String(u.id) === strChatId || (u.username && u.username.toLowerCase() === (uname || "").toLowerCase()));
              }

              const curBal = Number(targetUser?.balance != null ? targetUser.balance : 0);
              if (curBal < wAmount) {
                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: `⛔ *ያለዎት ቀሪ ሂሳብ በቂ አይደለም!*\n\n💳 *ያለዎት ቀሪ ሂሳብ:* \`${curBal} ETB\`\n\nገንዘብ ማውጣት አልተቻለም።`,
                  parse_mode: "Markdown",
                  reply_markup: MAIN_REPLY_KEYBOARD,
                });
                delete botUserStates[chatId];
              } else {
                if (targetUser) {
                  targetUser.balance = Math.max(0, curBal - wAmount);
                  targetUser.updated_at = new Date().toISOString();
                  saveGameState();
                  updateSqliteUserBalance(targetUser.id, targetUser.balance);
                  if (targetUser.phone) updateSqliteUserBalance(targetUser.phone, targetUser.balance);
                }

                const txId = `WTH-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 900 + 100)}`;
                const playerName = targetUser ? (targetUser.name || targetUser.first_name || firstName) : firstName;
                const newTx = {
                  id: txId,
                  playerId: `TG-${strChatId.slice(-5)}`,
                  user_id: strChatId,
                  player: playerName,
                  phone: phoneInput,
                  type: "withdraw",
                  method: method,
                  amount: wAmount,
                  requested: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                  status: "pending",
                  heldFromBalance: true,
                  deducted: true,
                  created_at: new Date().toISOString(),
                };

                gameState.transactions.unshift(newTx);
                saveGameState();
                recordSqliteTransaction(txId, strChatId, "withdraw", method, wAmount, phoneInput, "pending");

                const safePlayer = String(playerName).replace(/[_*`\[\]]/g, " ").trim();
                const safePhone = String(phoneInput).replace(/[`*]/g, "").trim();

                notifyTelegramAdmin(`📤 *አዲስ የገንዘብ ማውጣት ጥያቄ (New Bot Withdrawal Request)*\n\n👤 *ተጫዋች:* ${safePlayer} (\`${chatId}\`)\n💰 *መጠን:* \`${wAmount} ETB\`\n📱 *ስልክ:* \`${safePhone}\`\n🏦 *መንገድ:* ${method}\n\n✅ ለማጽደቅ: ${WEB_APP_URL}admin.html`);
                sendAdminProfitReportThrottled();

                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: `✅ *የገንዘብ ማውጣት ጥያቄዎ በተሳካ ሁኔታ ቀርቧል!*\n\n💰 *መጠን:* \`${wAmount} ETB\`\n📱 *ስልክ:* \`${safePhone}\`\n🏦 *መንገድ:* ${method}\n💵 *አሁን ያለዎት ቀሪ ሂሳብ:* \`${targetUser ? targetUser.balance : 0} ETB\`\n\n📌 ጥያቄዎ በአስተዳዳሪው ተረጋግጦ በ ${method} ይላክልዎታል። ጥቂት ደቂቃዎች ይጠብቁ!`,
                  parse_mode: "Markdown",
                  reply_markup: MAIN_REPLY_KEYBOARD,
                });

                delete botUserStates[chatId];
              }
            } else if (
              !botUserStates[chatId]?.step?.startsWith("awaiting_withdraw") &&
              /^(\d+(?:\.\d+)?)\s*(?:birr|etb|ብር)?$/i.test(text.replace(/,/g, "").trim()) &&
              (botUserStates[chatId]?.step === "awaiting_deposit_amount" || (!text.startsWith("/") && parseFloat(text.replace(/,/g, "").trim()) >= 10))
            ) {
              const amountMatch = text.replace(/,/g, "").trim().match(/^(\d+(?:\.\d+)?)/);
              const amount = amountMatch ? parseFloat(amountMatch[1]) : 0;
              if (amount < 10) {
                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: `⚠️ *ዝቅተኛው የማስገቢያ መጠን 10 ብር ነው።* እባክዎ ከ10 ብር ጀምሮ ያስገቡ::`,
                  parse_mode: "Markdown",
                  reply_markup: MAIN_REPLY_KEYBOARD,
                });
              } else {
                botUserStates[chatId] = {
                  step: "awaiting_deposit_method",
                  amount: amount,
                  updatedAt: Date.now()
                };

                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: `*ተቀማጭ*\n*መጠን:* \`${amount.toFixed(2)} ብር\`\n*ዘዴ ይምረጡ:-*\n\n📞 ለ ድጋፍ ወይም ላጋጠመዎት ችግር\n1. Mega bingo support (@megabingo1bot)`,
                  parse_mode: "Markdown",
                  reply_markup: {
                    inline_keyboard: [
                      [
                        { text: "📱 Telebirr", callback_data: `dep_m:Telebirr:${amount}` }
                      ],
                      [
                        { text: "📩 SMS አልደረሰኝም?", callback_data: "dep_sms_help" }
                      ]
                    ]
                  }
                });
              }
            } else if (
              (extractTxCodes(text).length > 0 && (text.length >= 8 || /ETB|\bብር\b/i.test(text))) ||
              /(?:transferred|ልከዋል|ተቀብለዋል|telebirr|deposited|receipt)/i.test(text) ||
              (botUserStates[chatId]?.step === "awaiting_deposit_sms" && text.length >= 4)
            ) {
              const cleanSingle = text.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
              if (cleanSingle && (BLACKLISTED_DEPOSIT_TOKENS.has(cleanSingle) || cleanSingle === "0941434534" || cleanSingle === "251941434534")) {
                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: `⚠️ *ያስገቡት ቁጥር የተቀባይ ሂሳብ ወይም ስልክ ቁጥር ነው!*\n\nገንዘብ ካስተላለፉ በኋላ ከቴሌብር (Telebirr) የደረሰዎትን አጭር የጽሑፍ መልዕክት (SMS) ሙሉውን ኮፒ አድርገው እዚህ ይላኩ ወይም የደረሰኝ ቁጥሩን (Transaction Ref) ያስገቡ።`,
                  parse_mode: "Markdown",
                  reply_markup: MAIN_REPLY_KEYBOARD,
                });
                continue;
              }

              let userRecord = gameState.users[chatId];
              if (!userRecord) {
                userRecord = {
                  id: String(chatId),
                  username: rawUname || uname || `User_${String(chatId).slice(-4)}`,
                  first_name: firstName,
                  balance: 0,
                  created_at: new Date().toISOString(),
                  source: "telegram",
                  is_verified: 1,
                };
                gameState.users[chatId] = userRecord;
                saveGameState();
              }

              if (!gameState.usedDepositReferences) {
                gameState.usedDepositReferences = {};
              }

              const cleanRefUpper = text.trim().replace(/\s+/g, " ").toUpperCase();
              const newCodes = extractTxCodes(text);

              let isDuplicate = false;
              let matchedRef = "";

              // 1. Check against the persistent usedDepositReferences registry
              if (cleanRefUpper.length >= 40 && !isInvalidTxCode(cleanRefUpper) && gameState.usedDepositReferences[cleanRefUpper]) {
                isDuplicate = true;
                matchedRef = cleanRefUpper;
              } else {
                for (const code of newCodes) {
                  if (!isInvalidTxCode(code) && gameState.usedDepositReferences[code]) {
                    isDuplicate = true;
                    matchedRef = code;
                    break;
                  }
                }
              }

              // 2. Check against past transactions in memory
              if (!isDuplicate && Array.isArray(gameState.transactions)) {
                for (const tx of gameState.transactions) {
                  if (tx.type !== "deposit" && !tx.reference) continue;
                  const existingRef = String(tx.reference || "").trim();
                  if (!existingRef) continue;
                  const existingUpper = existingRef.replace(/\s+/g, " ").toUpperCase();

                  if (cleanRefUpper.length >= 40 && existingUpper === cleanRefUpper) {
                    isDuplicate = true;
                    matchedRef = existingUpper;
                    break;
                  }

                  if (newCodes.length > 0) {
                    const existingCodes = extractTxCodes(existingRef);
                    for (const c of newCodes) {
                      if (!isInvalidTxCode(c) && existingCodes.includes(c)) {
                        isDuplicate = true;
                        matchedRef = c;
                        break;
                      }
                    }
                  }
                  if (isDuplicate) break;
                }
              }

              if (isDuplicate) {
                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: `⚠️ *ይህ ደረሰኝ / የግብይት ቁጥር ቀደም ሲል ጥቅም ላይ ውሏል!*\n\nእባክዎ ትክክለኛ አዲስ ደረሰኝ ያስገቡ ወይም እርዳታ ከፈለጉ ድጋፍ ሰጪዎችን ያነጋግሩ።`,
                  parse_mode: "Markdown",
                  reply_markup: MAIN_REPLY_KEYBOARD,
                });
                continue;
              }

              let extractedAmount = 0;
              const amMatch1 = text.match(/(?:ETB|ብር)\s*([\d,]+(?:\.\d+)?)/i);
              const amMatch2 = text.match(/([\d,]+(?:\.\d+)?)\s*(?:ETB|ብር)/i);
              const amMatch3 = text.match(/(?:transferred|ልከዋል|deposited)\s*([\d,]+(?:\.\d+)?)/i);
              if (amMatch1 && amMatch1[1]) extractedAmount = parseFloat(amMatch1[1].replace(/,/g, ""));
              else if (amMatch2 && amMatch2[1]) extractedAmount = parseFloat(amMatch2[1].replace(/,/g, ""));
              else if (amMatch3 && amMatch3[1]) extractedAmount = parseFloat(amMatch3[1].replace(/,/g, ""));

              // Fallback to bot flow amount if not parsed from SMS
              if (extractedAmount <= 0 && botUserStates[chatId]?.amount > 0) {
                extractedAmount = botUserStates[chatId].amount;
              }

              let detectedMethod = botUserStates[chatId]?.method || (/cbe|commercial bank|ንግድ ባንክ/i.test(text) ? "CBE Birr" : "Telebirr");

              const txId = `DEP-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 900 + 100)}`;
              const playerName = firstName || rawUname || `User_${String(chatId).slice(-4)}`;
              const newTx = {
                id: txId,
                playerId: `TG-${String(chatId).slice(-5)}`,
                user_id: String(chatId),
                player: playerName,
                phone: String(chatId),
                type: "deposit",
                method: detectedMethod,
                amount: extractedAmount,
                reference: text.slice(0, 300),
                requested: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                status: "pending",
                created_at: new Date().toISOString(),
              };

              if (cleanRefUpper.length >= 50 && !isInvalidTxCode(cleanRefUpper)) {
                gameState.usedDepositReferences[cleanRefUpper] = {
                  txId: txId,
                  user_id: String(chatId),
                  player: playerName,
                  amount: extractedAmount,
                  created_at: new Date().toISOString(),
                };
              }
              for (const code of newCodes) {
                if (!isInvalidTxCode(code)) {
                  gameState.usedDepositReferences[code] = {
                    txId: txId,
                    user_id: String(chatId),
                    player: playerName,
                    amount: extractedAmount,
                    created_at: new Date().toISOString(),
                  };
                }
              }

              gameState.transactions.unshift(newTx);
              saveGameState();
              recordSqliteTransaction(txId, String(chatId), "deposit", detectedMethod, extractedAmount, String(chatId), "pending");

              const safePlayerName = String(playerName).replace(/[_*`\[\]]/g, " ").trim();
              const safeRef = String(newCodes[0] || (text.length > 60 ? text.slice(0, 55) + "..." : text)).replace(/[`*]/g, "").trim();
              notifyTelegramAdmin(`📩 *አዲስ የተቀማጭ ደረሰኝ (New Bot SMS Deposit)*\n\n👤 *ተጫዋች:* ${safePlayerName} (\`${chatId}\`)\n💰 *የተገኘ መጠን:* \`${extractedAmount > 0 ? extractedAmount + " ETB" : "በአድሚን ይረጋገጥ"}\`\n🏦 *መንገድ:* ${detectedMethod}\n🧾 *ማጣቀሻ:* \`${safeRef}\`\n\n✅ ለማጽደቅ: ${WEB_APP_URL}admin.html`);
              sendAdminProfitReportThrottled();

              await telegramApi("sendMessage", {
                chat_id: chatId,
                text: `✅ *ደረሰኝዎ በተሳካ ሁኔታ ደርሶናል!*\n\n💰 *መጠን:* \`${extractedAmount > 0 ? extractedAmount + " ETB" : "በማረጋገጥ ላይ"}\`\n🧾 *ማጣቀሻ:* \`${newCodes[0] || "የተረጋገጠ"}\`\n🏦 *መንገድ:* ${detectedMethod}\n\n📌 ጥያቄዎ በአስተዳዳሪው ተረጋግጦ ቀሪ ሂሳብዎ ላይ ይጨመራል። ጥቂት ደቂቃ ይጠብቁ!\n\nለመጫወት ከታች ያለውን **🎮 Play Game** ይጫኑ።`,
                parse_mode: "Markdown",
                reply_markup: MAIN_REPLY_KEYBOARD,
              });

              delete botUserStates[chatId];
            } else {
              await telegramApi("sendMessage", {
                chat_id: chatId,
                text: `ለመቀጠል ከታች ያለውን ማውጫ ይጠቀሙ::\n\nአንድ አማራጭ ይምረጡ:-`,
                reply_markup: MAIN_REPLY_KEYBOARD,
              });
            }
          }
        }
      }
    } catch (err) {
      console.warn("[TG BOT POLL ERROR]", err.message);
    }
    setTimeout(poll, 1500);
  }

  poll();
}
