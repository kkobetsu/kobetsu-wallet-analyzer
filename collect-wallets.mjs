import { mkdir, readFile, writeFile } from "node:fs/promises";

const ABSTRACT_RPC_URL = process.env.ABSTRACT_RPC_URL || "https://api.mainnet.abs.xyz";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const ETHERSCAN_API_BASE = "https://api.etherscan.io/v2/api";
const CHAIN_ID = 2741;
const PAGE_SIZE = 100;
const MAX_PAGES = 8;
const DELAY_MS = 450;
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

async function readJson(path) {
  const raw = await readFile(path, "utf8");
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

async function fetchExplorerTransactions(address, options = {}) {
  const url = new URL(ETHERSCAN_API_BASE);
  url.searchParams.set("chainid", String(CHAIN_ID));
  url.searchParams.set("module", "account");
  url.searchParams.set("action", "txlist");
  url.searchParams.set("address", address);
  url.searchParams.set("startblock", "0");
  url.searchParams.set("endblock", "99999999");
  url.searchParams.set("page", String(options.page || 1));
  url.searchParams.set("offset", String(options.offset || PAGE_SIZE));
  url.searchParams.set("sort", options.sort || "desc");
  url.searchParams.set("apikey", ETHERSCAN_API_KEY);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Explorer error: HTTP ${response.status}`);
  }

  const payload = await response.json();

  if (payload.status === "0") {
    if (payload.message === "No transactions found") {
      return [];
    }

    const reason = typeof payload.result === "string" ? payload.result : payload.message;
    if (/rate limit|max calls per sec|too many/i.test(reason || "")) {
      throw new Error("Explorer rate limit reached.");
    }

    throw new Error(reason || "Invalid explorer response.");
  }

  if (!Array.isArray(payload.result)) {
    throw new Error("Explorer result format is invalid.");
  }

  await sleep(DELAY_MS);
  return payload.result;
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

function buildAppSummary(transactions, appMap) {
  const groups = new Map();

  for (const tx of transactions) {
    const to = String(tx.to || "").toLowerCase();
    if (!to) {
      continue;
    }

    const name = appMap[to] || `${to.slice(0, 10)}...${to.slice(-4)}`;
    const current = groups.get(name) || {
      name,
      address: to,
      txCount: 0
    };

    current.txCount += 1;
    groups.set(name, current);
  }

  return Array.from(groups.values())
    .sort((a, b) => b.txCount - a.txCount)
    .slice(0, 10);
}

async function collectWallet(address, username, appMap) {
  const core = await getWalletCoreMetrics(address);
  const firstTxList = await fetchExplorerTransactions(address, {
    sort: "asc",
    page: 1,
    offset: 1
  });
  const firstTx = firstTxList[0] || null;

  const firstTransactionAt = firstTx
    ? new Date(Number(firstTx.timeStamp) * 1000).toISOString()
    : null;

  const age = calculateWalletAge(firstTransactionAt, Date.now());
  const chart = buildEmptyChart(14);
  const chartLookup = new Map(chart.map((item) => [item.date, item]));

  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoff24h = nowSeconds - DAY_IN_SECONDS;
  const cutoff7d = nowSeconds - 7 * DAY_IN_SECONDS;
  const cutoff30d = nowSeconds - 30 * DAY_IN_SECONDS;

  let tx24h = 0;
  let tx7d = 0;
  let tx30d = 0;
  let lastTransactionAt = null;
  let stop = false;
  const recentTransactions = [];

  for (let page = 1; page <= MAX_PAGES && !stop; page += 1) {
    const batch = await fetchExplorerTransactions(address, {
      sort: "desc",
      page,
      offset: PAGE_SIZE
    });

    if (batch.length === 0) {
      break;
    }

    if (!lastTransactionAt) {
      lastTransactionAt = new Date(Number(batch[0].timeStamp) * 1000).toISOString();
    }

    for (const tx of batch) {
      const timestamp = Number(tx.timeStamp);
      if (!Number.isFinite(timestamp)) {
        continue;
      }

      if (timestamp >= cutoff24h) {
        tx24h += 1;
      }

      if (timestamp >= cutoff7d) {
        tx7d += 1;
        recentTransactions.push(tx);
      }

      if (timestamp >= cutoff30d) {
        tx30d += 1;
      } else {
        stop = true;
      }

      const isoDate = new Date(timestamp * 1000).toISOString().slice(0, 10);
      if (chartLookup.has(isoDate)) {
        chartLookup.get(isoDate).count += 1;
      }
    }

    if (batch.length < PAGE_SIZE) {
      break;
    }
  }

  const apps = buildAppSummary(recentTransactions, appMap);
  const mostUsedApp = apps[0] || null;

  return {
    walletAddress: address,
    username: username || "Unknown",
    collectedAt: new Date().toISOString(),
    balance: {
      wei: core.balanceWei,
      formatted: core.balanceFormatted
    },
    metrics: {
      allTimeTx: core.allTimeTx,
      tx24h,
      tx7d,
      tx30d,
      averageDailyTx: age.walletAgeDays && age.walletAgeDays > 0
        ? Number((core.allTimeTx / age.walletAgeDays).toFixed(2))
        : core.allTimeTx > 0 ? core.allTimeTx : 0,
      firstTransactionAt,
      lastTransactionAt,
      walletAgeDays: age.walletAgeDays,
      walletAgeText: age.walletAgeText
    },
    profile: {
      name: username || "Unknown",
      tier: null,
      badgeCount: null,
      badgesSource: null
    },
    appSummary: {
      apps,
      mostUsed: mostUsedApp
    },
    chart
  };
}

async function main() {
  await mkdir("data", { recursive: true });

  const wallets = await readJson("data/wallet-input.json");
  const appMap = await readJson("data/app-map.json");
  const results = [];

  for (const item of wallets) {
    if (!isValidAddress(item.wallet)) {
      console.log(`Skipping invalid wallet: ${item.wallet}`);
      continue;
    }

    console.log(`Collecting ${item.wallet}...`);
    try {
      const result = await collectWallet(item.wallet, item.username, appMap);
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
