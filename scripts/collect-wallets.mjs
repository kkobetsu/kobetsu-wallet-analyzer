import { mkdir, readFile, writeFile } from "node:fs/promises";

const ABSTRACT_RPC_URL = process.env.ABSTRACT_RPC_URL || "https://api.mainnet.abs.xyz";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const ETHERSCAN_API_BASE = "https://api.etherscan.io/v2/api";
const CHAIN_ID = 2741;

const PAGE_SIZE = 1000;
const MAX_TX_PAGES = 8;
const MAX_TOKEN_PAGES = 4;
const REQUEST_DELAY_MS = 250;
const DAY_IN_SECONDS = 24 * 60 * 60;
const DAY_IN_MS = DAY_IN_SECONDS * 1000;

if (!ETHERSCAN_API_KEY) {
  throw new Error("ETHERSCAN_API_KEY is missing.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function shortenAddress(address) {
  const safe = String(address || "");
  if (safe.length < 14) return safe;
  return `${safe.slice(0, 8)}...${safe.slice(-4)}`;
}

async function readJson(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function rpcCall(method, params) {
  const response = await fetch(ABSTRACT_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${method}-${Date.now()}`,
      method,
      params
    })
  });

  if (!response.ok) {
    throw new Error(`Abstract RPC error: HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (payload.error) {
    throw new Error(payload.error.message || "Invalid Abstract RPC response.");
  }

  return payload.result;
}

async function fetchEtherscanAccount(action, extraParams = {}) {
  const url = new URL(ETHERSCAN_API_BASE);
  url.searchParams.set("chainid", String(CHAIN_ID));
  url.searchParams.set("module", "account");
  url.searchParams.set("action", action);
  url.searchParams.set("apikey", ETHERSCAN_API_KEY);

  for (const [key, value] of Object.entries(extraParams)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Etherscan error: HTTP ${response.status}`);
  }

  const payload = await response.json();

  if (payload.status === "0") {
    if (
      payload.message === "No transactions found" ||
      payload.result === "No transactions found"
    ) {
      return [];
    }

    const reason = typeof payload.result === "string" ? payload.result : payload.message;
    throw new Error(reason || `Invalid Etherscan response for ${action}`);
  }

  if (!Array.isArray(payload.result)) {
    throw new Error(`Invalid Etherscan result format for ${action}`);
  }

  await sleep(REQUEST_DELAY_MS);
  return payload.result;
}

async function getWalletCoreMetrics(address) {
  const [nonceHex, balanceHex] = await Promise.all([
    rpcCall("eth_getTransactionCount", [address, "latest"]),
    rpcCall("eth_getBalance", [address, "latest"])
  ]);

  return {
    allTimeTx: Number.parseInt(nonceHex, 16),
    balanceWei: BigInt(balanceHex).toString(),
    balanceFormatted: formatEther(balanceHex)
  };
}

function buildEmptyChart(days) {
  const points = [];
  const now = new Date();

  for (let index = days - 1; index >= 0; index -= 1) {
    const pointDate = new Date(now.getTime() - index * DAY_IN_MS);
    const isoDate = pointDate.toISOString().slice(0, 10);
    points.push({
      date: isoDate,
      label: isoDate.slice(5),
      fullDate: isoDate,
      count: 0
    });
  }

  return points;
}

function calculateWalletAge(firstTransactionAt, nowMs) {
  if (!firstTransactionAt) {
    return {
      walletAgeDays: null,
      walletAgeText: "No history"
    };
  }

  const diffMs = Math.max(0, nowMs - new Date(firstTransactionAt).getTime());
  const walletAgeDays = diffMs / DAY_IN_MS;

  if (walletAgeDays < 1) {
    return {
      walletAgeDays,
      walletAgeText: `${Math.max(1, Math.floor(diffMs / (60 * 60 * 1000)))} hours`
    };
  }

  if (walletAgeDays < 30) {
    return {
      walletAgeDays,
      walletAgeText: `${Math.floor(walletAgeDays)} days`
    };
  }

  return {
    walletAgeDays,
    walletAgeText: `${(walletAgeDays / 30.4375).toFixed(1)} months`
  };
}

function collectCandidates(value, results = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectCandidates(item, results);
    }
    return results;
  }

  if (!value || typeof value !== "object") {
    return results;
  }

  const hasId = value.id !== undefined || value.userId !== undefined;
  const hasName = value.name !== undefined || value.username !== undefined;
  const hasWallet =
    value.walletAddress !== undefined ||
    value.wallet !== undefined ||
    value.address !== undefined;

  if (hasId && (hasName || hasWallet)) {
    results.push(value);
  }

  for (const nested of Object.values(value)) {
    collectCandidates(nested, results);
  }

  return results;
}

function normalizeCandidate(candidate) {
  return {
    id: candidate?.id ?? candidate?.userId ?? candidate?.user?.id ?? null,
    name: candidate?.name ?? candidate?.username ?? candidate?.user?.name ?? "",
    walletAddress:
      candidate?.walletAddress ??
      candidate?.address ??
      candidate?.wallet ??
      candidate?.user?.walletAddress ??
      ""
  };
}

function pickCandidate(candidates, query, walletAddress) {
  const safeQuery = String(query || "").trim().toLowerCase();
  const safeWallet = String(walletAddress || "").trim().toLowerCase();
  const normalized = candidates.map(normalizeCandidate).filter((item) => item.id != null);

  const exactWallet = normalized.find(
    (item) => String(item.walletAddress).toLowerCase() === safeWallet
  );
  if (exactWallet) return exactWallet;

  const exactQueryWallet = normalized.find(
    (item) => String(item.walletAddress).toLowerCase() === safeQuery
  );
  if (exactQueryWallet) return exactQueryWallet;

  const exactName = normalized.find(
    (item) => String(item.name).toLowerCase() === safeQuery
  );
  if (exactName) return exactName;

  return normalized[0] || null;
}

async function fetchJsonMaybe(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" }
  });

  const text = await response.text();
  let payload;

  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${url}`);
  }

  if (!response.ok) {
    throw new Error(payload.error || payload.message || `Request failed: ${response.status}`);
  }

  return payload;
}

async function fetchProfile(username, walletAddress) {
  const queries = [username, walletAddress].filter(Boolean);

  for (const query of queries) {
    try {
      const suggestUrl = `https://abscope.live/api/suggest?query=${encodeURIComponent(query)}`;
      const suggestPayload = await fetchJsonMaybe(suggestUrl);
      const candidates = collectCandidates(suggestPayload);
      const picked = pickCandidate(candidates, query, walletAddress);

      if (!picked?.id) {
        continue;
      }

      const profileUrl = `https://abscope.live/api/proxy/user/${picked.id}`;
      const profilePayload = await fetchJsonMaybe(profileUrl);
      const user = profilePayload?.user;

      if (!user) {
        continue;
      }

      return {
        id: user.id,
        name: user.name || username || "Unknown",
        description: user.description || "",
        walletAddress: user.walletAddress || walletAddress,
        avatar: user.avatar || null,
        banner: user.banner || null,
        tier: user.tier ?? null,
        tierV2: user.tierV2 ?? null,
        hasCompletedWelcomeTour: Boolean(user.hasCompletedWelcomeTour),
        hasStreamingAccess: Boolean(user.hasStreamingAccess),
        overrideProfilePictureUrl: user.overrideProfilePictureUrl || null,
        lastTierSeen: user.lastTierSeen ?? null,
        badges: Array.isArray(user.badges) ? user.badges : []
      };
    } catch (_) {
    }
  }

  return {
    id: null,
    name: username || "Unknown",
    description: "",
    walletAddress,
    avatar: null,
    banner: null,
    tier: null,
    tierV2: null,
    hasCompletedWelcomeTour: false,
    hasStreamingAccess: false,
    overrideProfilePictureUrl: null,
    lastTierSeen: null,
    badges: []
  };
}

async function fetchTransactionMetrics(address) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoff24h = nowSeconds - DAY_IN_SECONDS;
  const cutoff7d = nowSeconds - 7 * DAY_IN_SECONDS;
  const cutoff30d = nowSeconds - 30 * DAY_IN_SECONDS;
  const cutoff14d = nowSeconds - 14 * DAY_IN_SECONDS;

  const chart = buildEmptyChart(14);
  const chartLookup = new Map(chart.map((item) => [item.date, item]));

  let tx24h = 0;
  let tx7d = 0;
  let tx30d = 0;
  let firstTransactionAt = null;
  let lastTransactionAt = null;

  for (let page = 1; page <= MAX_TX_PAGES; page += 1) {
    const batch = await fetchEtherscanAccount("txlist", {
      address,
      startblock: 0,
      endblock: 99999999,
      page,
      offset: PAGE_SIZE,
      sort: "desc"
    });

    if (batch.length === 0) break;

    if (!lastTransactionAt && batch[0]?.timeStamp) {
      lastTransactionAt = new Date(Number(batch[0].timeStamp) * 1000).toISOString();
    }

    for (const tx of batch) {
      const timestamp = Number(tx.timeStamp);
      if (!Number.isFinite(timestamp)) continue;

      if (timestamp >= cutoff24h) tx24h += 1;
      if (timestamp >= cutoff7d) tx7d += 1;
      if (timestamp >= cutoff30d) tx30d += 1;

      if (timestamp >= cutoff14d) {
        const isoDate = new Date(timestamp * 1000).toISOString().slice(0, 10);
        const point = chartLookup.get(isoDate);
        if (point) point.count += 1;
      }
    }

    if (batch.some((tx) => Number(tx.timeStamp) < cutoff30d) || batch.length < PAGE_SIZE) {
      break;
    }
  }

  const oldestBatch = await fetchEtherscanAccount("txlist", {
    address,
    startblock: 0,
    endblock: 99999999,
    page: 1,
    offset: 1,
    sort: "asc"
  });

  if (oldestBatch[0]?.timeStamp) {
    firstTransactionAt = new Date(Number(oldestBatch[0].timeStamp) * 1000).toISOString();
  }

  return {
    tx24h,
    tx7d,
    tx30d,
    chart,
    firstTransactionAt,
    lastTransactionAt
  };
}

async function fetchTokenActivity(address, appMap) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoff30d = nowSeconds - 30 * DAY_IN_SECONDS;
  const groups = new Map();

  for (let page = 1; page <= MAX_TOKEN_PAGES; page += 1) {
    const batch = await fetchEtherscanAccount("tokentx", {
      address,
      startblock: 0,
      endblock: 99999999,
      page,
      offset: PAGE_SIZE,
      sort: "desc"
    });

    if (batch.length === 0) break;

    for (const tx of batch) {
      const timestamp = Number(tx.timeStamp);
      if (!Number.isFinite(timestamp)) continue;
      if (timestamp < cutoff30d) continue;

      const contract = String(tx.contractAddress || "").toLowerCase();
      if (!contract) continue;

      const existing = groups.get(contract) || {
        name: appMap[contract] || tx.tokenName || shortenAddress(contract),
        address: contract,
        txCount: 0
      };

      existing.txCount += 1;
      groups.set(contract, existing);
    }

    if (batch.some((tx) => Number(tx.timeStamp) < cutoff30d) || batch.length < PAGE_SIZE) {
      break;
    }
  }

  const apps = Array.from(groups.values())
    .sort((a, b) => b.txCount - a.txCount)
    .slice(0, 12);

  return {
    apps,
    mostUsed: apps[0] || null
  };
}

async function collectWallet(item, appMap) {
  const address = item.wallet;
  const username = item.username || "Unknown";

  const [core, profile, txMetrics, tokenActivity] = await Promise.all([
    getWalletCoreMetrics(address),
    fetchProfile(username, address),
    fetchTransactionMetrics(address),
    fetchTokenActivity(address, appMap)
  ]);

  const age = calculateWalletAge(txMetrics.firstTransactionAt, Date.now());

  return {
    walletAddress: address,
    username,
    collectedAt: new Date().toISOString(),
    balance: {
      wei: core.balanceWei,
      formatted: core.balanceFormatted
    },
    metrics: {
      allTimeTx: core.allTimeTx,
      tx24h: txMetrics.tx24h,
      tx7d: txMetrics.tx7d,
      tx30d: txMetrics.tx30d,
      averageDailyTx:
        age.walletAgeDays && age.walletAgeDays > 0
          ? Number((core.allTimeTx / age.walletAgeDays).toFixed(2))
          : core.allTimeTx > 0
            ? core.allTimeTx
            : 0,
      firstTransactionAt: txMetrics.firstTransactionAt,
      lastTransactionAt: txMetrics.lastTransactionAt,
      walletAgeDays: age.walletAgeDays,
      walletAgeText: age.walletAgeText
    },
    profile,
    appSummary: tokenActivity,
    chart: txMetrics.chart
  };
}

async function main() {
  await mkdir("data", { recursive: true });

  const walletInput = await readJson("data/wallet-input.json");
  const appMap = await readJson("data/app-map.json");
  const results = [];

  for (const item of walletInput) {
    if (!isValidAddress(item.wallet)) {
      console.log(`Skipping invalid wallet: ${item.wallet}`);
      continue;
    }

    console.log(`Collecting ${item.wallet}...`);
    try {
      const result = await collectWallet(item, appMap);
      results.push(result);
      console.log(`Done: ${item.wallet}`);
    } catch (error) {
      console.log(`Failed: ${item.wallet} -> ${error.message}`);
    }
  }

  await writeFile("data/wallets.json", JSON.stringify(results, null, 2), "utf8");
  console.log(`Saved ${results.length} wallet record(s) to data/wallets.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
