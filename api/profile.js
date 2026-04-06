import { readFile } from "node:fs/promises";
import path from "node:path";

function sendJson(res, statusCode, payload) {
  res.status(statusCode).json(payload);
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

  const query = String(req.query.query || "").trim().toLowerCase();
  if (!query) {
    return sendJson(res, 400, { error: "Please provide a wallet or nickname." });
  }

  try {
    const wallets = await loadWalletData();

    const record = wallets.find((item) => {
      const wallet = String(item.walletAddress || "").toLowerCase();
      const username = String(item.username || item.profile?.name || "").toLowerCase();
      const profileWallet = String(item.profile?.walletAddress || "").toLowerCase();

      return query === wallet || query === username || query === profileWallet;
    });

    if (!record || !record.profile) {
      return sendJson(res, 404, {
        error: "Profile not found in local dataset. Run the collector first."
      });
    }

    return sendJson(res, 200, {
      source: {
        suggestUrl: "local-dataset",
        profileUrl: "local-dataset"
      },
      user: record.profile
    });
  } catch (error) {
    return sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Unexpected server error."
    });
  }
}
