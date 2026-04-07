const ABSTRACT_RPC_URL = process.env.ABSTRACT_RPC_URL || "https://api.mainnet.abs.xyz";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const ETHERSCAN_API_BASE = "https://api.etherscan.io/v2/api";
const CHAIN_ID = 2741;
const PAGE_SIZE = 1000;
const REQUEST_DELAY_MS = 220;
const DAY_IN_SECONDS = 24 * 60 * 60;
const DAY_IN_MS = DAY_IN_SECONDS * 1000;
const ONCHAIN_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html"
};
const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = globalThis.__walletApiCache || new Map();
globalThis.__walletApiCache = cache;

const TIER_V2_MAP = {
  1: "Bronze I",
  2: "Bronze II",
  3: "Bronze III",
  4: "Silver I",
  5: "Silver II",
  6: "Silver III",
  7: "Gold I",
  8: "Gold II",
  9: "Gold III",
  10: "Platinum I",
  11: "Platinum II",
  12: "Platinum III",
  13: "Diamond I",
  14: "Diamond II",
  15: "Diamond III",
  16: "Obsidian I",
  17: "Obsidian II",
  18: "Obsidian III"
};

function sendJson(res, statusCode, payload) {
  res.status(statusCode).json(payload);
}

function isValidAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address || "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatEtherFromHex(weiHex) {
  const wei = BigInt(weiHex);
  const base = 10n ** 18n;
  const whole = wei / base;
  const fraction = wei % base;
  const fractionText = fraction.toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return fractionText ? `${whole}.${fractionText}` : whole.toString();
}

function weiDecimalToEthString(value, decimals = 6) {
  const safe = String(value || "0");
  if (!/^\d+$/.test(safe)) return "0";

  const padded = safe.padStart(19, "0");
  const whole = padded.slice(0, -18).replace(/^0+/, "") || "0";
  const fraction = padded.slice(-18, -18 + decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function shortenAddress(address) {
  const safe = String(address || "");
  if (safe.length <= 10) return safe;
  return `${safe.slice(0, 4)}...${safe.slice(-4)}`;
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
  const walletAgeDays = Math.floor(diffMs / DAY_IN_MS);

  return {
    walletAgeDays,
    walletAgeText: `${walletAgeDays} days`
  };
}

function unescapeRSC(raw) {
  return raw
    .replace(/\\\\\\"/g, "\uFFFD")
    .replace(/\\"/g, "\"")
    .replace(/\uFFFD/g, "\\\"");
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
  if (!ETHERSCAN_API_KEY) {
    throw new Error("ETHERSCAN_API_KEY is missing.");
  }

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

async function fetchOnchainStats(walletAddress) {
  const response = await fetch(`https://onchain.abs.xyz/u/${walletAddress}`, {
    headers: ONCHAIN_HEADERS
  });

  const html = await response.text();
  if (!response.ok) {
    throw new Error(`onchain.abs error: HTTP ${response.status}`);
  }

  const metricsMatch = html.match(/\\"metrics\\":\s*(\{[^}]+\})/);
  const daysMatch = html.match(/\\"days\\":\s*(\[[^\]]+\])/);
  const appMatch = html.match(/\\"app\\":\{\\"address\\":\\"([^\\]+)\\",\\"txCount\\":(\d+),\\"totalValue\\":\\"(\d+)\\",\\"firstInteraction\\":\\"([^\\]+)\\",\\"lastInteraction\\":\\"([^\\]+)\\",\\"activeDays\\":(\d+),\\"name\\":\\"([^\\]+)\\"/);

  const metrics = metricsMatch ? JSON.parse(unescapeRSC(metricsMatch[1])) : null;
  const heatmap = daysMatch ? JSON.parse(unescapeRSC(daysMatch[1])) : [];

  let favoriteAppDetails = null;
  if (appMatch) {
    favoriteAppDetails = {
      address: appMatch[1],
      txCount: Number.parseInt(appMatch[2], 10),
      totalValueWei: appMatch[3],
      firstInteraction: appMatch[4],
      lastInteraction: appMatch[5],
      activeDays: Number.parseInt(appMatch[6], 10),
      name: appMatch[7]
    };
  }

  return {
    metrics,
    heatmap,
    favoriteAppDetails
  };
}

async function getWalletCoreMetrics(address) {
  const [nonceHex, balanceHex] = await Promise.all([
    rpcCall("eth_getTransactionCount", [address, "latest"]),
    rpcCall("eth_getBalance", [address, "latest"])
  ]);

  return {
    allTimeTx: Number.parseInt(nonceHex, 16),
    balanceWei: BigInt(balanceHex).toString(),
    balanceFormatted: formatEtherFromHex(balanceHex)
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
  let lastTransactionAt = null;
  let totalFeeWei = 0n;

  for (let page = 1; ; page += 1) {
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

      const gasUsed = BigInt(tx.gasUsed || "0");
      const gasPrice = BigInt(tx.gasPrice || "0");
      totalFeeWei += gasUsed * gasPrice;

      if (timestamp >= cutoff14d) {
        const isoDate = new Date(timestamp * 1000).toISOString().slice(0, 10);
        const point = chartLookup.get(isoDate);
        if (point) point.count += 1;
      }
    }

    if (batch.length < PAGE_SIZE) break;
  }

  const oldestBatch = await fetchEtherscanAccount("txlist", {
    address,
    startblock: 0,
    endblock: 99999999,
    page: 1,
    offset: 1,
    sort: "asc"
  });

  const firstTransactionAt = oldestBatch[0]?.timeStamp
    ? new Date(Number(oldestBatch[0].timeStamp) * 1000).toISOString()
    : null;

  return {
    tx24h,
    tx7d,
    tx30d,
    chart,
    firstTransactionAt,
    lastTransactionAt,
    totalFeeWei: totalFeeWei.toString()
  };
}

function buildTierDisplay(profile, onchainMetrics) {
  if (profile.tierV2 != null && TIER_V2_MAP[profile.tierV2]) {
    return TIER_V2_MAP[profile.tierV2];
  }

  if (profile.lastTierSeen != null && TIER_V2_MAP[profile.lastTierSeen]) {
    return TIER_V2_MAP[profile.lastTierSeen];
  }

  if (onchainMetrics?.tierName) {
    return String(onchainMetrics.tierName);
  }

  if (profile.tier != null) {
    return `Tier ${profile.tier}`;
  }

  return "Unranked";
}

function buildTitleProfile({
  walletAgeDays,
  allTimeTx,
  badgeCount,
  feeSpentEth,
  uniqueDays,
  favoriteApp
}) {
  const oldWallet = walletAgeDays >= 365;
  const heavyTx = allTimeTx >= 10000;
  const strongBadges = badgeCount >= 30;
  const mediumBadges = badgeCount >= 15;
  const highFee = feeSpentEth >= 0.25;
  const highlyActive = uniqueDays >= 180;

  if (walletAgeDays < 30 && allTimeTx < 500 && badgeCount < 5) {
    return {
      title: "NEWBIE",
      flavor: "Fresh wallet. Early footsteps on Abstract."
    };
  }

  if (oldWallet && heavyTx && strongBadges) {
    return {
      title: "OG",
      flavor: "Early presence, deep mileage, and serious badge weight."
    };
  }

  if (strongBadges && badgeCount >= allTimeTx / 500) {
    return {
      title: "BADGE OG",
      flavor: "Built through badge depth and portal progression."
    };
  }

  if (heavyTx || highlyActive) {
    return {
      title: "TX WARRIOR",
      flavor: "Relentless onchain motion across the Abstract ecosystem."
    };
  }

  if (highFee && allTimeTx >= 2000) {
    return {
      title: "GAS GIANT",
      flavor: "Pays up, pushes through, and lives onchain."
    };
  }

  if (favoriteApp && uniqueDays >= 90) {
    return {
      title: "APP NOMAD",
      flavor: "Sticks around, keeps exploring, and always finds a lane."
    };
  }

  if (mediumBadges || allTimeTx >= 2500) {
    return {
      title: "CHAIN CHAD",
      flavor: "Clearly active, clearly committed, clearly not casual."
    };
  }

  return {
    title: "NOBRAIN",
    flavor: "Present onchain, but still light on real Abstract grind."
  };
}

function buildMinimalProfile(address) {
  return {
    id: null,
    name: "Unknown",
    description: "",
    walletAddress: address,
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

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "Only GET requests are supported." });
  }

  const address = String(req.query.address || req.query.query || "").trim();
  if (!isValidAddress(address)) {
    return sendJson(res, 400, { error: "Please provide a valid wallet address." });
  }

  const cached = cache.get(address.toLowerCase());
  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    return sendJson(res, 200, cached.payload);
  }

  try {
    const [core, txMetrics, onchain] = await Promise.all([
      getWalletCoreMetrics(address),
      fetchTransactionMetrics(address),
      fetchOnchainStats(address).catch(() => ({
        metrics: null,
        heatmap: [],
        favoriteAppDetails: null
      }))
    ]);
    const liveProfile = buildMinimalProfile(address);
    const onchainMetrics = onchain.metrics || {};
    const age = calculateWalletAge(txMetrics.firstTransactionAt, Date.now());
    const displayTier = buildTierDisplay(liveProfile, onchainMetrics);
    const badgeCount = onchainMetrics.badgeCount ?? 0;
    const totalFeeEth = weiDecimalToEthString(txMetrics.totalFeeWei, 6);
    const favoriteAppSummary = onchain.favoriteAppDetails
      ? {
          name: onchain.favoriteAppDetails.name,
          address: onchain.favoriteAppDetails.address,
          txCount: onchain.favoriteAppDetails.txCount
        }
      : null;
    const persona = buildTitleProfile({
      walletAgeDays: age.walletAgeDays || 0,
      allTimeTx: core.allTimeTx,
      badgeCount,
      feeSpentEth: Number(totalFeeEth),
      uniqueDays: onchainMetrics.uniqueDays ?? 0,
      favoriteApp: favoriteAppSummary?.name || onchainMetrics.favoriteApp || null
    });

    const payload = {
      walletAddress: address,
      profile: {
        ...liveProfile,
        badgeCount,
        tierName: onchainMetrics.tierName ?? null,
        displayTier,
        favoriteApp: favoriteAppSummary?.name || onchainMetrics.favoriteApp || null,
        wojak: persona
      },
      balance: {
        wei: core.balanceWei,
        formatted: core.balanceFormatted
      },
      metrics: {
        allTimeTx: core.allTimeTx,
        tx24h: txMetrics.tx24h,
        tx7d: txMetrics.tx7d,
        tx30d: txMetrics.tx30d,
        firstTransactionAt: txMetrics.firstTransactionAt,
        lastTransactionAt: txMetrics.lastTransactionAt,
        walletAgeDays: age.walletAgeDays,
        walletAgeText: age.walletAgeText,
        totalFeeWei: txMetrics.totalFeeWei,
        totalFeeEth,
        uniqueDays: onchainMetrics.uniqueDays ?? null,
        longestStreak: onchainMetrics.longestStreak ?? null
      },
      transactionWindow: {
        dailyChart: onchain.heatmap?.length
          ? onchain.heatmap.slice(-14).map((item) => ({
              date: item.date,
              label: item.date.slice(5),
              fullDate: item.date,
              count: item.count
            }))
          : txMetrics.chart,
        recentTransactions: []
      },
      favoriteAppSummary,
      persona,
      privacy: {
        shortWallet: shortenAddress(address)
      }
    };

    cache.set(address.toLowerCase(), {
      createdAt: Date.now(),
      payload
    });

    return sendJson(res, 200, payload);
  } catch (liveError) {
    const message = liveError instanceof Error ? liveError.message : "Wallet lookup failed.";
    return sendJson(res, 500, { error: message });
  }
}
