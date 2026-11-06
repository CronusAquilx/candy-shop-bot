# 🍬 Candy Shop Bot (Serverless)

Same architecture as the HelpBet bot.

## How it works

```
Discord → Vercel serverless API → Supabase
```

- Slash commands & buttons hit `/api/discord-interactions`
- Monday cron at 11:00 UTC runs the pay check
- Code on GitHub → auto deploys to Vercel

## Env vars needed on Vercel

```
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_PUBLIC_KEY=          # from Discord Developer Portal → General Information
SUPABASE_URL=https://vrfrgbtnsurgrvcuvbat.supabase.co
SUPABASE_SERVICE_KEY=
CRON_SECRET=                 # any random string
```

## Setup steps

1. Create Discord application + bot
2. In Discord Developer Portal → General Information → copy **Public Key**
3. Under **Interactions Endpoint URL** set:
   `https://your-project.vercel.app/api/discord-interactions`
4. Import this repo in Vercel and add the env vars above
5. Run `npm run register` once (with local .env) to register the slash commands
6. In Discord: `/setup admin-roles` then `/setup admin-panel`

## Commands

- `/setup admin-panel`
- `/setup logs-channel`
- `/setup admin-roles`
- `/items add|list|remove`
