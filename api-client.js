"use strict";

/**
 * Lucky Bingo API Client
 * Communicates with the bot.py server-side API for synchronized game state.
 * All game state (balance, rooms, game progress) is managed server-side.
 */
const LuckyBingoAPI = (() => {
  // Auto-detect the API base URL
  let _baseUrl = "";

  function getBaseUrl() {
    if (_baseUrl) return _baseUrl;
    try {
      const params = new URLSearchParams(window.location.search);
      const apiParam = params.get("api");
      if (apiParam) {
        _baseUrl = apiParam.replace(/\/+$/, "");
        localStorage.setItem("lb_api_url", _baseUrl);
        return _baseUrl;
      }
    } catch (e) {}

    const configuredUrl = window.LUCKY_BINGO_API_URL || localStorage.getItem("lb_api_url");
    if (configuredUrl) {
      _baseUrl = configuredUrl.replace(/\/+$/, "");
      return _baseUrl;
    }

    const currentHost = window.location.hostname;
    if (currentHost === "localhost" || currentHost === "127.0.0.1") {
      _baseUrl = "";
    } else {
      _baseUrl = "";
    }
    return _baseUrl;
  }

  function getInitData() {
    try {
      return window.Telegram?.WebApp?.initData || "";
    } catch (e) {
      return "";
    }
  }

  function getTelegramUser() {
    try {
      const webAppUser = window.Telegram?.WebApp?.initDataUnsafe?.user;
      if (webAppUser?.id) {
        localStorage.setItem("lb_tg_user", JSON.stringify(webAppUser));
        return webAppUser;
      }

      const params = new URLSearchParams(window.location.search);
      const uid = params.get("u") || params.get("user_id") || params.get("tg_user_id");
      if (uid && /^\d+$/.test(uid)) {
        const u = { id: Number(uid), username: params.get("username") || `Player_${uid.slice(-4)}`, first_name: "Player" };
        localStorage.setItem("lb_tg_user", JSON.stringify(u));
        return u;
      }

      const cached = localStorage.getItem("lb_tg_user");
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (parsed && parsed.id) return parsed;
        } catch (e) {}
      }

      let deviceId = localStorage.getItem("lb_device_player_id");
      if (!deviceId || !/^\d+$/.test(deviceId)) {
        deviceId = String(Math.floor(8000000000 + Math.random() * 1999999999));
        localStorage.setItem("lb_device_player_id", deviceId);
      }
      const deviceUser = {
        id: Number(deviceId),
        username: `Player_${deviceId.slice(-4)}`,
        first_name: "Lucky Player",
      };
      localStorage.setItem("lb_tg_user", JSON.stringify(deviceUser));
      return deviceUser;
    } catch (e) {
      return null;
    }
  }

  async function apiRequest(path, options = {}) {
    const url = getBaseUrl() + path;
    const initData = getInitData();
    const headers = {
      "Content-Type": "application/json",
      "X-Telegram-Init-Data": initData,
      ...options.headers,
    };

    const adminToken = sessionStorage.getItem("lb_admin_token") || localStorage.getItem("lb_admin_token");
    if (adminToken) {
      headers["X-Admin-Token"] = adminToken;
    }
    const adminPwd = sessionStorage.getItem("lb_admin_password") || localStorage.getItem("lb_admin_password") || "Sj$0332#89";
    if (adminPwd) {
      headers["X-Admin-Password"] = adminPwd;
    }

    const user = getTelegramUser();
    if (user?.id) {
      headers["X-Telegram-User-Id"] = String(user.id);
      if (user.username) {
        headers["X-Telegram-User-Name"] = String(user.username);
      }
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      if (!response.ok) {
        let errorMsg = response.status === 404 ? "API_NOT_FOUND" : `HTTP ${response.status}`;
        let parsed = null;
        try {
          const text = await response.text();
          parsed = JSON.parse(text);
          if (parsed && parsed.error) errorMsg = String(parsed.error);
        } catch (e) {}
        return {
          error: errorMsg,
          _status: response.status,
          isNotFound: response.status === 404,
          requires_contact: Boolean(parsed && parsed.requires_contact),
        };
      }

      return await response.json();
    } catch (e) {
      console.warn("[API] Request failed:", path, e);
      _baseUrl = "";

      // Self-healing: if fetch failed, check if Vercel has an updated tunnel URL and retry
      if (!options._retried) {
        try {
          const configRes = await fetch("https://lucky-bingo-iota.vercel.app/app-config.js?_t=" + Date.now(), { cache: "no-store" });
          if (configRes.ok) {
            const configText = await configRes.text();
            const match = configText.match(/DEFAULT_BACKEND_URL\s*=\s*["']([^"']+)["']/);
            if (match && match[1]) {
              const freshUrl = match[1].replace(/\/+$/, "");
              _baseUrl = freshUrl;
              window.LUCKY_BINGO_API_URL = freshUrl;
              try { localStorage.setItem("lb_api_url", freshUrl); } catch (_) {}
              return await apiRequest(path, { ...options, _retried: true });
            }
          }
        } catch (_) {}
      }

      return {
        error: "Network error. Please check your connection.",
        isNetworkError: true,
      };
    }
  }

  // =========================================================================
  // PUBLIC API METHODS
  // =========================================================================

  async function getProfile() {
    return apiRequest("/api/me");
  }

  async function getRooms() {
    return apiRequest("/api/rooms");
  }

  async function getRoomState(roomId) {
    return apiRequest(`/api/room-state?room_id=${encodeURIComponent(roomId)}`);
  }

  async function joinRoom(roomId, cardIds) {
    return apiRequest("/api/join-room", {
      method: "POST",
      body: JSON.stringify({ room_id: String(roomId), card_ids: cardIds }),
    });
  }

  async function leaveRoom(roomId) {
    return apiRequest("/api/leave-room", {
      method: "POST",
      body: JSON.stringify({ room_id: String(roomId) }),
    });
  }

  async function claimBingo(roomId, cardId) {
    return apiRequest("/api/claim-bingo", {
      method: "POST",
      body: JSON.stringify({ room_id: String(roomId), card_id: cardId }),
    });
  }

  async function deposit(amount, method, reference, phone) {
    return apiRequest("/api/deposit", {
      method: "POST",
      body: JSON.stringify({ amount, method, reference, phone }),
    });
  }

  async function withdraw(amount, method, phone) {
    return apiRequest("/api/withdraw", {
      method: "POST",
      body: JSON.stringify({ amount, method, phone }),
    });
  }

  // =========================================================================
  // POLLING HELPERS
  // =========================================================================

  let _roomPollTimer = null;
  let _roomPollCallback = null;
  let _roomPollId = null;

  function startRoomPoll(roomId, callback, intervalMs = 800) {
    stopRoomPoll();
    _roomPollId = roomId;
    _roomPollCallback = callback;

    async function poll() {
      if (_roomPollId !== roomId) return;
      const state = await getRoomState(roomId);
      if (_roomPollId === roomId && _roomPollCallback) {
        _roomPollCallback(state);
      }
      if (_roomPollId === roomId) {
        _roomPollTimer = setTimeout(poll, intervalMs);
      }
    }
    poll();
  }

  function stopRoomPoll() {
    _roomPollId = null;
    _roomPollCallback = null;
    if (_roomPollTimer) {
      clearTimeout(_roomPollTimer);
      _roomPollTimer = null;
    }
  }

  let _lobbyPollTimer = null;
  let _lobbyPollCallback = null;

  function startLobbyPoll(callback, intervalMs = 2000) {
    stopLobbyPoll();
    _lobbyPollCallback = callback;

    async function poll() {
      if (!_lobbyPollCallback) return;
      const data = await getRooms();
      if (_lobbyPollCallback) {
        _lobbyPollCallback(data);
      }
      if (_lobbyPollCallback) {
        _lobbyPollTimer = setTimeout(poll, intervalMs);
      }
    }
    poll();
  }

  function stopLobbyPoll() {
    _lobbyPollCallback = null;
    if (_lobbyPollTimer) {
      clearTimeout(_lobbyPollTimer);
      _lobbyPollTimer = null;
    }
  }

  async function adminLogin(username, password) {
    const res = await apiRequest("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    if (res && res.ok && res.token) {
      sessionStorage.setItem("lb_admin_token", res.token);
      sessionStorage.setItem("lb_admin_auth", "true");
      sessionStorage.setItem("lb_admin_user", res.username || username);
      localStorage.setItem("lb_admin_token", res.token);
      localStorage.setItem("lb_admin_auth", "true");
      localStorage.setItem("lb_admin_user", res.username || username);
      localStorage.setItem("lb_admin_password", password);
    }
    return res;
  }

  async function getAdminOverview() {
    return apiRequest("/api/admin/overview");
  }

  async function updateAdminRoom(roomId, action, extra = {}) {
    return apiRequest("/api/admin/room/update", {
      method: "POST",
      body: JSON.stringify({ room_id: String(roomId), action, ...extra }),
    });
  }

  async function updateAdminTransaction(txId, action) {
    return apiRequest("/api/admin/transaction/update", {
      method: "POST",
      body: JSON.stringify({ id: String(txId), action }),
    });
  }

  async function updateAdminUser(userId, updates = {}) {
    return apiRequest("/api/admin/user/update", {
      method: "POST",
      body: JSON.stringify({ user_id: Number(userId), ...updates }),
    });
  }

  async function getSettings() {
    return apiRequest("/api/settings");
  }

  async function updateAdminSettings(settings = {}) {
    return apiRequest("/api/admin/settings/update", {
      method: "POST",
      body: JSON.stringify(settings),
    });
  }

  let _adminPollTimer = null;
  let _adminPollCallback = null;

  function startAdminPoll(callback, intervalMs = 1500) {
    stopAdminPoll();
    _adminPollCallback = callback;

    async function poll() {
      if (!_adminPollCallback) return;
      let data = await getAdminOverview();
      if (data && (data._status === 401 || (data.error && String(data.error).toLowerCase().includes("unauthorized")))) {
        const adminUser = (sessionStorage.getItem("lb_admin_user") || localStorage.getItem("lb_admin_user") || "su121316").replace(/^@/, "").toLowerCase();
        const adminPass = sessionStorage.getItem("lb_admin_password") || localStorage.getItem("lb_admin_password") || "Sj$0332#89";
        const loginRes = await adminLogin(adminUser, adminPass);
        if (loginRes && loginRes.ok) {
          data = await getAdminOverview();
        }
      }
      if (_adminPollCallback) {
        _adminPollCallback(data);
      }
      if (_adminPollCallback) {
        _adminPollTimer = setTimeout(poll, intervalMs);
      }
    }
    poll();
  }

  function stopAdminPoll() {
    _adminPollCallback = null;
    if (_adminPollTimer) {
      clearTimeout(_adminPollTimer);
      _adminPollTimer = null;
    }
  }

  function setBaseUrl(url) {
    _baseUrl = url.replace(/\/+$/, "");
    try {
      localStorage.setItem("lb_api_url", _baseUrl);
    } catch (e) {}
  }

  return {
    getProfile,
    getRooms,
    getRoomState,
    joinRoom,
    leaveRoom,
    claimBingo,
    deposit,
    withdraw,
    startRoomPoll,
    stopRoomPoll,
    startLobbyPoll,
    stopLobbyPoll,
    setBaseUrl,
    getBaseUrl,
    getTelegramUser,
    getInitData,
    adminLogin,
    getAdminOverview,
    updateAdminRoom,
    updateAdminTransaction,
    updateAdminUser,
    getSettings,
    updateAdminSettings,
    startAdminPoll,
    stopAdminPoll,
  };
})();
