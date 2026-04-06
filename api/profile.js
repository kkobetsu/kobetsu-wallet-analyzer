function sendJson(res, statusCode, payload) {
  res.status(statusCode).json(payload);
}

const KOBETSU_FALLBACK = {
  source: {
    suggestUrl: "fallback",
    profileUrl: "fallback"
  },
  user: {
    id: "71017",
    name: "Kobetsu",
    description: "Null Space",
    walletAddress: "0xc1e07504817d6fed147fb503fd95966d2384ad8f",
    avatar: {
      assetType: "avatar",
      tier: 1,
      key: 3,
      season: 1
    },
    banner: {
      assetType: "banner",
      tier: 1,
      key: 2,
      season: 1
    },
    tier: 3,
    tierV2: 9,
    hasCompletedWelcomeTour: true,
    hasStreamingAccess: true,
    overrideProfilePictureUrl: "https://cdn.simplehash.com/assets/e6d55a01f939ceb3210da4cf19c524ee567a0bcae426853dc346f95b10e56b3b.png",
    lastTierSeen: 3,
    badges: [
      {
        badge: {
          id: 2,
          type: "regular",
          name: "Connect Twitter / X",
          icon: "twitter",
          description: "This badge is awarded to users who have connected their Twitter account.",
          requirement: "Verify your Twitter account to claim this badge."
        },
        claimed: true
      },
      {
        badge: {
          id: 3,
          type: "regular",
          name: "Fund Your Account",
          icon: "fund-account",
          description: "This badge is awarded to those who have funded their account.",
          requirement: "Fund your account to claim this badge."
        },
        claimed: true
      },
      {
        badge: {
          id: 4,
          type: "regular",
          name: "App Voter",
          icon: "app-voter",
          description: "This badge is awarded to those who have upvoted at least one app in the portal.",
          requirement: "Upvote an app on the portal to claim this badge."
        },
        claimed: true
      },
      {
        badge: {
          id: 5,
          type: "regular",
          name: "The Trader",
          icon: "the-trader",
          description: "This badge is awarded to users who trade on the Portal at least once.",
          requirement: "Trade on the portal to claim this badge."
        },
        claimed: true
      },
      {
        badge: {
          id: 1,
          type: "regular",
          name: "Connect Discord",
          icon: "discord",
          description: "This badge is awarded to users who have connected their Discord account.",
          requirement: "Verify your Discord account to claim this badge."
        },
        claimed: true
      },
      {
        badge: {
          id: 34,
          type: "flash",
          name: "The Black Star Badge",
          icon: "black-star",
          description: "This badge is awarded to those who mint a ticket to view Still a Black Star.",
          requirement: "Mint a ticket to view Still a Black Star."
        },
        claimed: true
      },
      {
        badge: {
          id: 16,
          type: "secret",
          name: "The Sock Master",
          icon: "sock-master",
          description: "The badge is awarded to those who own the mythical Abstract Socks.",
          requirement: "Own a pair of Abstract Socks, on-chain to claim this badge."
        },
        claimed: true
      },
      {
        badge: {
          id: 13,
          type: "flash",
          name: "Myriad Master",
          icon: "myriad-master",
          description: "This badge is awarded to users who has any amount of money on a market in Myriad.",
          requirement: "Trade on a Myriad market to claim this badge."
        },
        claimed: true
      },
      {
        badge: {
          id: 21,
          type: "secret",
          name: "The Onchain Hero",
          icon: "och",
          description: "This badge is awarded to those who participated in Season 1 of Onchain Heroes.",
          requirement: "Participate in Season 1 of Onchain Heroes to earn this badge."
        },
        claimed: true
      },
      {
        badge: {
          id: 52,
          type: "secret",
          name: "The Master Rugpuller",
          icon: "rugpull-bakery",
          description: "This badge is awarded to those who baked 1,000 cookies on Rugpull Bakery S1.",
          requirement: "Bake 1,000 cookies on Rugpull Bakery S1 to earn this badge."
        },
        claimed: true
      }
    ]
  }
};

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

function getFallbackProfile(query) {
  const safeQuery = String(query || "").trim().toLowerCase();
  const wallet = KOBETSU_FALLBACK.user.walletAddress.toLowerCase();

  if (
    safeQuery === "kobetsu" ||
    safeQuery === wallet ||
    safeQuery === "0xc1e07504817d6fed147fb503fd95966d2384ad8f"
  ) {
    return KOBETSU_FALLBACK;
  }

  return null;
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
      const fallback = getFallbackProfile(query);
      if (fallback) {
        return sendJson(res, 200, fallback);
      }
      return sendJson(res, 404, {
        error: "Profile not found from suggest source."
      });
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
    const fallback = getFallbackProfile(query);
    if (fallback) {
      return sendJson(res, 200, fallback);
    }
    return sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Unexpected server error."
    });
  }
}
