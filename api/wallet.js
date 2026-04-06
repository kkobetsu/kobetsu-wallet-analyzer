const ABSTRACT_RPC_URL = process.env.ABSTRACT_RPC_URL || "https://api.mainnet.abs.xyz";
const ABSCAN_API_BASE = "https://api.abscan.org/api";
const ABSCAN_API_KEY = process.env.ABSCAN_API_KEY;
const CHAIN_ID = 2741;
const PAGE_SIZE = 200;
const MAX_PAGES = 8;
const FETCH_TIMEOUT_MS = 12000;
const DAY_IN_SECONDS = 24 * 60 * 60;
const DAY_IN_MS = DAY_IN_SECONDS * 1000;
const CACHE_TTL_MS = 90 * 1000;

const cache = globalThis.__walletCache || new Map();
globalThis.__walletCache = cache;

function sendJson(res, statusCode, payload) {
  res.status(statusCode).json(payload);
}

function isValidAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address || "");
}

function formatEther(weiHex) {
  const wei = BigInt(weiHex);
  const base = 10n ** 18n;
  const whole = wei / base;
  const fraction = wei % base;
  const fractionText = fraction.toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return fractionText ? `${whole}.${fractionText}` : whole.toString();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Request timed out.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function rpcCall(method, params) {
  const response = await fetchWithTimeout(ABSTRACT_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${method}-${Date.now()}`,
      method,
      params
    })
  });

  if (!response.ok) throw new Error(`Abstract RPC error: HTTP ${response.status}`);

  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || "Invalid Abstract RPC response.");
  return payload.result;
}

async function fetchAbscanTransactions(address, options = {}) {
  if (!ABSCAN_API_KEY) {
    throw new Error("ABSCAN_API_KEY is missing.");
  }

  const url = new URL(ABSCAN_API_BASE);
  url.searchParams.set("module", "account");
  url.searchParams.set("action", "txlist");
  url.searchParams.set("address", address);
  url.searchParams.set("startblock", "0");
  url.searchParams.set("endblock", "99999999");
  url.searchParams.set("page", String(options.page || 1));
  url.searchParams.set("offset", String(options.offset || PAGE_SIZE));
  url.searchParams.set("sort", options.sort || "desc");
  url.searchParams.set("chainId", String(CHAIN_ID));
  url.searchParams.set("apikey", ABSCAN_API_KEY);

  const response = await fetchWithTimeout(url.toString());
  if (!response.ok) throw new Error(`Abscan error: HTTP ${response.status}`);

  const payload = await response.json();

  if (payload.status === "0") {
    if (payload.message === "No transactions found") return [];

    const reason = typeof payload.result === "string" ? payload.result : payload.message;
    if (/rate limit|max rate limit|too many/i.test(reason || "")) {
      throw new Error("Abscan rate limit reached. Wait a few seconds and try again.");
    }
    throw new Error(reason || "Invalid Abscan response.");
  }

  if (!Array.isArray(payload.result)) {
    throw new Error("Abscan result format is invalid.");
  }

  return payload.result;
}

function buildEmptyChart(days) {
  const points = [];
  const now = new Date();

  for (let index = days - 1; index >= 0; index -= 1) {
    const pointDate = new Date(now.getTime() - index * DAY_IN_MS);
    const isoDate = pointDate
