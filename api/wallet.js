import { readFile } from "node:fs/promises";
import path from "node:path";

function sendJson(res, statusCode, payload) {
  res.status(statusCode).json(payload);
}

function isValidAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address || "");
}

async function loadWalletData() {
  const filePath = path.join(process.cwd(), "data", "wallets.json");
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "Only GET requests are supported." });
  }

  const address = String(req.query.address || "").trim();

  if (!isValidAddress(address)) {
    return sendJson(res, 400, { error: "Please provide a valid wallet address." });
  }

  try {
    const wallets = await loadWalletData();

    const record = wallets.find(
      (item) => String(item.walletAddress || "").toLowerCase() === address.toLowerCase()
    );

    if (!record) {
      return sendJson(res, 404, {
        error: "Wallet not found in local dataset. Run the collector first."
      });
    }

    return sendJson(res, 200, {
      walletAddress: record.walletAddress,
      profile: record.profile || {
        name: record.username || "Unknown",
        tier: "Tier unavailable",
        badgeCount: null,
        badgesSource: "Not connected"
      },
      balance: record.balance || {
        wei: "0",
        formatted: "0"
      },
      metrics: record.metrics || {
        allTimeTx: 0,
        tx24h: 0,
        tx7d: 0,
        tx30d: 0,
        averageDailyTx: 0,
        firstTransactionAt: null,
        lastTransactionAt: null,
        walletAgeDays: null,
        walletAgeText: "-"
      },
      transactionWindow: {
        dailyChart: record.chart || [],
        recentTransactions: []
      },
      appSummary: record.appSummary || {
        apps: [],
        mostUsed: null
      }
    });
  } catch (error) {
    return sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Unexpected server error."
    });
  }
}
