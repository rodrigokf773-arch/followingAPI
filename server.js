import express from "express";
import rateLimit from "express-rate-limit";

const app = express();

app.disable("x-powered-by");
app.use(express.json());

const PORT = Number(process.env.PORT) || 3000;

const API_SECRET = process.env.API_SECRET;
const ROBLOX_COOKIE = process.env.ROBLOX_COOKIE;

if (!API_SECRET) {
    throw new Error("A variável API_SECRET não foi configurada.");
}

if (!ROBLOX_COOKIE) {
    throw new Error("A variável ROBLOX_COOKIE não foi configurada.");
}

const limiter = rateLimit({
    windowMs: 60_000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
});

app.use(limiter);

const cache = new Map();
const CACHE_DURATION_MS = 60_000;

function isValidUserId(value) {
    return /^\d+$/.test(value) && value !== "0";
}

function authenticateRequest(req, res, next) {
    const providedSecret = req.get("X-API-Key");

    if (!providedSecret || providedSecret !== API_SECRET) {
        return res.status(401).json({
            success: false,
            error: "Unauthorized",
        });
    }

    next();
}

async function fetchFollowingsPage(userId, cursor = null) {
    const params = new URLSearchParams({
        limit: "100",
        sortOrder: "Asc",
    });

    if (cursor) {
        params.set("cursor", cursor);
    }

    const url =
        `https://friends.roblox.com/v1/users/${userId}/followings?${params}`;

    const response = await fetch(url, {
        method: "GET",
        headers: {
            Accept: "application/json",
            Cookie: `.ROBLOSECURITY=${ROBLOX_COOKIE}`,
        },
        signal: AbortSignal.timeout(10_000),
    });

    const bodyText = await response.text();

    let body;

    try {
        body = JSON.parse(bodyText);
    } catch {
        body = {
            raw: bodyText,
        };
    }

    if (!response.ok) {
        const error = new Error(
            `Roblox respondeu com HTTP ${response.status}`
        );

        error.status = response.status;
        error.body = body;

        throw error;
    }

    return body;
}

async function checkFollowing(userId, targetId) {
    let cursor = null;
    let checked = 0;
    let pagesChecked = 0;

    // Limite defensivo para evitar loops ou consumo excessivo.
    const maximumPages = 100;

    do {
        const page = await fetchFollowingsPage(userId, cursor);

        pagesChecked += 1;

        if (!Array.isArray(page.data)) {
            throw new Error("Resposta inesperada da API da Roblox.");
        }

        for (const following of page.data) {
            checked += 1;

            if (String(following.id) === String(targetId)) {
                return {
                    isFollowing: true,
                    checked,
                    pagesChecked,
                };
            }
        }

        cursor = page.nextPageCursor ?? null;
    } while (cursor && pagesChecked < maximumPages);

    return {
        isFollowing: false,
        checked,
        pagesChecked,
        truncated: Boolean(cursor),
    };
}

app.get("/health", (req, res) => {
    res.json({
        success: true,
        status: "online",
    });
});

app.get("/is-following", authenticateRequest, async (req, res) => {
    const userId = String(req.query.userId ?? "");
    const targetId = String(req.query.targetId ?? "");

    if (!isValidUserId(userId) || !isValidUserId(targetId)) {
        return res.status(400).json({
            success: false,
            error: "userId e targetId devem ser IDs numéricos válidos.",
        });
    }

    if (userId === targetId) {
        return res.json({
            success: true,
            userId,
            targetId,
            isFollowing: false,
            checked: 0,
            pagesChecked: 0,
        });
    }

    const cacheKey = `${userId}:${targetId}`;
    const cached = cache.get(cacheKey);

    if (
        cached &&
        Date.now() - cached.createdAt < CACHE_DURATION_MS
    ) {
        return res.json({
            success: true,
            userId,
            targetId,
            ...cached.result,
            cached: true,
        });
    }

    try {
        const result = await checkFollowing(userId, targetId);

        cache.set(cacheKey, {
            result,
            createdAt: Date.now(),
        });

        return res.json({
            success: true,
            userId,
            targetId,
            ...result,
            cached: false,
        });
    } catch (error) {
        console.error("Falha ao consultar Roblox:", {
            message: error.message,
            status: error.status,
            body: error.body,
        });

        if (error.status === 401) {
            return res.status(502).json({
                success: false,
                error: "O cookie Roblox está inválido ou expirou.",
            });
        }

        if (error.status === 429) {
            return res.status(503).json({
                success: false,
                error: "A Roblox aplicou rate limit.",
            });
        }

        return res.status(502).json({
            success: false,
            error: "Não foi possível consultar a Roblox.",
        });
    }
});

app.listen(PORT, () => {
    console.log(`API iniciada na porta ${PORT}.`);
});
