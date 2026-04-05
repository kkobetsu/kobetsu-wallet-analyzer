const ABSTRACT_RPC_URL = process.env.ABSTRACT_RPC_URL || "https://api.mainnet.abs.xyz";
const ETHERSCAN_API_BASE = "https://api.etherscan.io/v2/api";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const CHAIN_ID = 2741;
const PAGE_SIZE = 100;
const MAX_PAGES = 200;
const DAY_IN_SECONDS = 24 * 60 * 60;
const DAY_IN_MS = DAY_IN_SECONDS * 1000;

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
  if (!ETHERSCAN_API_KEY) {
    throw new Error("ETHERSCAN_API_KEY is missing. Add it in Vercel Environment Variables.");
  }

  const url = new URL(ETHERSCAN_API_BASE);
  url.searchParams.set("chainid", String(CHAIN_ID));
  url.searchParams.set("module", "account");
  url.searchParams.set("action", "txlist");
  url.searchParams.set("address", address);
  url.searchParams.set("startblock", String(options.startblock || 0));
  url.searchParams.set("endblock", String(options.endblock || 99999999));
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

    throw new Error(payload.result || "Invalid explorer response.");
  }

  if (!Array.isArray(payload.result)) {
    throw new Error("Explorer result format is invalid.");
  }

  return payload.result;
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
      walletAgeText: "No transaction history found"
    };
  }

  const diffMs = Math.max(0, nowMs - new Date(firstTransactionAt).getTime());
  const walletAgeDays = diffMs / DAY_IN_MS;

  if (walletAgeDays < 1) {
    const hours = Math.max(1, Math.floor(diffMs / (60 * 60 * 1000)));
    return {
      walletAgeDays,
      walletAgeText: `${hours} hours`
    };
  }

  if (walletAgeDays < 30) {
    return {
      walletAgeDays,
      walletAgeText: `${Math.floor(walletAgeDays)} days`
    };
  }

  const months = walletAgeDays / 30.4375;
  return {
    walletAgeDays,
    walletAgeText: `${months.toFixed(1)} months`
  };
}

async function getFirstTransaction(address) {
  const result = await fetchExplorerTransactions(address, {
    sort: "asc",
    page: 1,
    offset: 1
  });

  return result[0] || null;
}

async function getTransactionWindowMetrics(address) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoff24h = nowSeconds - DAY_IN_SECONDS;
  const cutoff7d = nowSeconds - 7 * DAY_IN_SECONDS;
  const cutoff30d = nowSeconds - 30 * DAY_IN_SECONDS;
  const chartPoints = buildEmptyChart(14);
  const chartLookup = new Map(chartPoints.map((point) => [point.date, point]));

  let tx24h = 0;
  let tx7d = 0;
  let tx30d = 0;
  let lastTransactionAt = null;
  let shouldStop = false;

  for (let page = 1; page <= MAX_PAGES && !shouldStop; page += 1) {
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
      }

      if (timestamp >= cutoff30d) {
        tx30d += 1;
        const isoDate = new Date(timestamp * 1000).toISOString().slice(0, 10);

        if (chartLookup.has(isoDate)) {
          chartLookup.get(isoDate).count += 1;
        }
      } else {
        shouldStop = true;
        break;
      }
    }

    if (batch.length < PAGE_SIZE) {
      break;
    }
  }

  return {
    tx24h,
    tx7d,
    tx30d,
    lastTransactionAt,
    dailyChart: chartPoints
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "Only GET requests are supported." });
  }

  const address = String(req.query.address || "").trim();

  if (!isValidAddress(address)) {
    return sendJson(res, 400, { error: "Please provide a valid EVM wallet address." });
  }

  try {
    const [coreMetrics, firstTransaction, transactionWindow] = await Promise.all([
      getWalletCoreMetrics(address),
      getFirstTransaction(address),
      getTransactionWindowMetrics(address)
    ]);

    const firstTransactionAt = firstTransaction
      ? new Date(Number(firstTransaction.timeStamp) * 1000).toISOString()
      : null;

    const ageMetrics = calculateWalletAge(firstTransactionAt, Date.now());

    const averageDailyTx = ageMetrics.walletAgeDays && ageMetrics.walletAgeDays > 0
      ? Number((coreMetrics.allTimeTx / ageMetrics.walletAgeDays).toFixed(2))
      : coreMetrics.allTimeTx > 0 ? coreMetrics.allTimeTx : 0;

    return sendJson(res, 200, {
      walletAddress: address,
      network: {
        name: "Abstract Mainnet",
        chainId: CHAIN_ID
      },
      balance: {
        wei: coreMetrics.balanceWei,
        formatted: coreMetrics.balanceFormatted
      },
      metrics: {
        allTimeTx: coreMetrics.allTimeTx,
        tx24h: transactionWindow.tx24h,
        tx7d: transactionWindow.tx7d,
        tx30d: transactionWindow.tx30d,
        averageDailyTx,
        firstTransactionAt,
        lastTransactionAt: transactionWindow.lastTransactionAt,
        walletAgeDays: ageMetrics.walletAgeDays,
        walletAgeText: ageMetrics.walletAgeText
      },
      transactionWindow: {
        dailyChart: transactionWindow.dailyChart
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    return sendJson(res, 500, { error: message });
  }
}
