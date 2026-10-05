"use strict";

const ADMIN_STATE_KEY = "lucky-bingo-admin-state-v1";
const ADMIN_SETTINGS_KEY = "lucky-bingo-admin-settings-v1";
const ROOM_CATALOG_KEY = "lucky-bingo-room-catalog-v1";
const ROOM_LIFECYCLE_KEY = "lucky-bingo-room-lifecycle-v1";
const WINNING_PATTERN_OPTIONS = Object.freeze(["1", "2", "3", "4", "full-house"]);

const ADMIN_AUTH_CONFIG = {
  validUsers: ["0999909474", "+251999909474", "999909474", "su121316", "samtesfa19"],
  password: "Sj$0332#89",
};

function checkAdminAuth() {
  return (
    sessionStorage.getItem("lb_admin_auth") === "true" ||
    localStorage.getItem("lb_admin_auth") === "true"
  );
}

function updateAdminUIAuth(isAuthenticated, username = "") {
  const overlay = $("admin-login-overlay");
  const shell = $("admin-shell");
  if (!overlay || !shell) return;

  if (isAuthenticated) {
    overlay.hidden = true;
    shell.style.display = "";
    if (username) {
      const displayUser = username.startsWith("@") || /^\+?\d+$/.test(username) ? username : "@" + username;
      if ($("admin-user-name")) $("admin-user-name").textContent = displayUser;
      if ($("admin-user-role")) $("admin-user-role").textContent = "Super administrator";
    }
    syncAdminWithServer();
  } else {
    sessionStorage.removeItem("lb_admin_auth");
    sessionStorage.removeItem("lb_admin_token");
    sessionStorage.removeItem("lb_admin_password");
    sessionStorage.removeItem("lb_admin_user");
    localStorage.removeItem("lb_admin_auth");
    localStorage.removeItem("lb_admin_token");
    localStorage.removeItem("lb_admin_password");
    localStorage.removeItem("lb_admin_user");

    overlay.hidden = false;
    shell.style.display = "none";
    if (typeof LuckyBingoAPI !== "undefined" && LuckyBingoAPI.stopAdminPoll) {
      LuckyBingoAPI.stopAdminPoll();
    }
    const userInp = $("admin-login-username");
    if (userInp) {
      if (!userInp.value) userInp.value = "0999909474";
      setTimeout(() => $("admin-login-password")?.focus(), 50);
    }
  }
}

const $ = (id) => document.getElementById(id);

const DEFAULT_STATE = {
  metrics: {
    totalPlayers: 0,
    verifiedPlayers: 0,
    newPlayers: 0,
    blockedPlayers: 0,
    idlePlayers: 0,
    processedToday: 0,
  },
  rooms: [
    {
      id: "10",
      stake: 10,
      players: 0,
      status: "waiting",
      enabled: true,
      roundId: "#LB-24090",
      prizePool: 0,
      lastCall: "—",
      called: [],
      color: "blue",
    },
    {
      id: "20",
      stake: 20,
      players: 0,
      status: "waiting",
      enabled: true,
      roundId: "#LB-24091",
      prizePool: 0,
      lastCall: "—",
      called: [],
      color: "orange",
    },
    {
      id: "50",
      stake: 50,
      players: 0,
      status: "waiting",
      enabled: true,
      roundId: "#LB-24089",
      prizePool: 0,
      lastCall: "—",
      called: [],
      color: "purple",
    },
  ],
  transactions: [],
  players: [],
  activities: [
    { kind: "finance", symbol: "↗", text: "Approved a deposit request for Hana Tesfaye", time: "8 min ago" },
    { kind: "game", symbol: "◉", text: "Started round #LB-24091 in the 20 ETB room", time: "14 min ago" },
    { kind: "security", symbol: "!", text: "Blocked player account LB-00384", time: "27 min ago" },
    { kind: "finance", symbol: "↙", text: "Paid 1,800 ETB in withdrawal requests", time: "42 min ago" },
    { kind: "game", symbol: "✦", text: "The 10 ETB room reached 100 players", time: "1 hour ago" },
  ],
};

const DEFAULT_SETTINGS = {
  commission: 20,
  threshold: 10,
  countdown: 60,
  winningPattern: "1",
  startingBonus: 50,
  startingBonusEnabled: true,
  autoCall: true,
  maintenance: false,
  transactionAlerts: true,
  largeWithdrawal: true,
  timeout: "60",
  depositTelebirrPhone: "0999909474",
  depositTelebirrName: "Africa Bingo",
  depositCbeBirrPhone: "1000 000 000",
  depositCbeBirrName: "Africa Bingo CBE Birr",
  depositMpesaPhone: "0700 000 000",
  depositMpesaName: "Africa Bingo M-Pesa",
};

let state = loadState();
let settings = loadSettings();
let selectedLiveRoomId = state.rooms[0]?.id || "";
let transactionFilter = "all";
let transactionQuery = "";
let transactionStatusFilter = "all";
let playerQuery = "";
let playerStatusFilter = "all";
let liveTimer = null;
let toastTimer = null;

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

const REAL_ROOM_PLAYERS_KEY = "lucky-bingo-real-room-players-v2";

function getRealRoomParticipants() {
  try {
    const data = JSON.parse(localStorage.getItem(REAL_ROOM_PLAYERS_KEY) || "{}");
    return typeof data === "object" && data !== null ? data : {};
  } catch (e) {
    return {};
  }
}

function sanitizeRoomCatalog(rooms) {
  if (!Array.isArray(rooms)) return copy(DEFAULT_STATE.rooms);
  const participants = getRealRoomParticipants();
  return rooms.map((room) => {
    const realList = Array.isArray(participants[String(room.id)]) ? participants[String(room.id)] : [];
    const count = realList.length;
    return {
      ...room,
      players: count,
      prizePool: count * (Number(room.stake) || 0),
      status: room.status === "paused" ? "paused" : (count > 0 ? (room.status === "waiting" ? "waiting" : room.status) : "waiting"),
    };
  });
}

function syncRoomsWithRealParticipants() {
  // Authoritative server state only: do not override rooms from local storage.
}

function loadRoomCatalog(legacyRooms = null) {
  try {
    const savedCatalog = JSON.parse(localStorage.getItem(ROOM_CATALOG_KEY) || "null");
    if (Array.isArray(savedCatalog)) {
      const sanitized = sanitizeRoomCatalog(savedCatalog);
      localStorage.setItem(ROOM_CATALOG_KEY, JSON.stringify(sanitized));
      return sanitized;
    }

    if (Array.isArray(legacyRooms)) {
      const migratedRooms = sanitizeRoomCatalog(legacyRooms);
      localStorage.setItem(ROOM_CATALOG_KEY, JSON.stringify(migratedRooms));
      return migratedRooms;
    }
  } catch (error) {
    // Fall back to the legacy admin state or defaults when storage is unavailable.
  }
  const defaults = copy(DEFAULT_STATE.rooms);
  try {
    localStorage.setItem(ROOM_CATALOG_KEY, JSON.stringify(defaults));
  } catch (e) {}
  return defaults;
}

const PLAYER_BALANCES_KEY = "lucky-bingo-player-balances-v1";

function loadPlayerBalances() {
  try {
    return JSON.parse(localStorage.getItem(PLAYER_BALANCES_KEY) || "{}");
  } catch (e) {
    return {};
  }
}

function savePlayerBalance(playerId, newBalance) {
  try {
    const balances = loadPlayerBalances();
    balances[String(playerId)] = Number(newBalance);
    localStorage.setItem(PLAYER_BALANCES_KEY, JSON.stringify(balances));
  } catch (e) {}
}

function getLiveTelegramPlayers() {
  if (Array.isArray(window.LUCKY_BINGO_PLAYERS)) {
    return copy(window.LUCKY_BINGO_PLAYERS);
  }
  return [];
}

// Purge any stale legacy local transactions from previous sessions
try {
  const _rawAdmin = JSON.parse(localStorage.getItem(ADMIN_STATE_KEY) || "null");
  if (_rawAdmin && _rawAdmin.transactions) {
    delete _rawAdmin.transactions;
    localStorage.setItem(ADMIN_STATE_KEY, JSON.stringify(_rawAdmin));
  }
} catch (e) {}

function loadState() {
  return {
    ...copy(DEFAULT_STATE),
    metrics: {
      totalPlayers: 0,
      verifiedPlayers: 0,
      newPlayers: 0,
      blockedPlayers: 0,
      idlePlayers: 0,
      processedToday: 0,
    },
    rooms: copy(DEFAULT_STATE.rooms),
    transactions: [],
    players: [],
    activities: copy(DEFAULT_STATE.activities),
  };
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(ADMIN_SETTINGS_KEY) || "null") || {};
    const loaded = { ...DEFAULT_SETTINGS, ...saved };
    loaded.winningPattern = WINNING_PATTERN_OPTIONS.includes(String(loaded.winningPattern))
      ? String(loaded.winningPattern)
      : DEFAULT_SETTINGS.winningPattern;
    return loaded;
  } catch (error) {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveState() {
  const toSave = { ...state, transactions: [] };
  localStorage.setItem(ADMIN_STATE_KEY, JSON.stringify(toSave));
  localStorage.setItem(ROOM_CATALOG_KEY, JSON.stringify(state.rooms));
}

function saveSettings() {
  localStorage.setItem(ADMIN_SETTINGS_KEY, JSON.stringify(settings));
  window.LUCKY_BINGO_PAYMENT_METHODS = {
    Telebirr: {
      accountName: settings.depositTelebirrName || "Africa Bingo",
      accountNumber: settings.depositTelebirrPhone || "0999909474",
    },
    "CBE Birr": {
      accountName: settings.depositCbeBirrName || "Africa Bingo CBE Birr",
      accountNumber: settings.depositCbeBirrPhone || "1000 000 000",
    },
    "M-Pesa": {
      accountName: settings.depositMpesaName || "Africa Bingo M-Pesa",
      accountNumber: settings.depositMpesaPhone || "0700 000 000",
    },
  };
}

function escapeHTML(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function fmt(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function money(value) {
  return `${fmt(value)} ETB`;
}

function initials(name) {
  if (!name) return "PL";
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "PL";
  return (
    parts
      .slice(0, 2)
      .map((part) => {
        const chars = Array.from(part);
        return chars[0] || "";
      })
      .join("")
      .toUpperCase() || "PL"
  );
}

function currentRoom() {
  return state.rooms.find((room) => room.id === selectedLiveRoomId) || state.rooms[0] || null;
}

function pendingTransactions() {
  return state.transactions.filter((transaction) => transaction.status === "pending");
}

function addActivity(text, kind = "finance", symbol = "•") {
  state.activities.unshift({ kind, symbol, text, time: "just now" });
  state.activities = state.activities.slice(0, 12);
  saveState();
}

function showToast(text, kind = "success") {
  const toast = $("admin-toast");
  if (!toast) return;
  toast.textContent = text;
  toast.className = `admin-toast is-${kind}`;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2600);
}

function showSection(name, updateHash = true) {
  const isDepositShortcut = name === "deposit-accounts";
  const valid = ["overview", "live", "transactions", "players", "reports", "settings"];
  const page = isDepositShortcut ? "settings" : (valid.includes(name) ? name : "overview");
  document.querySelectorAll(".admin-section").forEach((section) => {
    section.classList.toggle("is-active", section.dataset.page === page);
  });
  document.querySelectorAll(".admin-nav-link[data-section]").forEach((link) => {
    link.classList.toggle("is-active", link.dataset.section === (isDepositShortcut ? "deposit-accounts" : page));
  });
  const label = document.querySelector(`.admin-nav-link[data-section="${isDepositShortcut ? "deposit-accounts" : page}"] span:last-child`);
  if ($("current-section-label")) $("current-section-label").textContent = label ? label.textContent : (isDepositShortcut ? "Deposit Accounts" : page);
  if (updateHash && window.location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  if (isDepositShortcut) {
    setTimeout(() => {
      document.getElementById("settings-deposit-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 40);
  }
  if (page === "live") {
    renderLive();
    startLiveTimer();
  } else {
    stopLiveTimer();
  }
  $("admin-sidebar")?.classList.remove("is-open");
}

function renderDashboard() {
  syncRoomsWithRealParticipants();
  const online = state.rooms.filter((room) => room.status === "live" && room.enabled).reduce((total, room) => total + room.players, 0);
  $("stat-players").textContent = fmt(state.metrics.totalPlayers);
  $("stat-online").textContent = fmt(online);
  $("stat-revenue").innerHTML = `${fmt(state.metrics.processedToday)} <small>ETB</small>`;
  $("stat-attention").textContent = String(pendingTransactions().length);
  $("active-count").textContent = fmt(Math.max(0, state.metrics.totalPlayers - state.metrics.blockedPlayers - state.metrics.idlePlayers));
  $("idle-count").textContent = fmt(state.metrics.idlePlayers);
  $("blocked-count").textContent = fmt(state.metrics.blockedPlayers);
  $("active-percent").textContent = String(Math.round(((state.metrics.totalPlayers - state.metrics.blockedPlayers) / state.metrics.totalPlayers) * 100));
  $("player-donut").style.background = `conic-gradient(#3e8de5 0 ${Math.max(0, 100 - state.metrics.idlePlayers / state.metrics.totalPlayers * 100 - state.metrics.blockedPlayers / state.metrics.totalPlayers * 100)}%, #f2b84b ${Math.max(0, 100 - state.metrics.idlePlayers / state.metrics.totalPlayers * 100 - state.metrics.blockedPlayers / state.metrics.totalPlayers * 100)}% ${Math.max(0, 100 - state.metrics.blockedPlayers / state.metrics.totalPlayers * 100)}%, #e56a76 ${Math.max(0, 100 - state.metrics.blockedPlayers / state.metrics.totalPlayers * 100)}% 100%)`;
  $("nav-live-badge").textContent = String(state.rooms.filter((room) => room.status === "live").length);
  $("nav-transaction-badge").textContent = String(pendingTransactions().length);
  $("notification-count").textContent = String(Math.min(9, Math.max(1, pendingTransactions().length)));
  $("queue-total").textContent = String(pendingTransactions().length);
  $("queue-age").textContent = pendingTransactions().length ? "oldest 18m" : "queue clear";
  $("dashboard-round-label").textContent = currentRoom() ? `Round ${currentRoom().roundId} in progress` : "No active round";
  renderDashboardRooms();
  renderDashboardTransactions();
  renderActivity();
}

function renderDashboardRooms() {
  const container = $("dashboard-rooms");
  if (!container) return;
  container.innerHTML = state.rooms.map((room) => {
    const statusLabel = room.status === "live" ? `Calling ${room.lastCall}` : room.status === "paused" ? "Paused by admin" : "Waiting for players";
    const statusClass = room.status === "live" ? "is-live" : room.status === "waiting" ? "is-waiting" : "is-paused";
    return `<div class="admin-room-row"><i class="admin-room-color admin-room-color-${escapeHTML(room.color)}"></i><div class="admin-room-copy"><strong>${money(room.stake)} room</strong><span>${escapeHTML(statusLabel)}</span></div><div class="admin-room-players"><span>${fmt(room.players)}</span><small>players</small></div><span class="admin-room-status ${statusClass}">${room.status === "live" ? "Live" : room.status === "paused" ? "Paused" : "Waiting"}</span></div>`;
  }).join("");
}

function renderDashboardTransactions() {
  const container = $("dashboard-transactions");
  if (!container) return;
  const rows = pendingTransactions().slice(0, 4);
  container.innerHTML = rows.length ? rows.map((transaction) => `<div class="admin-mini-transaction"><span class="admin-mini-icon is-${transaction.type}">${transaction.type === "deposit" ? "↗" : "↙"}</span><div class="admin-mini-copy"><strong>${escapeHTML(transaction.player)}</strong><span>${escapeHTML(transaction.type)} · ${escapeHTML(transaction.requested)}</span></div><strong class="admin-mini-amount">${money(transaction.amount)}</strong></div>`).join("") : `<p class="admin-empty-note">No requests are waiting for review.</p>`;
}

function renderActivity() {
  const container = $("activity-list");
  if (!container) return;
  container.innerHTML = state.activities.length ? state.activities.slice(0, 5).map((activity) => `<div class="admin-activity-item"><span class="admin-activity-icon is-${escapeHTML(activity.kind)}">${escapeHTML(activity.symbol)}</span><div class="admin-activity-copy">${escapeHTML(activity.text)}</div><time>${escapeHTML(activity.time)}</time></div>`).join("") : `<p class="admin-empty-note">Activity will appear here as actions are taken.</p>`;
}

function roomStatusLabel(status) {
  if (status === "live") return "LIVE";
  if (status === "paused") return "PAUSED";
  return "WAITING";
}

function renderLive() {
  const room = currentRoom();
  const tabs = $("live-room-tabs");
  if (!room) {
    tabs.innerHTML = '<p class="admin-empty-note">Add a room to begin managing bingo rounds.</p>';
    $("live-room-management").innerHTML = '<p class="admin-empty-note">No rooms configured yet.</p>';
    return;
  }
  selectedLiveRoomId = room.id;
  tabs.innerHTML = state.rooms.map((item) => `<button type="button" class="admin-room-tab${item.id === room.id ? " is-active" : ""}" data-live-room="${escapeHTML(item.id)}">${money(item.stake)} room <span>· ${item.status === "live" ? "Live" : item.status === "paused" ? "Paused" : "Waiting"}</span></button>`).join("");
  $("live-room-title").textContent = `${room.stake} ETB room`;
  $("live-round-state").className = `admin-round-state ${room.status === "paused" ? "is-paused" : room.status === "live" ? "is-live" : "is-paused"}`;
  $("live-round-state").innerHTML = `<i></i> ${roomStatusLabel(room.status)}`;
  $("live-call-ball").textContent = room.lastCall || "—";
  $("live-call-count").textContent = String(room.called.length);
  $("live-round-progress").style.width = `${Math.min(100, Math.round(room.called.length / 75 * 100))}%`;
  $("live-round-id").textContent = room.roundId;
  $("live-prize-pool").textContent = money(room.prizePool);
  $("live-player-count").textContent = fmt(room.players);
  $("live-card-count").textContent = fmt(room.players);
  $("live-callers").textContent = String(Math.max(1, Math.round(room.players / 27)));
  $("live-average-call").textContent = room.status === "live" ? "01:42" : "—";
  $("toggle-round-button").textContent = room.status === "live" ? "Pause round" : room.status === "paused" ? "Resume round" : "Start round";
  $("toggle-round-button").disabled = room.status === "waiting" && !room.enabled;
  renderCallHistory(room);
  renderRoomManagement();
}

function renderCallHistory(room) {
  const history = $("live-call-history");
  const values = room.called.slice(-10).reverse();
  history.innerHTML = values.length ? values.map((value) => `<span class="admin-call-ball">${escapeHTML(value)}</span>`).join("") : `<p class="admin-empty-note">No numbers have been called yet.</p>`;
  $("call-history-note").textContent = values.length ? `${values.length} most recent calls · newest first` : "Most recent calls appear here.";
}

function renderRoomManagement() {
  const container = $("live-room-management");
  if (!container) return;
  container.innerHTML = state.rooms.length
    ? state.rooms.map((room) => `<div class="admin-management-row"><div class="admin-management-room-copy"><strong>${money(room.stake)} room</strong><span>${fmt(room.players)} players · ${room.status === "live" ? "Live" : room.status === "paused" ? "Paused" : "Waiting"}</span></div><button type="button" class="admin-room-toggle${room.enabled ? " is-on" : ""}" data-room-toggle="${escapeHTML(room.id)}" aria-label="${room.enabled ? "Disable" : "Enable"} ${room.stake} ETB room"></button><button type="button" class="admin-room-remove" data-room-remove="${escapeHTML(room.id)}" aria-label="Remove ${room.stake} ETB room">Remove</button></div>`).join("")
    : '<p class="admin-empty-note">No rooms configured yet.</p>';
}

function makeRoomId(stake) {
  const base = String(Math.max(1, Math.round(Number(stake) || 0)));
  if (!state.rooms.some((room) => String(room.id) === base)) return base;
  let suffix = 2;
  while (state.rooms.some((room) => String(room.id) === `${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function addRoomFromForm(event) {
  event.preventDefault();
  const stake = Math.max(1, Math.round(Number($("room-add-stake").value) || 0));
  const players = Math.max(0, Math.floor(Number($("room-add-players").value) || 0));
  if (!stake) {
    showToast("Enter a valid room stake.", "error");
    return;
  }
  if (state.rooms.some((room) => Number(room.stake) === stake)) {
    showToast(`${stake} ETB room already exists.`, "error");
    return;
  }
  const room = {
    id: makeRoomId(stake),
    stake,
    players,
    status: "waiting",
    enabled: true,
    roundId: `#LB-${24090 + state.rooms.length + 1}`,
    lifecycleVersion: 1,
    prizePool: stake * players,
    lastCall: "—",
    called: [],
    color: ["blue", "orange", "purple", "green", "pink"][state.rooms.length % 5],
  };
  state.rooms.push(room);
  selectedLiveRoomId = room.id;
  addActivity(`Added a ${stake} ETB room`, "game", "+");
  saveState();
  event.target.reset();
  $("room-add-players").value = "0";
  renderAll();
  showSection("live");
  showToast(`${stake} ETB room added to the player lobby.`);
}

function clearRoomLifecycle(roomId) {
  try {
    const savedLifecycle = JSON.parse(localStorage.getItem(ROOM_LIFECYCLE_KEY) || "null");
    if (!savedLifecycle || typeof savedLifecycle !== "object" || Array.isArray(savedLifecycle)) return;
    delete savedLifecycle[String(roomId)];
    localStorage.setItem(ROOM_LIFECYCLE_KEY, JSON.stringify(savedLifecycle));
  } catch (error) {
    // Room removal remains authoritative even if supplemental lifecycle storage is unavailable.
  }
}

function removeRoom(roomId) {
  const room = state.rooms.find((item) => String(item.id) === String(roomId));
  if (!room) return;
  state.rooms = state.rooms.filter((item) => String(item.id) !== String(roomId));
  clearRoomLifecycle(roomId);
  if (String(selectedLiveRoomId) === String(roomId)) selectedLiveRoomId = state.rooms[0]?.id || "";
  addActivity(`Removed the ${room.stake} ETB room`, "game", "−");
  saveState();
  renderAll();
  showToast(`${room.stake} ETB room removed from the player lobby.`);
}

function randomCall(room) {
  const used = new Set(room.called);
  const letters = ["B", "I", "N", "G", "O"];
  const ranges = [[1, 15], [16, 30], [31, 45], [46, 60], [61, 75]];
  const available = [];
  ranges.forEach(([low, high], index) => {
    for (let value = low; value <= high; value++) {
      const label = `${letters[index]}-${value}`;
      if (!used.has(label)) available.push(label);
    }
  });
  const call = available[Math.floor(Math.random() * available.length)] || "—";
  if (call !== "—") {
    room.called.push(call);
    room.lastCall = call;
  }
  return call;
}

function callNext() {
  const room = currentRoom();
  if (!room || room.status !== "live") {
    showToast("Resume a live round before calling a number.", "error");
    return;
  }
  const call = randomCall(room);
  saveState();
  renderLive();
  renderDashboard();
  addActivity(`Called ${call} in the ${room.stake} ETB room`, "game", "◉");
  showToast(`${call} called in the ${room.stake} ETB room.`);
}

function startLiveTimer() {
  stopLiveTimer();
  if (!settings.autoCall) return;
  const interval = Number($("call-interval")?.value || 8) * 1000;
  liveTimer = setInterval(() => {
    const room = currentRoom();
    if (room && room.status === "live" && document.querySelector("#admin-live.is-active")) {
      randomCall(room);
      saveState();
      renderLive();
      renderDashboard();
    }
  }, interval);
}

function stopLiveTimer() {
  if (liveTimer !== null) {
    clearInterval(liveTimer);
    liveTimer = null;
  }
}

function startNewRound(room = currentRoom()) {
  if (!room) return;
  const roundNumber = Number(String(room.roundId).replace(/\D/g, "")) || 24090;
  room.roundId = `#LB-${roundNumber + 1}`;
  room.lifecycleVersion = Number(room.lifecycleVersion || 0) + 1;
  room.called = [];
  room.lastCall = "—";
  room.status = "live";
  room.prizePool = (Number(room.players) || 0) * (Number(room.stake) || 0);
  addActivity(`Started ${room.roundId} in the ${room.stake} ETB room`, "game", "◉");
  if (typeof LuckyBingoAPI !== "undefined" && LuckyBingoAPI.updateAdminRoom) {
    LuckyBingoAPI.updateAdminRoom(room.id, "force_countdown", { countdown_secs: 60 }).catch(() => {});
  }
  saveState();
  renderAll();
  showSection("live");
  showToast(`${room.stake} ETB room is live with a fresh round.`);
}

function toggleRound() {
  const room = currentRoom();
  if (!room) return;
  if (room.status === "waiting") {
    startNewRound(room);
    return;
  }
  const nextPaused = room.status === "live";
  room.status = nextPaused ? "paused" : "live";
  addActivity(`${room.status === "paused" ? "Paused" : "Resumed"} ${room.stake} ETB room ${room.roundId}`, "game", room.status === "paused" ? "Ⅱ" : "▶");
  if (typeof LuckyBingoAPI !== "undefined" && LuckyBingoAPI.updateAdminRoom) {
    LuckyBingoAPI.updateAdminRoom(room.id, nextPaused ? "pause" : "resume").catch(() => {});
  }
  saveState();
  renderAll();
  showToast(`${room.stake} ETB room ${room.status === "live" ? "resumed" : "paused"}.`);
}

function endRound() {
  const room = currentRoom();
  if (!room) return;
  room.lifecycleVersion = Number(room.lifecycleVersion || 0) + 1;
  room.status = "waiting";
  addActivity(`Ended ${room.roundId} in the ${room.stake} ETB room`, "game", "■");
  if (typeof LuckyBingoAPI !== "undefined" && LuckyBingoAPI.updateAdminRoom) {
    LuckyBingoAPI.updateAdminRoom(room.id, "reset").catch(() => {});
  }
  saveState();
  renderAll();
  showToast(`${room.stake} ETB round ended. Payout review is ready.`);
}

function renderTransactions() {
  const table = $("transactions-table");
  if (!table) return;
  const filtered = state.transactions.filter((transaction) => {
    const matchesType = transactionFilter === "all" || transactionFilter === "processed" ? transactionFilter !== "processed" || transaction.status !== "pending" : transaction.type === transactionFilter;
    const matchesStatus = transactionStatusFilter === "all" || transaction.status === transactionStatusFilter;
    const haystack = `${transaction.id} ${transaction.player} ${transaction.playerId} ${transaction.method} ${transaction.amount}`.toLowerCase();
    return matchesType && matchesStatus && (!transactionQuery || haystack.includes(transactionQuery));
  });
  document.querySelectorAll("[data-transaction-filter]").forEach((button) => button.classList.toggle("is-active", button.dataset.transactionFilter === transactionFilter));
  const pendingCount = state.transactions.filter((item) => item.status === "pending").length;
  $("filter-all-count").textContent = String(pendingCount);
  $("filter-deposit-count").textContent = String(state.transactions.filter((item) => item.type === "deposit" && item.status === "pending").length);
  $("filter-withdraw-count").textContent = String(state.transactions.filter((item) => item.type === "withdraw" && item.status === "pending").length);
  const navBadge = $("nav-transaction-badge");
  if (navBadge) {
    navBadge.textContent = String(pendingCount);
    navBadge.style.display = pendingCount > 0 ? "" : "none";
  }
  $("transaction-result-count").textContent = `Showing ${filtered.length} request${filtered.length === 1 ? "" : "s"}`;
  table.innerHTML = filtered.length ? filtered.map(transactionRow).join("") : `<tr><td colspan="7"><p class="admin-empty-note">No transactions match these filters.</p></td></tr>`;
  renderFinanceSummary();
}

function transactionRow(transaction) {
  const isPending = transaction.status === "pending";
  const statusLabel = transaction.status.charAt(0).toUpperCase() + transaction.status.slice(1);
  const action = isPending ? `<button type="button" class="admin-table-action is-approve" data-transaction-action="approve" data-id="${escapeHTML(transaction.id)}">✓ Approve</button><button type="button" class="admin-table-action is-reject" data-transaction-action="reject" data-id="${escapeHTML(transaction.id)}">× Reject</button>` : `<span class="admin-small-muted">${escapeHTML(transaction.processedAt || "Processed")}</span>`;
  return `<tr><td><div class="admin-player-cell"><span class="admin-player-avatar avatar-${escapeHTML(playerForTransaction(transaction).avatar)}">${initials(transaction.player)}</span><span><strong>${escapeHTML(transaction.player)}</strong><small>${escapeHTML(transaction.id)}</small></span></div></td><td>${transaction.type === "deposit" ? "Deposit" : "Withdrawal"}</td><td>${escapeHTML(transaction.method)}</td><td><strong class="admin-table-amount is-${transaction.type}">${transaction.type === "withdraw" ? "−" : "+"}${money(transaction.amount)}</strong></td><td>${escapeHTML(transaction.requested)}</td><td><span class="admin-status-pill is-${escapeHTML(transaction.status)}">${escapeHTML(statusLabel)}</span></td><td><div class="admin-table-actions">${action}</div></td></tr>`;
}

function playerForTransaction(transaction) {
  return state.players.find((player) => player.id === transaction.playerId) || { avatar: "blue" };
}

function renderFinanceSummary() {
  const pending = pendingTransactions();
  const deposits = pending.filter((transaction) => transaction.type === "deposit");
  const withdrawals = pending.filter((transaction) => transaction.type === "withdraw");
  $("finance-deposits").innerHTML = `${fmt(deposits.reduce((sum, transaction) => sum + transaction.amount, 0))} <small>ETB</small>`;
  $("finance-withdrawals").innerHTML = `${fmt(withdrawals.reduce((sum, transaction) => sum + transaction.amount, 0))} <small>ETB</small>`;
  $("finance-processed").innerHTML = `${fmt(state.metrics.processedToday)} <small>ETB</small>`;
  $("finance-deposit-count").textContent = `${deposits.length} request${deposits.length === 1 ? "" : "s"}`;
  $("finance-withdrawal-count").textContent = `${withdrawals.length} request${withdrawals.length === 1 ? "" : "s"}`;
}

function updateTransaction(id, nextStatus) {
  const transaction = state.transactions.find((item) => item.id === id);
  if (!transaction || transaction.status !== "pending") return;
  transaction.status = nextStatus;
  transaction.processedAt = "just now";
  const amount = Number(transaction.amount) || 0;

  // Find corresponding player record
  let player = state.players.find((p) =>
    (transaction.playerId && String(p.id) === String(transaction.playerId)) ||
    (transaction.phone && String(p.phone) === String(transaction.phone)) ||
    (transaction.player && p.name && p.name.toLowerCase() === transaction.player.toLowerCase())
  );

  const curLocalBal = Number(localStorage.getItem("lucky-bingo-balance") || 0);

  if (nextStatus === "approved") {
    state.metrics.processedToday = (Number(state.metrics.processedToday) || 0) + amount;

    if (transaction.type === "deposit") {
      // 1. Credit player balance in admin state
      if (player) {
        player.balance = (Number(player.balance) || 0) + amount;
        savePlayerBalance(player.id, player.balance);
      }
      // 2. Credit active player game wallet in localStorage
      const nextBal = curLocalBal + amount;
      localStorage.setItem("lucky-bingo-balance", String(nextBal));
    } else if (transaction.type === "withdraw") {
      // 1. Debit player balance in admin state
      if (player) {
        player.balance = Math.max(0, (Number(player.balance) || 0) - amount);
        savePlayerBalance(player.id, player.balance);
      }
      // 2. If not already held by player game UI upon submission, debit game wallet
      if (!transaction.heldFromBalance) {
        const nextBal = Math.max(0, curLocalBal - amount);
        localStorage.setItem("lucky-bingo-balance", String(nextBal));
      }
    }
  } else if (nextStatus === "rejected") {
    // If a withdrawal was held from player balance upon request, refund it upon rejection!
    if (transaction.type === "withdraw" && transaction.heldFromBalance) {
      if (player) {
        player.balance = (Number(player.balance) || 0) + amount;
        savePlayerBalance(player.id, player.balance);
      }
      const nextBal = curLocalBal + amount;
      localStorage.setItem("lucky-bingo-balance", String(nextBal));
    }
  }

  addActivity(
    `${nextStatus === "approved" ? "Approved" : "Rejected"} ${transaction.type} request ${transaction.id} for ${transaction.player} (${fmt(amount)} ETB)`,
    "finance",
    nextStatus === "approved" ? "✓" : "×"
  );
  if (typeof LuckyBingoAPI !== "undefined" && LuckyBingoAPI.updateAdminTransaction) {
    const apiAction = nextStatus === "approved" ? "approve" : "reject";
    LuckyBingoAPI.updateAdminTransaction(transaction.id, apiAction).then((res) => {
      if (res && res.error) {
        console.warn("[API] Transaction sync notice:", res.error);
      }
    }).catch(() => {});
  }
  saveState();
  renderAll();
  showToast(`${transaction.type === "deposit" ? "Deposit" : "Withdrawal"} of ${fmt(amount)} ETB ${nextStatus}.`);
}

function renderPlayers() {
  const table = $("players-table");
  if (!table) return;
  const filtered = state.players.filter((player) => {
    const matchesStatus = playerStatusFilter === "all" || player.status === playerStatusFilter;
    const haystack = `${player.id} ${player.name} ${player.email} ${player.phone}`.toLowerCase();
    return matchesStatus && (!playerQuery || haystack.includes(playerQuery));
  });
  $("player-total-count").textContent = fmt(state.metrics.totalPlayers);
  $("player-verified-count").textContent = fmt(state.metrics.verifiedPlayers);
  $("player-new-count").textContent = fmt(state.metrics.newPlayers);
  $("player-blocked-count").textContent = fmt(state.metrics.blockedPlayers);
  $("player-result-count").textContent = `Showing ${filtered.length} player${filtered.length === 1 ? "" : "s"}`;
  table.innerHTML = filtered.length ? filtered.map(playerRow).join("") : `<tr><td colspan="7"><p class="admin-empty-note">No players match this search.</p></td></tr>`;
}

function playerRow(player) {
  const isBlocked = player.status === "blocked";
  const statusLabel = player.status.charAt(0).toUpperCase() + player.status.slice(1);
  return `<tr><td><div class="admin-player-cell"><span class="admin-player-avatar avatar-${escapeHTML(player.avatar)}">${initials(player.name)}</span><span><strong>${escapeHTML(player.name)}</strong><small>${escapeHTML(player.id)}</small></span></div></td><td><div class="admin-contact-cell"><span>${escapeHTML(player.email)}</span><small>${escapeHTML(player.phone)}</small></div></td><td><strong class="admin-table-amount">${money(player.balance)}</strong></td><td>${fmt(player.games)}</td><td>${escapeHTML(player.lastActive)}</td><td><span class="admin-status-pill is-${escapeHTML(player.status)}">${escapeHTML(statusLabel)}</span></td><td><div class="admin-action-menu"><button type="button" class="admin-action-menu-button" data-player-menu="${escapeHTML(player.id)}" aria-label="Actions for ${escapeHTML(player.name)}">•••</button><div class="admin-action-menu-list"><button type="button" data-player-action="edit" data-id="${escapeHTML(player.id)}">Edit player</button><button type="button" data-player-action="password" data-id="${escapeHTML(player.id)}">Change password</button><button type="button" class="${isBlocked ? "" : "is-danger"}" data-player-action="${isBlocked ? "unblock" : "block"}" data-id="${escapeHTML(player.id)}">${isBlocked ? "Unblock account" : "Block account"}</button></div></div></td></tr>`;
}

function renderAdminProfile() {
  const admin = window.LUCKY_BINGO_ADMIN;
  if (!admin) return;
  const nameEl = $("admin-user-name");
  const roleEl = $("admin-user-role");
  const avatarEl = $("admin-user-avatar");
  if (nameEl && admin.name) nameEl.textContent = admin.name;
  if (roleEl) {
    const idDisp = admin.username ? (admin.username.startsWith("@") || /^\+?\d+$/.test(admin.username) ? admin.username : "@" + admin.username) : (admin.phone || "0999909474");
    roleEl.textContent = `Super administrator (${idDisp})`;
  }
  if (avatarEl) {
    if (/^\+?\d+$/.test(admin.name)) {
      avatarEl.textContent = "09";
    } else {
      avatarEl.textContent = initials(admin.name);
    }
  }
}

function renderAll() {
  syncRoomsWithRealParticipants();
  renderAdminProfile();
  renderDashboard();
  renderLive();
  renderTransactions();
  renderPlayers();
}

function openModal(id) {
  const modal = $(id);
  if (modal) modal.hidden = false;
}

function closeModal(id) {
  const modal = $(id);
  if (modal) modal.hidden = true;
}

function openPlayerForm(player = null) {
  $("player-modal-title").textContent = player ? "Edit player" : "Add player";
  $("player-form-id").value = player?.id || "";
  $("player-form-name").value = player?.name || "";
  $("player-form-username").value = player?.id || "Generated after save";
  $("player-form-email").value = player?.email || "";
  $("player-form-phone").value = player?.phone || "";
  $("player-form-balance").value = player?.balance ?? 0;
  $("player-form-status").value = player?.status || "active";
  $("player-form-note").value = player?.note || "";
  openModal("player-modal");
  setTimeout(() => $("player-form-name").focus(), 40);
}

function openPasswordForm(player) {
  $("password-form-id").value = player.id;
  $("password-player-name").textContent = player.name;
  $("password-form-value").value = "";
  $("password-notify").checked = true;
  openModal("password-modal");
  setTimeout(() => $("password-form-value").focus(), 40);
}

function savePlayerFromForm(event) {
  event.preventDefault();
  const id = $("player-form-id").value;
  const existing = state.players.find((player) => player.id === id);
  const nextStatus = $("player-form-status").value;
  if (existing) {
    const previousStatus = existing.status;
    Object.assign(existing, {
      name: $("player-form-name").value.trim(),
      email: $("player-form-email").value.trim(),
      phone: $("player-form-phone").value.trim(),
      balance: Number($("player-form-balance").value) || 0,
      status: nextStatus,
      note: $("player-form-note").value.trim(),
    });
    if (previousStatus !== "blocked" && nextStatus === "blocked") state.metrics.blockedPlayers += 1;
    if (previousStatus === "blocked" && nextStatus !== "blocked") state.metrics.blockedPlayers = Math.max(0, state.metrics.blockedPlayers - 1);
    addActivity(`Updated the profile for ${existing.name}`, "security", "✎");
    if (existing.userId && typeof LuckyBingoAPI !== "undefined" && LuckyBingoAPI.updateAdminUser) {
      LuckyBingoAPI.updateAdminUser(existing.userId, {
        balance: existing.balance,
        status: existing.status,
      }).catch(() => {});
    }
    showToast("Player profile updated.");
  } else {
    const nextId = makePlayerId();
    const newPlayer = {
      id: nextId,
      name: $("player-form-name").value.trim(),
      email: $("player-form-email").value.trim(),
      phone: $("player-form-phone").value.trim(),
      balance: Number($("player-form-balance").value) || 0,
      games: 0,
      lastActive: "Never",
      status: nextStatus,
      avatar: ["blue", "purple", "orange", "green", "pink"][state.players.length % 5],
      note: $("player-form-note").value.trim(),
    };
    state.players.unshift(newPlayer);
    state.metrics.totalPlayers += 1;
    state.metrics.newPlayers += 1;
    if (nextStatus === "blocked") state.metrics.blockedPlayers += 1;
    addActivity(`Added new player ${newPlayer.name}`, "security", "+");
    showToast(`${newPlayer.name} was added to the player directory.`);
  }
  closeModal("player-modal");
  renderAll();
}

function makePlayerId() {
  const ids = state.players.map((player) => Number(player.id.replace(/\D/g, ""))).filter(Number.isFinite);
  return `LB-${String(Math.max(10000, ...ids, 0) + 1).padStart(5, "0")}`;
}

function togglePlayerStatus(id) {
  const player = state.players.find((item) => item.id === id);
  if (!player) return;
  const wasBlocked = player.status === "blocked";
  player.status = wasBlocked ? "active" : "blocked";
  state.metrics.blockedPlayers += wasBlocked ? -1 : 1;
  state.metrics.blockedPlayers = Math.max(0, state.metrics.blockedPlayers);
  addActivity(`${wasBlocked ? "Unblocked" : "Blocked"} player account ${player.id}`, "security", wasBlocked ? "✓" : "!");
  if (player.userId && typeof LuckyBingoAPI !== "undefined" && LuckyBingoAPI.updateAdminUser) {
    LuckyBingoAPI.updateAdminUser(player.userId, { status: player.status }).catch(() => {});
  }
  renderAll();
  showToast(`${player.name} is now ${player.status}.`);
}

function savePassword(event) {
  event.preventDefault();
  const player = state.players.find((item) => item.id === $("password-form-id").value);
  if (!player) return;
  player.passwordUpdatedAt = new Date().toISOString();
  addActivity(`Changed the password for ${player.name}`, "security", "⌁");
  saveState();
  closeModal("password-modal");
  showToast(`Password updated for ${player.name}.`);
}

function downloadCSV(filename, rows) {
  const csv = rows.map((row) => row.map((cell) => `"${String(cell ?? "").replace(/\"/g, "\"\"")}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast(`${filename} downloaded.`);
}

function exportTransactions() {
  downloadCSV("lucky-bingo-transactions.csv", [
    ["Transaction ID", "Player ID", "Player", "Type", "Method", "Amount ETB", "Requested", "Status"],
    ...state.transactions.map((transaction) => [transaction.id, transaction.playerId, transaction.player, transaction.type, transaction.method, transaction.amount, transaction.requested, transaction.status]),
  ]);
}

function exportPlayers() {
  downloadCSV("lucky-bingo-players.csv", [
    ["Player ID", "Name", "Email", "Phone", "Balance ETB", "Games", "Last active", "Status"],
    ...state.players.map((player) => [player.id, player.name, player.email, player.phone, player.balance, player.games, player.lastActive, player.status]),
  ]);
}

function bindSettings() {
  const values = {
    "setting-commission": "commission",
    "setting-threshold": "threshold",
    "setting-countdown": "countdown",
    "setting-winning-pattern": "winningPattern",
    "setting-starting-bonus": "startingBonus",
    "setting-starting-bonus-enabled": "startingBonusEnabled",
    "setting-autocall": "autoCall",
    "setting-maintenance": "maintenance",
    "setting-transactions": "transactionAlerts",
    "setting-large-withdrawal": "largeWithdrawal",
    "setting-timeout": "timeout",
    "setting-deposit-telebirr-phone": "depositTelebirrPhone",
    "setting-deposit-telebirr-name": "depositTelebirrName",
    "setting-deposit-cbebirr-phone": "depositCbeBirrPhone",
    "setting-deposit-cbebirr-name": "depositCbeBirrName",
    "setting-deposit-mpesa-phone": "depositMpesaPhone",
    "setting-deposit-mpesa-name": "depositMpesaName",
  };
  Object.entries(values).forEach(([id, key]) => {
    const input = $(id);
    if (!input) return;
    if (input.type === "checkbox") input.checked = Boolean(settings[key]);
    else input.value = settings[key] || "";

    const onUpdate = (isFinal = true) => {
      settings[key] = input.type === "checkbox" ? input.checked : input.value;
      if (input.type === "number") settings[key] = Number(input.value);
      if (key === "winningPattern") settings[key] = WINNING_PATTERN_OPTIONS.includes(settings[key]) ? settings[key] : DEFAULT_SETTINGS.winningPattern;
      if (key === "countdown") settings[key] = Math.min(600, Math.max(10, Math.round(settings[key] || 60)));
      if (key === "startingBonus") settings[key] = Math.min(100000, Math.max(0, Math.round(settings[key] || 0)));
      saveSettings();
      $("settings-saved").textContent = "Saved just now";
      if (key === "autoCall") {
        if (settings.autoCall && document.querySelector("#admin-live.is-active")) startLiveTimer();
        else stopLiveTimer();
      }
      if (typeof LuckyBingoAPI !== "undefined" && LuckyBingoAPI.updateAdminSettings) {
        LuckyBingoAPI.updateAdminSettings(settings).then((res) => {
          if (res && res.settings) {
            console.log("[Settings] Server settings updated:", res.settings);
          }
        }).catch(() => {});
      }
      if (isFinal) showToast("Settings saved to server.");
    };

    input.addEventListener("change", () => onUpdate(true));
    if (input.type === "text") {
      input.addEventListener("input", () => onUpdate(false));
    }
  });
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    const nav = event.target.closest("[data-section]");
    if (nav) {
      event.preventDefault();
      showSection(nav.dataset.section);
      return;
    }

    const liveRoom = event.target.closest("[data-live-room]");
    if (liveRoom) {
      selectedLiveRoomId = liveRoom.dataset.liveRoom;
      renderLive();
      startLiveTimer();
      return;
    }

    const liveAction = event.target.closest("[data-live-action]");
    if (liveAction) {
      const action = liveAction.dataset.liveAction;
      if (action === "next-call") callNext();
      if (action === "toggle-round") toggleRound();
      if (action === "end-round") endRound();
      if (action === "new-round") startNewRound();
      if (action === "refresh") {
        renderAll();
        showToast("Live room data refreshed.");
      }
      if (action === "clear-history") {
        const room = currentRoom();
        if (room) {
          room.called = [];
          room.lastCall = "—";
          saveState();
          renderAll();
          showToast("Call history cleared.");
        }
      }
      return;
    }

    const roomToggle = event.target.closest("[data-room-toggle]");
    if (roomToggle) {
      const room = state.rooms.find((item) => item.id === roomToggle.dataset.roomToggle);
      if (room) {
        room.enabled = !room.enabled;
        if (!room.enabled && room.status === "live") room.status = "paused";
        addActivity(`${room.enabled ? "Enabled" : "Disabled"} the ${room.stake} ETB room`, "game", room.enabled ? "✓" : "Ⅱ");
        saveState();
        renderAll();
        showToast(`${room.stake} ETB room ${room.enabled ? "enabled" : "disabled"}.`);
      }
      return;
    }

    const roomRemove = event.target.closest("[data-room-remove]");
    if (roomRemove) {
      removeRoom(roomRemove.dataset.roomRemove);
      return;
    }

    const transactionFilterButton = event.target.closest("[data-transaction-filter]");
    if (transactionFilterButton) {
      transactionFilter = transactionFilterButton.dataset.transactionFilter;
      renderTransactions();
      return;
    }

    const transactionAction = event.target.closest("[data-transaction-action]");
    if (transactionAction) {
      updateTransaction(transactionAction.dataset.id, transactionAction.dataset.transactionAction === "approve" ? "approved" : "rejected");
      return;
    }

    const playerMenu = event.target.closest("[data-player-menu]");
    if (playerMenu) {
      document.querySelectorAll(".admin-action-menu.is-open").forEach((menu) => menu.classList.remove("is-open"));
      playerMenu.closest(".admin-action-menu")?.classList.toggle("is-open");
      event.stopPropagation();
      return;
    }

    const playerAction = event.target.closest("[data-player-action]");
    if (playerAction) {
      const player = state.players.find((item) => item.id === playerAction.dataset.id);
      if (playerAction.dataset.playerAction === "add") openPlayerForm();
      else if (playerAction.dataset.playerAction === "edit" && player) openPlayerForm(player);
      else if (playerAction.dataset.playerAction === "password" && player) openPasswordForm(player);
      else if ((playerAction.dataset.playerAction === "block" || playerAction.dataset.playerAction === "unblock") && player) togglePlayerStatus(player.id);
      document.querySelectorAll(".admin-action-menu.is-open").forEach((menu) => menu.classList.remove("is-open"));
      return;
    }

    const closeButton = event.target.closest("[data-close-modal]");
    if (closeButton) {
      closeModal(closeButton.dataset.closeModal);
      return;
    }

    if (event.target.classList.contains("admin-modal-backdrop")) {
      event.target.hidden = true;
      return;
    }

    if (!event.target.closest(".admin-action-menu")) document.querySelectorAll(".admin-action-menu.is-open").forEach((menu) => menu.classList.remove("is-open"));
  });

  $("admin-menu-button").addEventListener("click", () => $("admin-sidebar").classList.toggle("is-open"));
  $("open-help").addEventListener("click", () => openModal("help-modal"));
  $("notification-button").addEventListener("click", () => {
    showSection("transactions");
    showToast(`${pendingTransactions().length} transaction request${pendingTransactions().length === 1 ? "" : "s"} need review.`);
  });
  const loginForm = $("admin-login-form");
  if (loginForm) {
    loginForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const uInput = $("admin-login-username")?.value || "";
      const pInput = $("admin-login-password")?.value || "";
      const errorEl = $("admin-login-error");

      const cleanUser = uInput.trim().replace(/^@/, "").toLowerCase();
      const cleanPass = pInput.trim();

      if (ADMIN_AUTH_CONFIG.validUsers.includes(cleanUser) && cleanPass === ADMIN_AUTH_CONFIG.password) {
        if (errorEl) errorEl.hidden = true;
        sessionStorage.setItem("lb_admin_auth", "true");
        sessionStorage.setItem("lb_admin_password", cleanPass);
        localStorage.setItem("lb_admin_auth", "true");
        localStorage.setItem("lb_admin_password", cleanPass);
        const formattedUser = /^\+?\d+$/.test(uInput.trim()) ? uInput.trim() : (uInput.trim().startsWith("@") ? uInput.trim() : "@" + uInput.trim());
        sessionStorage.setItem("lb_admin_user", formattedUser);
        localStorage.setItem("lb_admin_user", formattedUser);
        updateAdminUIAuth(true, formattedUser);
        if (typeof LuckyBingoAPI !== "undefined" && LuckyBingoAPI.adminLogin) {
          LuckyBingoAPI.adminLogin(cleanUser, cleanPass).then((res) => {
            if (res && res.token) {
              sessionStorage.setItem("lb_admin_token", res.token);
              localStorage.setItem("lb_admin_token", res.token);
              syncAdminWithServer();
            }
          }).catch(() => {});
        }
        syncAdminWithServer();
        showToast(`Welcome ${formattedUser}! Admin console unlocked.`);
      } else {
        if (errorEl) {
          errorEl.textContent = "Invalid username or password. Please try again.";
          errorEl.hidden = false;
        }
        const passInp = $("admin-login-password");
        if (passInp) {
          passInp.value = "";
          passInp.focus();
        }
      }
    });
  }

  const passToggle = $("admin-password-toggle");
  if (passToggle) {
    passToggle.addEventListener("click", () => {
      const passInput = $("admin-login-password");
      if (!passInput) return;
      if (passInput.type === "password") {
        passInput.type = "text";
        passToggle.textContent = "🙈";
      } else {
        passInput.type = "password";
        passToggle.textContent = "👁";
      }
    });
  }

  $("admin-signout").addEventListener("click", () => {
    sessionStorage.removeItem("lb_admin_auth");
    sessionStorage.removeItem("lb_admin_user");
    updateAdminUIAuth(false);
    showToast("Signed out of the admin console.");
  });
  $("clear-activity").addEventListener("click", () => {
    state.activities = [];
    saveState();
    renderActivity();
    showToast("Activity list cleared.");
  });
  $("refresh-transactions").addEventListener("click", () => {
    showToast("Fetching latest requests from server...");
    if (typeof LuckyBingoAPI !== "undefined" && LuckyBingoAPI.getAdminOverview) {
      LuckyBingoAPI.getAdminOverview().then((data) => {
        if (data && Array.isArray(data.transactions)) {
          state.transactions = data.transactions.map((tx) => ({
            id: tx.id,
            playerId: `LB-${String(tx.user_id).slice(-5)}`,
            userId: tx.user_id,
            player: tx.first_name || (tx.username ? `@${tx.username}` : (tx.phone_number || "Player")),
            phone: tx.phone_number || "",
            type: tx.type,
            method: tx.method || "Telebirr",
            amount: Number(tx.amount) || 0,
            requested: tx.created_at || "Recent",
            status: (tx.status === "completed" || tx.status === "approved") ? "approved" : tx.status,
          }));
          renderTransactions();
          renderFinanceSummary();
          showToast(`Synced ${state.transactions.length} transactions from server.`);
        } else {
          showToast("Server sync completed.");
        }
      }).catch(() => {
        showToast("Could not reach server. Retrying in background...", "warning");
      });
    } else {
      renderTransactions();
      showToast("Transaction queue refreshed.");
    }
  });
  $("export-transactions").addEventListener("click", exportTransactions);
  $("export-players").addEventListener("click", exportPlayers);
  $("export-report").addEventListener("click", () => downloadCSV("lucky-bingo-report.csv", [["Metric", "Value"], ["Total players", state.metrics.totalPlayers], ["Processed today", state.metrics.processedToday], ["Pending requests", pendingTransactions().length], ["Live rooms", state.rooms.filter((room) => room.status === "live").length]]));
  $("player-filter-button").addEventListener("click", () => showToast("Use the status menu or search field to narrow players."));
  $("player-form").addEventListener("submit", savePlayerFromForm);
  $("password-form").addEventListener("submit", savePassword);
  $("transaction-search").addEventListener("input", (event) => {
    transactionQuery = event.target.value.trim().toLowerCase();
    renderTransactions();
  });
  $("transaction-status-filter").addEventListener("change", (event) => {
    transactionStatusFilter = event.target.value;
    renderTransactions();
  });
  $("player-search").addEventListener("input", (event) => {
    playerQuery = event.target.value.trim().toLowerCase();
    renderPlayers();
  });
  $("player-status-filter").addEventListener("change", (event) => {
    playerStatusFilter = event.target.value;
    renderPlayers();
  });
  $("call-interval").addEventListener("change", startLiveTimer);
  $("room-add-form").addEventListener("submit", addRoomFromForm);
  window.addEventListener("hashchange", () => showSection(window.location.hash.slice(1), false));
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      showSection("players");
      $("player-search").focus();
    }
    if (event.key === "Escape") {
      document.querySelectorAll(".admin-modal-backdrop:not([hidden])").forEach((modal) => { modal.hidden = true; });
      document.querySelectorAll(".admin-action-menu.is-open").forEach((menu) => menu.classList.remove("is-open"));
    }
  });
}

function syncAdminWithServer() {
  if (typeof LuckyBingoAPI === "undefined" || !checkAdminAuth()) return;

  // Auto server-login when auth flag is set but server token is missing (e.g. different device/fresh session)
  const hasToken = sessionStorage.getItem("lb_admin_token") || localStorage.getItem("lb_admin_token");
  if (!hasToken && LuckyBingoAPI.adminLogin) {
    const savedPass = sessionStorage.getItem("lb_admin_password") || localStorage.getItem("lb_admin_password") || ADMIN_AUTH_CONFIG.password;
    const savedUser = (sessionStorage.getItem("lb_admin_user") || localStorage.getItem("lb_admin_user") || "su121316").replace(/^@/, "").toLowerCase();
    LuckyBingoAPI.adminLogin(savedUser, savedPass).then((res) => {
      if (res && res.token) {
        sessionStorage.setItem("lb_admin_token", res.token);
        localStorage.setItem("lb_admin_token", res.token);
      }
      // Start polling after token is obtained (or even if login fails — will retry next cycle)
      _startAdminDataPoll();
    }).catch(() => { _startAdminDataPoll(); });
    return;
  }

  _startAdminDataPoll();
}

function _startAdminDataPoll() {
  LuckyBingoAPI.startAdminPoll((data) => {
    const statusEl = $("admin-server-status");
    if (!data || data.error) {
      if (statusEl) {
        statusEl.textContent = "🟡 Reconnecting...";
        statusEl.style.color = "#d97706";
      }
      if (data && data.error && String(data.error).toLowerCase().includes("unauthorized")) {
        sessionStorage.removeItem("lb_admin_token");
        localStorage.removeItem("lb_admin_token");
      }
      return;
    }

    if (statusEl) {
      const txCount = Array.isArray(data.transactions) ? data.transactions.length : state.transactions.length;
      statusEl.textContent = `🟢 Live Server (${txCount} txs)`;
      statusEl.style.color = "#16a34a";
    }

    // 1. Sync rooms from authoritative server
    if (Array.isArray(data.rooms) && data.rooms.length > 0) {
      data.rooms.forEach((sRoom) => {
        const localRoom = state.rooms.find((r) => String(r.id) === String(sRoom.room_id || sRoom.id));
        if (localRoom) {
          localRoom.players = sRoom.player_count || (sRoom.players ? sRoom.players.length : 0);
          localRoom.status = sRoom.status === "open" ? "waiting" : sRoom.status;
          localRoom.enabled = sRoom.enabled !== false;
          localRoom.roundId = `#LB-${sRoom.round_id || "0"}`;
          localRoom.prizePool = localRoom.players * localRoom.stake;
          localRoom.called = Array.isArray(sRoom.calls) ? sRoom.calls : [];
          localRoom.lastCall = localRoom.called.length > 0 ? String(localRoom.called[localRoom.called.length - 1]) : "—";
          localRoom.realPlayersList = sRoom.players || [];
        }
      });
      renderRooms();
      renderLive();
      renderDashboard();
    }

    // 2. Sync transactions from SQLite database
    if (Array.isArray(data.transactions)) {
      state.transactions = data.transactions.map((tx) => ({
        id: tx.id,
        playerId: `LB-${String(tx.user_id).slice(-5)}`,
        userId: tx.user_id,
        player: tx.first_name || (tx.username ? `@${tx.username}` : (tx.phone_number || "Player")),
        phone: tx.phone_number || "",
        type: tx.type,
        method: tx.method || "Telebirr",
        amount: Number(tx.amount) || 0,
        requested: tx.created_at || "Recent",
        status: (tx.status === "completed" || tx.status === "approved") ? "approved" : tx.status,
      }));
      renderTransactions();
      renderFinanceSummary();
    }

    // 3. Sync registered users / players from SQLite database
    if (Array.isArray(data.players) && data.players.length > 0) {
      state.players = data.players.map((u) => ({
        id: `LB-${String(u.id).slice(-5)}`,
        userId: u.id,
        name: [u.first_name, u.last_name].filter(Boolean).join(" ") || (u.username ? `@${u.username}` : "Player"),
        phone: u.phone_number || "—",
        role: u.role || "player",
        balance: Number(u.balance) || 0,
        status: u.status || "active",
        verified: Boolean(u.is_verified),
        joined: u.registered_at || "Recent",
        activeRoom: u.active_room || "Lobby",
      }));
      renderPlayers();
    }

    // 4. Sync metrics
    if (data.metrics) {
      state.metrics = {
        ...state.metrics,
        totalPlayers: data.metrics.totalPlayers ?? state.metrics.totalPlayers,
        verifiedPlayers: data.metrics.verifiedPlayers ?? state.metrics.verifiedPlayers,
        activePlayers: data.metrics.activePlayers ?? state.metrics.activePlayers,
        processedToday: data.metrics.processedToday ?? (Number(data.metrics.totalDeposits || 0) + Number(data.metrics.totalWithdrawals || 0)),
      };
    }

    // 5. Sync settings from authoritative server
    if (data.settings) {
      const s = data.settings;
      if (typeof s.commission === "number" && settings.commission !== s.commission) {
        settings.commission = s.commission;
        const commInp = $("setting-commission");
        if (commInp && document.activeElement !== commInp) commInp.value = settings.commission;
      }
      const winPat = s.winning_pattern || s.winningPattern;
      if (winPat && settings.winningPattern !== winPat) {
        settings.winningPattern = winPat;
        const patInp = $("setting-winning-pattern");
        if (patInp && document.activeElement !== patInp) patInp.value = settings.winningPattern;
      }
      const cd = typeof s.countdown === "number" ? s.countdown : null;
      if (cd !== null && settings.countdown !== cd) {
        settings.countdown = cd;
        const cdInp = $("setting-countdown");
        if (cdInp && document.activeElement !== cdInp) cdInp.value = settings.countdown;
      }
      const sb = s.starting_bonus ?? s.startingBonus;
      if (typeof sb === "number" && settings.startingBonus !== sb) {
        settings.startingBonus = sb;
        const sbInp = $("setting-starting-bonus");
        if (sbInp && document.activeElement !== sbInp) sbInp.value = settings.startingBonus;
      }
      if (s.depositTelebirrPhone) settings.depositTelebirrPhone = s.depositTelebirrPhone;
      if (s.depositTelebirrName) settings.depositTelebirrName = s.depositTelebirrName;
      if (s.depositCbeBirrPhone) settings.depositCbeBirrPhone = s.depositCbeBirrPhone;
      if (s.depositCbeBirrName) settings.depositCbeBirrName = s.depositCbeBirrName;
      if (s.depositMpesaPhone) settings.depositMpesaPhone = s.depositMpesaPhone;
      if (s.depositMpesaName) settings.depositMpesaName = s.depositMpesaName;
    }

    renderDashboard();
    renderLive();
    renderTransactions();
    renderPlayers();
  }, 1500);
}

function initialise() {
  const isAuth = checkAdminAuth();
  const savedUser = sessionStorage.getItem("lb_admin_user") || localStorage.getItem("lb_admin_user") || "@Su121316";
  updateAdminUIAuth(isAuth, savedUser);
  if (isAuth) {
    syncAdminWithServer();
  }

  bindSettings();
  bindEvents();
  renderAll();
  showSection(window.location.hash.slice(1) || "overview", false);
  setInterval(() => {
    const updated = $("last-updated");
    if (updated) updated.textContent = "Updated just now";
  }, 60000);

  // When returning to admin tab from another app, immediately re-sync with server!
  window.addEventListener("focus", () => {
    if (checkAdminAuth()) syncAdminWithServer();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && checkAdminAuth()) syncAdminWithServer();
  });
}

initialise();
