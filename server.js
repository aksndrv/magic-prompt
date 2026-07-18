// NL2AE backend proxy.
//
// Responsibilities:
//   1. Let a patron log in with Patreon and verify they're an active,
//      qualifying member of your campaign.
//   2. Issue them a long-lived session token (they paste this into the panel once).
//   3. On every /generate call: check the token is valid, check they're
//      still an active patron, check their monthly spend is under budget,
//      then (and only then) call Claude with YOUR key and track the cost.
//   4. Listen for Patreon webhooks so cancellations take effect immediately
//      instead of waiting for the next check.
//
// Storage: SQLite in a single file (db.sqlite). Fine for hundreds of
// patrons. If you outgrow it, swap in Postgres later -- the query shapes
// stay basically the same.

const express = require("express");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const app = express();

// Allow the CEP panel (running from a different origin) to call this server.
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

app.use(express.json());
// Webhook signature verification needs the raw body, so capture it too.
app.use(express.raw({ type: "application/json", limit: "2mb", verify: (req, res, buf) => { req.rawBody = buf; } }));

const {
    PORT = 3000,
    PATREON_CLIENT_ID,
    PATREON_CLIENT_SECRET,
    PATREON_REDIRECT_URI,      // e.g. https://your-server.com/auth/patreon/callback
    PATREON_CAMPAIGN_ID,       // your campaign's numeric ID
    PATREON_WEBHOOK_SECRET,    // set this when you create the webhook in Patreon's dashboard
    ANTHROPIC_API_KEY,
    MIN_PLEDGE_CENTS = "500",  // minimum tier that qualifies, in cents ($5.00)
    MONTHLY_BUDGET_CENTS = "250", // hard cap per patron per month, in cents ($2.50) -- see README for reasoning
} = process.env;

const db = new Database("db.sqlite");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
    patreon_id TEXT PRIMARY KEY,
    session_token TEXT UNIQUE,
    active_patron INTEGER DEFAULT 0,
    period_start TEXT,
    cents_used INTEGER DEFAULT 0,
    last_script TEXT,
    updated_at TEXT
);
`);
// Safe to run even if the column already exists from an earlier version of this table.
try { db.exec(`ALTER TABLE users ADD COLUMN last_script TEXT`); } catch (e) { /* already exists, fine */ }

function currentMonthKey() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function getOrResetUser(patreonId) {
    const row = db.prepare("SELECT * FROM users WHERE patreon_id = ?").get(patreonId);
    if (!row) return null;
    const month = currentMonthKey();
    if (row.period_start !== month) {
        db.prepare("UPDATE users SET period_start = ?, cents_used = 0 WHERE patreon_id = ?").run(month, patreonId);
        row.period_start = month;
        row.cents_used = 0;
    }
    return row;
}

// ---------------------------------------------------------------------
// 1. Patreon OAuth login
// ---------------------------------------------------------------------

app.get("/auth/patreon/login", (req, res) => {
    const url = new URL("https://www.patreon.com/oauth2/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", PATREON_CLIENT_ID);
    url.searchParams.set("redirect_uri", PATREON_REDIRECT_URI);
    url.searchParams.set("scope", "identity identity.memberships");
    res.redirect(url.toString());
});

app.get("/auth/patreon/callback", async (req, res) => {
    try {
        const code = req.query.code;
        if (!code) return res.status(400).send("Missing code.");

        // Exchange the authorization code for an access token.
        const tokenRes = await fetch("https://www.patreon.com/api/oauth2/token", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                code,
                grant_type: "authorization_code",
                client_id: PATREON_CLIENT_ID,
                client_secret: PATREON_CLIENT_SECRET,
                redirect_uri: PATREON_REDIRECT_URI,
            }),
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) {
            return res.status(400).send("Patreon login failed: " + JSON.stringify(tokenData));
        }

        // Check identity + membership status against YOUR campaign.
        const identityUrl = new URL("https://www.patreon.com/api/oauth2/v2/identity");
        identityUrl.searchParams.set("include", "memberships.currently_entitled_tiers,memberships.campaign");
        identityUrl.searchParams.set("fields[member]", "patron_status,currently_entitled_amount_cents");

        const identityRes = await fetch(identityUrl, {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        const identity = await identityRes.json();

        if (!identity.data) {
            console.error("Patreon identity call failed:", JSON.stringify(identity));
            return res.status(502).send(
                "Couldn't fetch your Patreon identity. Details logged on the server. Raw response: " +
                JSON.stringify(identity)
            );
        }

        const patreonId = identity.data.id;
        const memberships = (identity.included || []).filter((i) => i.type === "member");
        let qualifying = memberships.find((m) => {
            const campaignId = m.relationships && m.relationships.campaign && m.relationships.campaign.data && m.relationships.campaign.data.id;
            return campaignId === PATREON_CAMPAIGN_ID
                && m.attributes.patron_status === "active_patron"
                && m.attributes.currently_entitled_amount_cents >= Number(MIN_PLEDGE_CENTS);
        });

        // TEST MODE: lets you (the creator) log in and test the pipeline
        // without needing a real membership record, since creators don't
        // have a pledge to their own campaign. REMOVE / set to "false"
        // before real patrons start using this.
        if (!qualifying && process.env.TEST_MODE === "true") {
            console.log("TEST_MODE active: bypassing membership check for", patreonId);
            qualifying = true;
        }

        if (!qualifying) {
            return res.status(403).send("You're not currently an active patron at the qualifying tier.");
        }

        // Issue (or reuse) a session token.
        let row = db.prepare("SELECT * FROM users WHERE patreon_id = ?").get(patreonId);
        const sessionToken = row ? row.session_token : crypto.randomBytes(24).toString("hex");

        db.prepare(`
            INSERT INTO users (patreon_id, session_token, active_patron, period_start, cents_used, updated_at)
            VALUES (@patreonId, @sessionToken, 1, @month, 0, @now)
            ON CONFLICT(patreon_id) DO UPDATE SET
                active_patron = 1,
                session_token = @sessionToken,
                updated_at = @now
        `).run({ patreonId, sessionToken, month: currentMonthKey(), now: new Date().toISOString() });

        // Show the token once, for the patron to paste into the panel.
        res.send(`
            <html><body style="font-family:sans-serif; max-width:480px; margin:60px auto;">
              <h2>You're in!</h2>
              <p>Copy this code and paste it into the "Login" field in the After Effects panel:</p>
              <textarea readonly style="width:100%; height:60px; font-family:monospace; font-size:14px;">${sessionToken}</textarea>
              <p>Keep this private -- it's tied to your membership and your monthly usage.</p>
            </body></html>
        `);
    } catch (err) {
        console.error(err);
        res.status(500).send("Something went wrong during login.");
    }
});

// ---------------------------------------------------------------------
// 2. Patreon webhooks -- keep membership status current without polling
// ---------------------------------------------------------------------

app.post("/webhooks/patreon", (req, res) => {
    try {
        const signature = req.headers["x-patreon-signature"];
        const expected = crypto.createHmac("md5", PATREON_WEBHOOK_SECRET).update(req.rawBody).digest("hex");
        if (signature !== expected) return res.status(401).send("Bad signature.");

        const event = req.headers["x-patreon-event"];
        const payload = JSON.parse(req.rawBody.toString());
        const patreonId = payload.data.relationships.user.data.id;

        if (event === "members:pledge:delete") {
            db.prepare("UPDATE users SET active_patron = 0 WHERE patreon_id = ?").run(patreonId);
        } else if (event === "members:pledge:update" || event === "members:pledge:create") {
            const cents = payload.data.attributes.currently_entitled_amount_cents;
            const status = payload.data.attributes.patron_status;
            const qualifies = status === "active_patron" && cents >= Number(MIN_PLEDGE_CENTS);
            db.prepare("UPDATE users SET active_patron = ? WHERE patreon_id = ?").run(qualifies ? 1 : 0, patreonId);
        }

        res.status(200).send("ok");
    } catch (err) {
        console.error(err);
        res.status(500).send("Webhook processing failed.");
    }
});

// ---------------------------------------------------------------------
// 3. The actual generation proxy
// ---------------------------------------------------------------------

app.post("/generate", express.json(), async (req, res) => {
    try {
        const { sessionToken, instruction, snippets, compSnapshot } = req.body;
        if (!sessionToken || !instruction) return res.status(400).json({ error: "Missing sessionToken or instruction." });

        const user = getOrResetUser(
            db.prepare("SELECT patreon_id FROM users WHERE session_token = ?").get(sessionToken)?.patreon_id
        );
        if (!user) return res.status(401).json({ error: "Invalid login code." });
        if (!user.active_patron) return res.status(403).json({ error: "Your Patreon membership isn't active. Log in again to refresh." });
        if (user.cents_used >= Number(MONTHLY_BUDGET_CENTS)) {
            return res.status(429).json({ error: "Monthly usage limit reached. Resets at the start of next month." });
        }

        const systemPrompt =
            "You write Adobe After Effects ExtendScript. Output ONLY raw ExtendScript code, " +
            "no explanation, no markdown fences. It runs inside a function via eval(), so end " +
            "with a return statement returning a short string describing what it did. Assume " +
            "app.project already exists; use app.project.activeItem if it's a CompItem, otherwise " +
            "create a new comp. IMPORTANT: many AE API calls require true integers for pixel " +
            "dimensions (e.g. addSolid width/height, addComp width/height) -- calculated values " +
            "like comp.width / count often produce decimals, which AE rejects. Always wrap any " +
            "calculated numeric value passed to a width/height/pixel parameter in Math.round(). " +
            "When you create layers, always give them clear, descriptive, unique names (e.g. " +
            "'Bar 1', 'Bar 2', 'Year Label 2023') so they can be found again later by name. " +
            (compSnapshot && compSnapshot.hasActiveComp
                ? "Here is the ACTUAL CURRENT STATE of the active comp, queried live from After " +
                  "Effects right now -- this is ground truth, not a guess. If this instruction is " +
                  "a modification/follow-up (e.g. 'change X', 'make it Y instead'), do NOT " +
                  "recreate anything that already exists -- find the existing layers by name (e.g. " +
                  "comp.layer('Bar 1')) and modify only what's needed. Only build new objects " +
                  "from scratch if the instruction clearly asks for something new:\n\n" +
                  JSON.stringify(compSnapshot) + "\n\n"
                : "There is no active comp with known contents right now -- if the instruction " +
                  "implies modifying something, you may need to create it fresh instead.\n\n") +
            "Reference patterns:\n\n" + (snippets || []).join("\n\n");

        const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
                model: "claude-sonnet-5",
                max_tokens: 3000,
                system: systemPrompt,
                messages: [{ role: "user", content: instruction }],
            }),
        });
        const data = await claudeRes.json();
        if (data.error) return res.status(502).json({ error: "Claude API error: " + data.error.message });

        if (data.stop_reason === "max_tokens") {
            console.warn("Response was truncated (hit max_tokens) for instruction:", instruction);
            return res.status(502).json({ error: "The script was too long and got cut off. Try breaking your request into smaller steps." });
        }

        // Track real spend using Anthropic's reported token usage.
        // Sonnet 5: $3/million input, $15/million output (adjust if pricing changes).
        const inputCents = (data.usage.input_tokens / 1_000_000) * 300;
        const outputCents = (data.usage.output_tokens / 1_000_000) * 1500;
        const costCents = Math.ceil(inputCents + outputCents);

        const script = data.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n")
            .replace(/^```(javascript|js|jsx)?/gm, "")
            .replace(/```$/gm, "")
            .trim();

        db.prepare("UPDATE users SET cents_used = cents_used + ?, last_script = ? WHERE patreon_id = ?")
            .run(costCents, script, user.patreon_id);

        res.json({ script, centsUsed: user.cents_used + costCents, budgetCents: Number(MONTHLY_BUDGET_CENTS) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error." });
    }
});

app.listen(PORT, () => console.log(`NL2AE proxy listening on :${PORT}`));
