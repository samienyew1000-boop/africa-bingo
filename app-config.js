// Africa Bingo API Configuration
// Authoritative backend URL for multi-device sync
(function () {
  "use strict";
  const params = new URLSearchParams(window.location.search);
  const apiParam = params.get("api");

  // Dynamically resolve backend origin + path
  const isBingoPath = window.location.pathname.startsWith("/bingo");
  const DEFAULT_BACKEND_URL = isBingoPath
    ? (window.location.origin + "/bingo")
    : (window.location.origin || "");

  if (apiParam) {
    try {
      localStorage.setItem("lb_api_url", apiParam.replace(/\/+$/, ""));
    } catch (e) {}
    window.LUCKY_BINGO_API_URL = apiParam;
  } else {
    try {
      const stored = localStorage.getItem("lb_api_url");
      if (!stored || stored.includes(":3005") || stored.includes("trycloudflare.com") || stored.includes("ethiodeploy") || stored.includes("lucky-bingo")) {
        localStorage.setItem("lb_api_url", DEFAULT_BACKEND_URL);
      }
    } catch (e) {}
    let activeUrl = localStorage.getItem("lb_api_url") || DEFAULT_BACKEND_URL;
    if (activeUrl.includes(":3005") || activeUrl.includes("trycloudflare.com") || activeUrl.includes("ethiodeploy") || activeUrl.includes("lucky-bingo")) {
      activeUrl = DEFAULT_BACKEND_URL;
      try {
        localStorage.setItem("lb_api_url", DEFAULT_BACKEND_URL);
      } catch (e) {}
    }
    window.LUCKY_BINGO_API_URL = activeUrl;
  }
})();
