const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT || "3000", 10);
const PUBLIC_DIR = __dirname;
const STATE_FILE = path.join(__dirname, "game-state.json");
const BACKUP_STATE_FILE = path.join(__dirname, "game-state.backup.json");
const ROOT_BACKUP_FILE = "/var/backups/africa-bingo-state.json";
const BOT_TOKEN = process.env.BOT_TOKEN || "8882887936:AAEXtkABLYGWPSC-r4tXRMAOzET9Jp21NUQ";
const WEB_APP_URL = (process.env.WEB_APP_URL || "https://africa-bingo.ethiodeploy.com/").replace(/\/+$/, "") + "/";
const rawAdminUsernames = process.env.ADMIN_USERNAMES || "0999909474,su121316,samtesfa19,samienyew1000,Africabingooo,Biregugsa";
const ADMIN_USERNAMES = rawAdminUsernames.split(",").map((u) => u.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);
const rawAdminIds = process.env.ADMIN_TELEGRAM_IDS || "5663531258,0999909474";
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
    { id: "10", stake: 10, players: 0, status: "waiting", roundId: "#AB-101", prizePool: 0, called: [] },
    { id: "20", stake: 20, players: 0, status: "waiting", roundId: "#AB-102", prizePool: 0, called: [] },
    { id: "50", stake: 50, players: 0, status: "waiting", roundId: "#AB-103", prizePool: 0, called: [] },
  ],
  settings: {
    countdown: 120,
    commissionRate: 20,
    minDeposit: 50,
    depositBonus: 20,
    bonusThreshold: 100,
    startingBonus: 0,
    startingBonusEnabled: false,
    depositTelebirrPhone: "0918182355",
    depositTelebirrName: "Berihun",
    depositCbeBirrPhone: "1000076108653",
    depositCbeBirrName: "Berihun",
    depositMpesaPhone: "0700 000 000",
    depositMpesaName: "Africa Bingo M-Pesa",
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
      settings: { ...DEFAULT_STATE.settings, ...(fileData?.settings || {}) },
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

loadGameState();

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
  { id: "3_lines", name: "3 መስመር", targetLines: 3, label: "3 መስመር ዝግ", description: "3 መስመር ሲዘጋ" },
  { id: "4_lines", name: "4 መስመር", targetLines: 4, label: "4 መስመር ዝግ", description: "4 መስመር ሲዘጋ" },
  { id: "5_lines", name: "5 መስመር", targetLines: 5, label: "5 መስመር ዝግ", description: "5 መስመር ሲዘጋ" },
  { id: "6_lines", name: "6 መስመር", targetLines: 6, label: "6 መስመር ዝግ", description: "6 መስመር ሲዘጋ" },
  { id: "7_lines", name: "7 መስመር", targetLines: 7, label: "7 መስመር ዝግ", description: "7 መስመር ሲዘጋ" },
  { id: "fullhouse", name: "ሙሉ ካርቴላ", targetLines: 24, isFullHouse: true, label: "ሙሉ ካርቴላ (Full House)", description: "ሙሉ ካርቴላ ሲዘጋ" },
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
  if (!pattern) {
    return countCompletedLines(cardNumbers, calledSet) >= 3;
  }
  if (pattern.isFullHouse || pattern.id === "fullhouse") {
    return cardNumbers.every((val, idx) =>
      idx === 12 || val === 0 || val === "FREE" || calledSet.has(Number(val))
    );
  }
  const req = Number(pattern.targetLines || 3);
  return countCompletedLines(cardNumbers, calledSet) >= req;
}

class LiveBingoRoom {
  constructor(id, stake) {
    this.id = String(id);
    this.stake = Number(stake);
    this.status = "open"; // "open", "countdown", "live", "ended"
    this.roundId = 100 + Number(id);
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
    const durationSec = Math.max(10, Number(gameState.settings?.countdown || 120));
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

    this.lastResult = {
      winner_id: winnerId,
      winner_name: winnerName,
      prize: prize,
      card_id: cardId,
      pattern: this.currentPattern ? (this.currentPattern.label || this.currentPattern.name) : "3 መስመር",
      ended_at: Math.floor(Date.now() / 1000),
    };

    setTimeout(() => {
      this.resetRound();
    }, 10000);
  }

  resetRound() {
    this.status = "open";
    this.roundId += 1;
    this.patternIndex = (this.patternIndex + 1) % BINGO_PATTERNS.length;
    this.players = [];
    this.calls = [];
    this.deck = [];
    this.countdownEndsAt = 0;
  }
}

const activeRooms = {
  "10": new LiveBingoRoom("10", 10),
  "20": new LiveBingoRoom("20", 20),
  "50": new LiveBingoRoom("50", 50),
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
  const name = uname ? (uname.startsWith("09") || uname.startsWith("+") || uname.startsWith("07") ? uname : `@${uname}`) : (uid !== "LB-PLAYER" ? `Player ${String(uid).slice(-4)}` : "Africa Player");
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
      const fullName = String(body.name || body.fullName || body.nickname || "").trim();
      const password = String(body.password || "").trim();
      const avatar = String(body.avatar || "").trim();

      if (!phone || phone.length < 9) {
        return sendJson(res, { ok: false, error: "invalid_phone", message: "ትክክለኛ ስልክ ቁጥር ያስገቡ" }, 400);
      }

      if (phone.startsWith("+251")) phone = "0" + phone.slice(4);
      else if (phone.startsWith("251")) phone = "0" + phone.slice(3);

      // Check if user with this phone already exists in gameState.users
      let existingUser = Object.values(gameState.users).find(
        (u) => (u.phone && u.phone === phone) || (u.username && u.username === phone)
      );

      if (existingUser) {
        return sendJson(res, { ok: false, error: "already_exists", message: "ይህ ስልክ ቁጥር ቀድሞ ተመዝግቧል፤ እባክዎ ይግቡ (Login)።" });
      }

      // Generate unique user id
      const userId = String(Math.floor(9000000000 + Math.random() * 999999999));
      const bonus = Number(gameState.settings?.startingBonus != null ? gameState.settings.startingBonus : 10);
      const newUser = {
        id: userId,
        phone: phone,
        username: phone,
        first_name: fullName || `Player ${phone.slice(-4)}`,
        name: fullName || `Player ${phone.slice(-4)}`,
        password: password,
        avatar: avatar || "AB",
        balance: bonus,
        bonus_balance: bonus,
        bonus_claimed: 1,
        role: "player",
        is_verified: 1,
        created_at: new Date().toISOString(),
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

      // Check for Admin Login
      if (phone.toLowerCase() === "admin") {
        if (password === "Ber23@ret" || password === "AF7694") {
          let adminUser = gameState.users["admin-1"];
          if (!adminUser) {
            adminUser = {
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
        } else {
          return sendJson(res, { ok: false, error: "wrong_password", message: "የተሳሳተ የይለፍ ቃል። እባክዎ እንደገና ይሞክሩ።" }, 401);
        }
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
      const roomsOverview = Object.values(activeRooms).map(r => r.getState());
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
      const body = await parseJsonBody(req);
      const username = String(body.username || "").trim().toLowerCase();
      const password = String(body.password || "").trim();
      const validAdminUsers = ["admin", "0999909474", "999909474", "su121316", "samtesfa19", "samienyew1000", "samienyew1000-boop", "africabingooo", "biregugsa"];
      if (validAdminUsers.includes(username) && (password === "Ber23@ret" || password === "AF7694")) {
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
      const rList = Object.values(activeRooms).map((r) => r.getState());
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
  console.log(`Africa Bingo server running on port ${PORT}`);
  try {
    const { spawn } = require("child_process");
    const pyCmd = process.platform === "win32" ? "python" : "python3";
    const py = spawn(pyCmd, ["bot.py"], { stdio: "inherit" });
    py.on("error", () => {
      console.log(`[INFO] ${pyCmd} not available, running built-in Node bot handler.`);
      startTelegramBot();
    });
  } catch (e) {
    startTelegramBot();
  }
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
                text: `👋 ሰላም *${firstName}*! ወደ *Africa Bingo* እንኳን በደህና መጡ! 🎲\n\n🎁 *የ 10 ETB የመመዝገቢያ ቦነስ ተሰጥቷችኋል!*\n\nለመጫወት ከታች ያለውን **Play Africa Bingo 🎮** የሚለውን ቁልፍ ይጫኑ!`,
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: "Play Africa Bingo 🎮 (10 ETB Bonus)",
                        web_app: { url: WEB_APP_URL },
                      },
                    ],
                  ],
                },
              });
            } else if (text.startsWith("/admin")) {
              const uname = msg.from && msg.from.username ? msg.from.username.toLowerCase() : "";
              const isAdmin = ADMIN_IDS.includes(String(chatId)) || (uname && ADMIN_USERNAMES.includes(uname));
              if (isAdmin) {
                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: `🛡️ *Africa Bingo — Admin Control Center*\n\nየአስተዳዳሪ ፓነልን ለመክፈት ከታች ያለውን ይጫኑ:`,
                  parse_mode: "Markdown",
                  reply_markup: {
                    inline_keyboard: [
                      [
                        {
                          text: "🌐 Admin Panel (Web Console)",
                          web_app: { url: `${WEB_APP_URL}admin.html?role=admin&u=${chatId}` },
                        },
                      ],
                    ],
                  },
                });
              } else {
                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: `⛔ *ይቅርታ! ይህንን ትዕዛዝ ለመጠቀም የአስተዳዳሪ (Admin) ፈቃድ የለዎትም።*`,
                  parse_mode: "Markdown",
                });
              }
            }
          }
        }
      }
    } catch (err) {}
    setTimeout(poll, 1500);
  }

  poll();
}
