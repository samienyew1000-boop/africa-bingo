// Africa Bingo API Configuration
// Authoritative backend URL for multi-device sync
(function () {
  "use strict";
  const params = new URLSearchParams(window.location.search);
  const apiParam = params.get("api");

  // Permanent 24/7 Cloud Backend URL on EthioDeploy
  const DEFAULT_BACKEND_URL = window.location.origin && window.location.origin.includes("ethiodeploy.com")
    ? window.location.origin
    : "https://africa-bingo.ethiodeploy.com";

  if (apiParam) {
    try {
      localStorage.setItem("lb_api_url", apiParam.replace(/\/+$/, ""));
    } catch (e) {}
    window.LUCKY_BINGO_API_URL = apiParam;
  } else {
    try {
      const stored = localStorage.getItem("lb_api_url");
      if (!stored || stored.includes("trycloudflare.com") || stored.includes("lucky-bingo")) {
        localStorage.setItem("lb_api_url", DEFAULT_BACKEND_URL);
      }
    } catch (e) {}
    window.LUCKY_BINGO_API_URL = localStorage.getItem("lb_api_url") || DEFAULT_BACKEND_URL;
    if (window.LUCKY_BINGO_API_URL.includes("trycloudflare.com") || window.LUCKY_BINGO_API_URL.includes("lucky-bingo")) {
      window.LUCKY_BINGO_API_URL = DEFAULT_BACKEND_URL;
      try {
        localStorage.setItem("lb_api_url", DEFAULT_BACKEND_URL);
      } catch (e) {}
    }
  }
})();
