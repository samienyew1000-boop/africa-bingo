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
const ROOT_BACKUP_FILE = "/var/backups/waliya-bingo-state.json";
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const WEB_APP_URL = (process.env.WEB_APP_URL || "https://konjobetcom.et/waliya/").replace(/\/+$/, "") + "/";
const rawAdminUsernames = process.env.ADMIN_USERNAMES || "0918182355,9029759446,berihun,admin,0999909474,su121316,samtesfa19,samienyew1000,Africabingooo,waliyabingooo,waliyabingo,waliyabingo1_bot,Biregugsa,ber63781,Ber63781";
const ADMIN_USERNAMES = rawAdminUsernames.split(",").map((u) => u.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);
const rawAdminIds = process.env.ADMIN_TELEGRAM_IDS || "6220264098,5663531258";
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
    { id: "10", stake: 10, name: "10 No 1", players: 0, status: "waiting", roundId: "#WB-101", prizePool: 0, called: [] },
    { id: "10-2", stake: 10, name: "10 No 2", players: 0, status: "waiting", roundId: "#WB-102", prizePool: 0, called: [] },
    { id: "20", stake: 20, name: "20 No 1", players: 0, status: "waiting", roundId: "#WB-103", prizePool: 0, called: [] },
    { id: "50", stake: 50, name: "50 No 1", players: 0, status: "waiting", roundId: "#WB-104", prizePool: 0, called: [] },
  ],
  settings: {
    countdown: 30,
    commissionRate: 20,
    minDeposit: 50,
    depositBonus: 20,
    bonusThreshold: 100,
    startingBonus: 0,
    startingBonusEnabled: false,
    depositTelebirrPhone: "0975094812",
    depositTelebirrName: "ቃልኪዳን እንየው",
    depositCbeBirrPhone: "1000817750552",
    depositCbeBirrName: "ቃልኪዳን እንየው",
    depositMpesaPhone: "0700 000 000",
    depositMpesaName: "Waliya Bingo M-Pesa",
  },
  metrics: {
    totalPlayers: 0,
    verifiedPlayers: 0,
    processedToday: 0,
  },
  users: {},
  transactions: [],
};

let gameState = DEFAULT_STATE;

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
    [BACKUP_STATE_FILE, ROOT_BACKUP_FILE].forEach((bp) => {
      try {
        if (fs.existsSync(bp)) {
          const parsed = JSON.parse(fs.readFileSync(bp, "utf-8"));
          if (parsed && parsed.users && Object.keys(parsed.users).length > Object.keys(backupUsers).length) {
            backupUsers = parsed.users;
            backupTxns = parsed.transactions || [];
          }
        }
      } catch (e) {}
    });

    const mergedUsers = {
      ...backupUsers,
      ...(fileData?.users || {}),
    };

    const mergedTxns = (fileData?.transactions && fileData.transactions.length > 0)
      ? fileData.transactions
      : (backupTxns.length > 0 ? backupTxns : []);

    gameState = {
      ...DEFAULT_STATE,
      ...(fileData || {}),
      settings: {
        ...DEFAULT_STATE.settings,
        ...(fileData?.settings || {}),
        countdown: 30,
        depositTelebirrPhone: "0975094812",
        depositTelebirrName: "ቃልኪዳን እንየው",
        depositCbeBirrPhone: "1000817750552",
        depositCbeBirrName: "ቃልኪዳን እንየው",
      },
      users: mergedUsers,
      transactions: mergedTxns,
    };

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

  // 2. Read lucky_bingo.db via python
  const dbPaths = [
    path.join(__dirname, "data", "waliya_bingo.db"),
    "/var/www/africa-bingo/data/waliya_bingo.db",
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
          if (!gameState.users[uid].phone && phone) {
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

// 12 Bingo lines on 5x5 card (index 12 is FREE)
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
];

const BINGO_PATTERNS = [
  { id: "1_line", name: "1 መስመር", targetLines: 1, label: "1 መስመር ዝግ", description: "1 መስመር ሲዘጋ" }
];

function countCompletedLines(cardNumbers, calledSet) {
  if (!Array.isArray(cardNumbers) || cardNumbers.length !== 25) return 0;
  let count = 0;
  for (const line of WINNING_LINES) {
    if (line.every((idx) => idx === 12 || cardNumbers[idx] === 0 || cardNumbers[idx] === "FREE" || calledSet.has(Number(cardNumbers[idx])))) {
      count++;
    }
  }
  return count;
}

function checkCardBingo(cardNumbers, calledSet, pattern) {
  if (!Array.isArray(cardNumbers) || cardNumbers.length !== 25) return false;
  // Always 1 line bingo rule
  return countCompletedLines(cardNumbers, calledSet) >= 1;
}

class LiveBingoRoom {
  constructor(id, stake) {
    this.id = String(id);
    this.stake = Number(stake);
    this.status = "open"; // "open", "countdown", "live", "ended"
    this.roundId = 100 + (parseInt(id) || 10) + (String(id).includes("-2") ? 1 : 0);
    this.patternIndex = 0;
    this.players = []; // [{ user_id, username, first_name, card_ids: [1, 2], joined_at }]
    this.calls = []; // [14, 55, ...]
    this.deck = [];
    this.countdownEndsAt = 0;
    this.callIntervalMs = 3500;
    this.callTimer = null;
    this.countdownTimer = null;
    this.lastResult = null;
    this.enabled = true;
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
      players: this.players,
      player_count: this.players.length,
      total_cards: totalCards,
      derash: derash,
      calls: this.calls,
      last_result: this.lastResult,
      enabled: this.enabled,
    };
  }

  join(user, cardIds) {
    if (this.status === "live") {
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
      const bonus = Number(gameState.settings?.startingBonus != null ? gameState.settings.startingBonus : 10);
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
        }
      }
      this.players.splice(idx, 1);
      if (this.players.length === 0 && this.status === "countdown") {
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

    if (this.countdownTimer) clearTimeout(this.countdownTimer);
    this.countdownTimer = setTimeout(() => {
      this.startLiveGame();
    }, durationSec * 1000);
  }

  startLiveGame() {
    const totalCards = this.players.reduce((sum, p) => sum + (p.card_ids?.length || 0), 0);
    if (this.players.length === 0 || totalCards === 0) {
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
      this.endRound(null, "No Winner", 0, null);
      return;
    }

    const ball = this.deck.shift();
    this.calls.push(ball);

    const calledSet = new Set(this.calls);
    const activePattern = this.currentPattern;
    for (const player of this.players) {
      for (const cardId of (player.card_ids || [])) {
        const cardNumbers = cardCatalog[String(cardId)];
        if (cardNumbers && checkCardBingo(cardNumbers, calledSet, activePattern)) {
          const totalCards = this.players.reduce((sum, p) => sum + (p.card_ids?.length || 0), 0);
          const prize = this.getDerash(totalCards);

          this.endRound(player.user_id, player.first_name || player.username || "Player", prize, cardId);
          return;
        }
      }
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
    const activePattern = this.currentPattern;
    if (!cardNumbers || !checkCardBingo(cardNumbers, calledSet, activePattern)) {
      return { error: "Bingo not complete yet" };
    }

    const totalCards = this.players.reduce((sum, p) => sum + (p.card_ids?.length || 0), 0);
    const prize = this.getDerash(totalCards);

    this.endRound(userId, player.first_name || player.username || "Player", prize, cardId);
    return { ok: true, winner: player.first_name, prize };
  }

  endRound(winnerId, winnerName, prize, cardId) {
    if (this.callTimer) clearInterval(this.callTimer);
    this.callTimer = null;
    this.status = "ended";

    if (winnerId && prize > 0) {
      const u = gameState.users[winnerId];
      if (u) {
        u.balance = (u.balance || 0) + prize;
        saveGameState();
      }
    }

    const resultId = `RES_${this.id}_R${this.roundId}_${Math.floor(Date.now() / 1000)}`;
    this.lastResult = {
      result_id: resultId,
      round_id: this.roundId,
      winner_id: winnerId,
      winner_name: winnerName,
      prize: prize,
      card_id: cardId,
      pattern: this.currentPattern ? (this.currentPattern.label || this.currentPattern.name) : "1 መስመር",
      ended_at: Math.floor(Date.now() / 1000),
    };

    setTimeout(() => {
      this.resetRound();
    }, 14000);
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

function getUserFromHeaders(req, body = null) {
  const uid = (body && body.user_id) || req.headers["x-mobile-user-id"] || req.headers["x-telegram-user-id"] || "LB-PLAYER";
  const uname = (body && body.username) || req.headers["x-mobile-phone"] || req.headers["x-telegram-user-name"] || "";
  const name = uname ? (uname.startsWith("09") || uname.startsWith("+") || uname.startsWith("07") ? uname : `@${uname}`) : (uid !== "LB-PLAYER" ? `Player ${String(uid).slice(-4)}` : "Waliya Player");
  return { id: uid, username: uname, name };
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
      const bonus = Number(gameState.settings?.startingBonus != null ? gameState.settings.startingBonus : 10);
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
        bonus_claimed: 1,
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
        "admin", "0918182355", "918182355", "9029759446",
        "0939292694", "939292694",
        "berihun", "0999909474", "999909474",
        "su121316", "samtesfa19", "samienyew1000", "africabingooo", "waliyabingooo", "waliyabingo", "waliyabingo1_bot", "biregugsa", "ber63781"
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

      notifyTelegramAdmin(`📤 *የገንዘብ ማውጣት ጥያቄ (New Withdrawal Request)*\n\n👤 *ተጫዋች:* ${newTx.player}\n💰 *መጠን:* \`${amount} ETB\`\n📱 *ስልክ:* \`${newTx.phone}\`\n🏦 *መንገድ:* ${method}\n\n✅ ለማጽደቅ: ${WEB_APP_URL}admin.html`);

      return sendJson(res, {
        ok: true,
        id: txId,
        status: "pending",
        balance: targetUser ? targetUser.balance : 0
      });
    }

    // 4. Admin Overview (Live feed of rooms, transactions, players, settings)
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
      });
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

        // Find target user with flexible matching
        let targetUser = tx.user_id ? gameState.users[tx.user_id] : null;
        if (!targetUser) {
          const cleanTxPhone = cleanPhone(tx.phone);
          targetUser = Object.values(gameState.users).find(
            (u) => (tx.user_id && String(u.id) === String(tx.user_id)) ||
                   (cleanTxPhone && u.phone && cleanPhone(u.phone) === cleanTxPhone) ||
                   (tx.playerId && String(u.id).endsWith(String(tx.playerId).replace(/\D/g, ""))) ||
                   (tx.player && (u.name === tx.player || u.first_name === tx.player || u.username === tx.player))
          );
        }

        // DEPOSIT APPROVAL: Credit amount + 20% bonus
        if (action === "approve" && tx.type === "deposit") {
          const bonus = tx.amount >= 100 ? Math.floor(tx.amount * 0.2) : 0;
          const totalCredit = tx.amount + bonus;
          if (targetUser) {
            targetUser.balance = (Number(targetUser.balance) || 0) + totalCredit;
            targetUser.updated_at = new Date().toISOString();
            updateSqliteUserBalance(targetUser.id, targetUser.balance);

            if (targetUser.id && /^\d+$/.test(targetUser.id) && !String(targetUser.id).startsWith("09")) {
              telegramApi("sendMessage", {
                chat_id: targetUser.id,
                text: `✅ *ተቀማጭ ገንዘብዎ ጸድቋል!*\n\n💰 *የተጨመረ:* \`${totalCredit} ETB\`\n💵 *አሁን ያለዎት ቀሪ ሂሳብ:* \`${targetUser.balance} ETB\`\n\nመልካም ጨዋታ! 🎰`,
                parse_mode: "Markdown",
              }).catch(() => {});
            }
          }
          updateSqliteTransactionStatus(txId, "approved");
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
        "admin", "0918182355", "+251918182355", "918182355", "9029759446",
        "0939292694", "+251939292694", "939292694",
        "berihun", "0999909474", "+251999909474", "999909474",
        "su121316", "samtesfa19", "samienyew1000", "samienyew1000-boop", "africabingooo", "waliyabingooo", "waliyabingo", "waliyabingo1_bot", "biregugsa", "ber63781"
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
  console.log(`Waliya Bingo server running on port ${PORT}`);
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
  const targetIds = new Set();

  // Guaranteed admin Telegram IDs: Berihun (6220264098) & Sam (5663531258)
  targetIds.add("6220264098");
  targetIds.add("5663531258");

  for (const id of ADMIN_IDS) {
    const s = String(id).trim();
    if (s && /^\d+$/.test(s) && !s.startsWith("09") && s.length >= 8 && s !== "9029759446") {
      targetIds.add(s);
    }
  }

  if (Array.isArray(gameState.settings?.adminChatIds)) {
    for (const cid of gameState.settings.adminChatIds) {
      const s = String(cid).trim();
      if (s && /^\d+$/.test(s) && !s.startsWith("09") && s.length >= 8 && s !== "9029759446") {
        targetIds.add(s);
      }
    }
  }

  for (const u of Object.values(gameState.users || {})) {
    const uName = u.username ? String(u.username).toLowerCase().replace(/^@/, "") : "";
    const isUnameAdmin = uName && ADMIN_USERNAMES.includes(uName);
    const uId = String(u.id || "").trim();
    if ((u.role === "admin" || isUnameAdmin) && /^\d+$/.test(uId) && !uId.startsWith("09") && uId.length >= 8 && uId !== "9029759446") {
      targetIds.add(uId);
    }
  }

  console.log(`[NOTIFY ADMIN] Dispatching notification to ${targetIds.size} admin(s):`, Array.from(targetIds));

  for (const adminId of targetIds) {
    telegramApi("sendMessage", {
      chat_id: adminId,
      text: text,
      parse_mode: "Markdown",
    }).then((res) => {
      if (res && res.ok) {
        console.log(`[NOTIFY ADMIN SUCCESS] Notification delivered to ${adminId}`);
      } else {
        console.warn(`[NOTIFY ADMIN FAILED] Could not send to ${adminId}:`, res?.description || res?.error);
      }
    }).catch((err) => {
      console.warn(`[NOTIFY ADMIN ERROR] Network error sending to ${adminId}:`, err.message);
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
        text: "Play Bingo 🎰",
        web_app: { url: WEB_APP_URL },
      },
    });
  } catch (e) {}

  try {
    await telegramApi("deleteWebhook", { drop_pending_updates: true });
    console.log("[INFO] Successfully configured Telegram bot polling.");
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
            const rawUname = msg.from && msg.from.username ? msg.from.username : "";
            const uname = rawUname.toLowerCase().replace(/^@/, "");

            console.log(`[TG BOT INCOMING] chatId: ${chatId}, uname: @${uname}, name: ${firstName}, text: "${text}"`);

            if (!gameState.settings.adminChatIds) gameState.settings.adminChatIds = [];
            const isBerihun = String(chatId) === "6220264098" || uname === "ber63781" || (msg.from && (msg.from.id === 6220264098 || (msg.from.first_name && msg.from.first_name.toLowerCase().includes("berihun"))));
            const isAdmin = isBerihun || ADMIN_IDS.includes(String(chatId)) || (uname && ADMIN_USERNAMES.includes(uname));

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

            // Persistent Main Keyboard matching user screenshot
            const MAIN_REPLY_KEYBOARD = {
              keyboard: [
                [
                  { text: "🎮 Play Game", web_app: { url: WEB_APP_URL } }
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

            // Handle shared contact registration
            if (msg && msg.contact && msg.contact.phone_number) {
              const phone = String(msg.contact.phone_number).replace(/[\s\-\+]/g, "");
              if (!gameState.users[chatId]) {
                gameState.users[chatId] = {
                  id: String(chatId),
                  username: rawUname || uname,
                  first_name: firstName,
                  phone: phone,
                  balance: 10,
                  created_at: new Date().toISOString(),
                  source: "telegram",
                  is_verified: 1,
                };
              } else {
                gameState.users[chatId].phone = phone;
                gameState.users[chatId].is_verified = 1;
              }
              saveGameState();
              const uBal = Number(gameState.users[chatId]?.balance != null ? gameState.users[chatId].balance : 10);
              await telegramApi("sendMessage", {
                chat_id: chatId,
                text: `✅ *በተሳካ ሁኔታ ተመዝግበዋል*\nቦነስ: ${uBal}\nየሪፈራል ቦነስ: 10\n\nለመቀጠል ማውጫውን ይጠቀሙ::\n\nአንድ አማራጭ ይምረጡ:-`,
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
                  balance: 10,
                  created_at: new Date().toISOString(),
                  source: "telegram",
                  is_verified: 1,
                };
                gameState.users[chatId] = userRecord;
                saveGameState();
              }
              const uBal = Number(userRecord.balance != null ? userRecord.balance : 10);

              if (isAdmin) {
                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: `👋 ሰላም *${firstName}* (@${rawUname || uname || "Admin"})! ወደ *Waliya Bingo* እንኳን በደህና መጡ! 🎲\n\n🛡️ *የአስተዳዳሪ (Admin) መለያዎ ነቅቷል!*\n\n✅ *በተሳካ ሁኔታ ተመዝግበዋል*\nቦነስ: ${uBal}\nየሪፈራል ቦነስ: 10\n\nለመቀጠል ማውጫውን ይጠቀሙ::\n\nአንድ አማራጭ ይምረጡ:-`,
                  parse_mode: "Markdown",
                  reply_markup: MAIN_REPLY_KEYBOARD,
                });
              } else {
                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: `✅ *በተሳካ ሁኔታ ተመዝግበዋል*\nቦነስ: ${uBal}\nየሪፈራል ቦነስ: 10\n\nለመቀጠል ማውጫውን ይጠቀሙ::\n\nአንድ አማራጭ ይምረጡ:-`,
                  parse_mode: "Markdown",
                  reply_markup: MAIN_REPLY_KEYBOARD,
                });
              }
            } else if (text.includes("Deposit") || text.includes("ተቀማጭ") || text.includes("ዲፖዚት") || text === "/deposit") {
              const telePhone = gameState.settings.depositTelebirrPhone || "0975094812";
              const teleName = gameState.settings.depositTelebirrName || "ቃልኪዳን እንየው";
              const cbePhone = gameState.settings.depositCbeBirrPhone || "1000817750552";
              const cbeName = gameState.settings.depositCbeBirrName || "ቃልኪዳን እንየው";

              await telegramApi("sendMessage", {
                chat_id: chatId,
                text: `💰 *የተቀማጭ ሂሳብ መሙያ (Deposit)*\n\nገንዘብ ለማስገባት ከታች ያሉትን የሂሳብ ቁጥሮች ይጠቀሙ:\n\n📱 *ቴሌብር (Telebirr):*\n• ስልክ: \`${telePhone}\`\n• ስም: *${teleName}*\n\n🏦 *ንግድ ባንክ (CBE / CBE Birr):*\n• አካውንት: \`${cbePhone}\`\n• ስም: *${cbeName}*\n\n💡 *ማሳሰቢያ:* ገንዘብ ካስተላለፉ በኋላ ከታች **🎮 Play Game** የሚለውን ተጭነው በጨዋታው ውስጥ *Deposit* የሚለውን በመንካት የደረሰኝ ስክሪንሾት ወይም የሂሳብ ቁጥርዎን ያስገቡ። ጥያቄዎ ፈጣን ምላሽ ያገኛል!`,
                parse_mode: "Markdown",
                reply_markup: MAIN_REPLY_KEYBOARD,
              });
            } else if (text.includes("Withdraw") || text.includes("ማውጣት") || text === "/withdraw") {
              await telegramApi("sendMessage", {
                chat_id: chatId,
                text: `💸 *ገንዘብ ማውጣት (Withdraw)*\n\nያሸነፉትን ገንዘብ በቀላሉ ለማውጣት:\n1. ከታች **🎮 Play Game** የሚለውን ይጫኑ\n2. በጨዋታው ውስጥ የ **Wallet** ገጽ ይክፈቱ\n3. ማውጣት የሚፈልጉትን መጠን እና የቴሌብር ወይም የባንክ ሂሳብ ቁጥርዎን ያስገቡ\n\n📌 *ዝቅተኛው ማውጣት የሚቻለው:* \`50 ETB\`\n⚡ *ክፍያ:* በጥቂት ደቂቃዎች ውስጥ ይፈጸማል!`,
                parse_mode: "Markdown",
                reply_markup: MAIN_REPLY_KEYBOARD,
              });
            } else if (text.includes("Balance") || text.includes("ሂሳብ") || text === "/balance") {
              const curUser = gameState.users[chatId] || {};
              const curBal = Number(curUser.balance != null ? curUser.balance : 10);
              await telegramApi("sendMessage", {
                chat_id: chatId,
                text: `💳 *የሂሳብዎ ቀሪ (Your Balance)*\n\n👤 *ተጠቃሚ:* ${firstName}\n💰 *የዋና ሂሳብ ቀሪ:* \`${curBal}\` ETB\n🎁 *የሪፈራል ቦነስ:* \`10\` ETB\n\n🎲 ለመጫወት ከታች **🎮 Play Game** የሚለውን ይጫኑ!`,
                parse_mode: "Markdown",
                reply_markup: MAIN_REPLY_KEYBOARD,
              });
            } else if (text.includes("Support") || text.includes("ድጋፍ") || text === "/support") {
              await telegramApi("sendMessage", {
                chat_id: chatId,
                text: `📞 *የደንበኞች አገልግሎት እና ድጋፍ (Customer Support)*\n\nለማንኛውም አይነት ጥያቄ፣ አስተያየት ወይም የክፍያ እርዳታ አድሚኖችን ያግኙ:\n\n👉 *ቴሌግራም:* @su121316\n📞 *ስልክ:* \`+251918182355\`\n\nእርስዎን ለማገልገል 24/7 ዝግጁ ነን!`,
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
                text: `🎁 *ጓደኞችዎን ይጋብዙ እና ቦነስ ያግኙ (Invite Friends)*\n\nየእርስዎን መጋበዣ ሊንክ ለጓደኞችዎ ያጋሩ:\n👉 \`https://t.me/waliyabingo1_bot?start=ref_${chatId}\`\n\nጓደኛዎ በእርስዎ ሊንክ ተመዝግቦ ሲጫወት የ 10 ETB ተጨማሪ ቦነስ ያገኛሉ!`,
                parse_mode: "Markdown",
                reply_markup: MAIN_REPLY_KEYBOARD,
              });
            } else if (text.startsWith("/admin")) {
              if (isAdmin) {
                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: `🛡️ *Waliya Bingo — Admin Control Center*\n\nየአስተዳዳሪ ፓነልን ለመክፈት ከታች ያለውን ይጫኑ:\n👉 [Admin Console መክፈቻ](${WEB_APP_URL}admin.html?role=admin&u=${chatId})`,
                  parse_mode: "Markdown",
                  reply_markup: MAIN_REPLY_KEYBOARD,
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
                text: `ℹ️ *የመለያ መረጃ (Account Info)*\n\n🆔 *Chat ID:* \`${chatId}\`\n👤 *Username:* @${rawUname || "None"}\n🛡️ *Role:* ${isAdmin ? "👑 Admin (Receives Alerts)" : "Player"}`,
                parse_mode: "Markdown",
                reply_markup: MAIN_REPLY_KEYBOARD,
              });
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
