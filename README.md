# NL2AE backend proxy — setup guide

This is the piece that makes sharing safe: your Anthropic API key lives
here, never in the panel you distribute. It checks that each request
comes from a real, active $5+ patron, and stops them once they hit
their monthly budget.

## What it does, in order

1. A patron clicks "Log in with Patreon" in the panel → opens their
   browser → they approve access → your server checks with Patreon
   that they're an active patron at $5+.
2. If yes, they get a private login code shown on screen, which they
   paste into the panel once.
3. Every time they click "Generate & run," the panel sends their code +
   instruction to this server. The server checks: valid code? Still an
   active patron? Under budget this month? Only then does it call
   Claude with your key.
4. Patreon webhooks tell your server immediately if someone cancels, so
   they lose access right away instead of at the next login.

## One-time setup

### 1. Register your app with Patreon

Go to https://www.patreon.com/portal/registration/register-clients
and create a new client. You'll need:
- A redirect URI — this must exactly match `PATREON_REDIRECT_URI` in
  your `.env` file (see below), e.g.
  `https://your-server.onrender.com/auth/patreon/callback`
- This gives you a **Client ID** and **Client Secret**.

Find your **Campaign ID** in your creator dashboard (it's in the URL
when you're editing your campaign, or via the API's `/campaigns`
endpoint).

### 2. Register a webhook

At https://www.patreon.com/portal/registration/register-webhooks,
create a webhook pointing at `https://your-server.../webhooks/patreon`,
subscribed to `members:pledge:create`, `members:pledge:update`, and
`members:pledge:delete`. Patreon will give you a **webhook secret** —
put that in `.env` too.

### 3. Fill in `.env`

Copy `.env.example` to `.env` and fill in every value: Patreon client
ID/secret, redirect URI, campaign ID, webhook secret, and your
Anthropic API key from console.anthropic.com.

`MONTHLY_BUDGET_CENTS` defaults to 250 ($2.50/patron/month) — see the
"Budget reasoning" section below for why, and adjust if you want.

### 4. Deploy it somewhere

You need a server that's always running (not a serverless function,
since it needs a persistent SQLite file). Easiest options for someone
who isn't a backend dev day-to-day:

- **Render.com** — free/cheap tier, connects directly to a GitHub repo,
  handles HTTPS automatically. Push this folder to a GitHub repo, then
  "New Web Service" on Render, point it at the repo, set the env vars
  from your `.env` in Render's dashboard, deploy.
- **Railway.app** — similar, also very beginner-friendly.

Either way: once deployed, you'll get a URL like
`https://nl2ae.onrender.com`. Update:
- `PATREON_REDIRECT_URI` in `.env` to `<that URL>/auth/patreon/callback`
- `SERVER_URL` in `client/index.js` (in the panel project) to that same
  base URL

### 5. Run it locally first to test (optional but recommended)

```
npm install
npm start
```

Use a tool like ngrok to get a temporary public HTTPS URL for testing
the Patreon OAuth flow before you deploy for real, since Patreon
requires HTTPS redirect URIs.

## Budget reasoning

At $3.44 net per patron/month and Claude Sonnet 5 pricing (~$0.009
average per generation), $2.50/month gives each patron roughly 250+
generations while leaving you real margin under what you actually
collect — so occasional longer requests, retries, or price changes
don't put you underwater. Adjust `MONTHLY_BUDGET_CENTS` up or down once
you see real usage patterns; the first month or two, keep an eye on
`cents_used` in `db.sqlite` to sanity check actual spend against what
you're bringing in.

## Things worth doing before a real public launch

- **Rate limit `/generate` itself** (e.g. with `express-rate-limit`) so
  one runaway script or bug can't hammer the endpoint.
- **Log errors somewhere you'll see them** — right now they just go to
  console output, which is fine for local dev but you'll want proper
  logging once this is live.
- **Back up `db.sqlite`** periodically if you're on a host that doesn't
  persist disk across deploys (some free tiers wipe it) — or move to a
  managed Postgres instance if you outgrow SQLite.
