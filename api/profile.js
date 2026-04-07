import { readFile } from "node:fs/promises";
import path from "node:path";

const cache = globalThis.__profileCache || new Map();
globalThis.__profileCache = cache;
const CACHE_TTL_MS = 30 * 60 * 1000;

function sendJson(res, statusCode, payload) {
  res.status(statusCode).json(payload);
}

function isValidAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address || "");
}

function normalizeProfile(user, fallbackWallet = "") {
  return {
    id: user?.id ?? null,
    name: user?.name || "Unknown",
    description: user?.description || "",
    walletAddress: user?.walletAddress || fallbackWallet,
    avatar: user?.avatar || null,
    banner: user?.banner || null,
    tier: user?.tier ?? null,
    tierV2: user?.tierV2 ?? null,
    hasCompletedWelcomeTour: Boolean(user?.hasCompletedWelcomeTour),
    hasStreamingAccess: Boolean(user?.hasStreamingAccess),
    overrideProfilePictureUrl: user?.overrideProfilePictureUrl || null,
    lastTierSeen: user?.lastTierSeen ?? null,
    badges: Array.isArray(user?.badges) ? user.badges : [],
    badgeCount: user?.badgeCount ?? (Array.isArray(user?.badges) ? user.badges.length : 0),
    tierName: user?.tierName ?? null,
    favoriteApp: user?.favoriteApp ?? null,
    wojak: user?.wojak ?? null
  };
}

async function loadWalletData() {
  const filePath = path.join(process.cwd(), "data", "wallets.json");
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function collectCandidates(value, results = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectCandidates(item, results);
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

function pickCandidate(candidates, query) {
  const safeQuery = String(query || "").trim().toLowerCase();
  const normalized = candidates.map(normalizeCandidate).filter((item) => item.id != null);

  const exactWallet = normalized.find(
    (item) => String(item.walletAddress).toLowerCase() === safeQuery
  );
  if (exactWallet) return exactWallet;

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

function getCachedProfile(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.createdAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.payload;
}

function setCachedProfile(keys, payload) {
  for (const key of keys) {
    if (!key) continue;
    cache.set(key, {
      createdAt: Date.now(),
      payload
    });
  }
}

async function fetchLocalProfile(query) {
  try {
    const wallets = await loadWalletData();
    const lowered = query.toLowerCase();
    const record = wallets.find((item) => {
      const wallet = String(item.walletAddress || "").toLowerCase();
      const username = String(item.username || item.profile?.name || "").toLowerCase();
      const profileWallet = String(item.profile?.walletAddress || "").toLowerCase();

      return lowered === wallet || lowered === username || lowered === profileWallet;
    });

    if (!record?.profile) return null;

    return {
      source: {
        suggestUrl: "local-dataset",
        profileUrl: "local-dataset"
      },
      user: normalizeProfile(record.profile, record.walletAddress)
    };
  } catch {
    return null;
  }
}

async function fetchLiveNicknameProfile(query) {
  const variants = Array.from(
    new Set([
      query,
      query.toLowerCase(),
      query.length ? query.charAt(0).toUpperCase() + query.slice(1).toLowerCase() : query
    ].filter(Boolean))
  );

  let lastError = null;

  for (const variant of variants) {
    try {
      const suggestUrl = `https://abscope.live/api/suggest?query=${encodeURIComponent(variant)}`;
      const suggestPayload = await fetchJsonMaybe(suggestUrl);
      const candidates = collectCandidates(suggestPayload);
      const picked = pickCandidate(candidates, variant);

      if (!picked?.id) continue;

      const profileUrl = `https://abscope.live/api/proxy/user/${picked.id}`;
      const profilePayload = await fetchJsonMaybe(profileUrl);
      const user = profilePayload?.user;

      if (!user) continue;

      return {
        source: {
          suggestUrl,
          profileUrl
        },
        user: normalizeProfile(user)
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Profile not found.");
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "Only GET requests are supported." });
  }

  const query = String(req.query.query || "").trim();
  if (!query) {
    return sendJson(res, 400, { error: "Please enter a wallet or nickname." });
  }

  const cacheKey = query.toLowerCase();
  const cached = getCachedProfile(cacheKey);
  if (cached) {
    return sendJson(res, 200, cached);
  }

  if (isValidAddress(query)) {
    const local = await fetchLocalProfile(query);
    if (local) {
      setCachedProfile(
        [
          query.toLowerCase(),
          String(local.user.walletAddress || "").toLowerCase(),
          String(local.user.name || "").toLowerCase()
        ],
        local
      );
      return sendJson(res, 200, local);
    }

    const minimal = {
      source: {
        suggestUrl: "wallet-direct",
        profileUrl: "wallet-direct"
      },
      user: normalizeProfile(
        {
          name: "Unknown",
          walletAddress: query
        },
        query
      )
    };

    setCachedProfile([query.toLowerCase()], minimal);
    return sendJson(res, 200, minimal);
  }

  const localByName = await fetchLocalProfile(query);
  if (localByName) {
    setCachedProfile(
      [
        query.toLowerCase(),
        String(localByName.user.walletAddress || "").toLowerCase(),
        String(localByName.user.name || "").toLowerCase()
      ],
      localByName
    );
    return sendJson(res, 200, localByName);
  }

  try {
    const live = await fetchLiveNicknameProfile(query);
    setCachedProfile(
      [
        query.toLowerCase(),
        String(live.user.walletAddress || "").toLowerCase(),
        String(live.user.name || "").toLowerCase()
      ],
      live
    );
    return sendJson(res, 200, live);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Profile lookup failed.";
    return sendJson(res, 404, { error: message });
  }
}
