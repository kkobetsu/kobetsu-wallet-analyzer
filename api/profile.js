function sendJson(res, statusCode, payload) {
  res.status(statusCode).json(payload);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "application/json"
    }
  });

  const text = await response.text();
  let payload;

  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(text || `Invalid JSON from ${url}`);
  }

  if (!response.ok) {
    throw new Error(payload.error || payload.message || `Request failed: ${response.status}`);
  }

  return payload;
}

function normalizeSuggestPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.users)) return payload.users;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
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

  const walletMatch = normalized.find((item) => String(item.walletAddress).toLowerCase() === safeQuery);
  if (walletMatch) return walletMatch;

  const nameMatch = normalized.find((item) => String(item.name).toLowerCase() === safeQuery);
  if (nameMatch) return nameMatch;

  return normalized[0] || null;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "Only GET requests are supported." });
  }

  const query = String(req.query.query || "").trim();
  if (!query) {
    return sendJson(res, 400, { error: "Please provide a wallet or nickname." });
  }

  try {
    const suggestUrl = `https://abscope.live/api/suggest?query=${encodeURIComponent(query)}`;
    const suggestPayload = await fetchJson(suggestUrl);
    const candidates = normalizeSuggestPayload(suggestPayload);
    const picked = pickCandidate(candidates, query);

    if (!picked?.id) {
      return sendJson(res, 404, { error: "Profile not found from suggest source." });
    }

    const profileUrl = `https://abscope.live/api/proxy/user/${picked.id}`;
    const profilePayload = await fetchJson(profileUrl);
    const user = profilePayload?.user;

    if (!user) {
      return sendJson(res, 404, { error: "Profile payload did not include user data." });
    }

    return sendJson(res, 200, {
      source: {
        suggestUrl,
        profileUrl
      },
      user: {
        id: user.id,
        name: user.name,
        description: user.description,
        walletAddress: user.walletAddress,
        avatar: user.avatar || null,
        banner: user.banner || null,
        tier: user.tier,
        tierV2: user.tierV2,
        hasCompletedWelcomeTour: Boolean(user.hasCompletedWelcomeTour),
        hasStreamingAccess: Boolean(user.hasStreamingAccess),
        overrideProfilePictureUrl: user.overrideProfilePictureUrl || null,
        lastTierSeen: user.lastTierSeen ?? null,
        badges: Array.isArray(user.badges) ? user.badges : []
      }
    });
  } catch (error) {
    return sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Unexpected server error."
    });
  }
}
