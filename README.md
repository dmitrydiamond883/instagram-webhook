# instagram-webhook

Bridge between Instagram Direct and [OpenClaw](https://github.com/openclaw/openclaw) AI agent.

Receives Instagram Direct messages via Meta Webhooks, passes them to an OpenClaw agent, and sends the reply back to the client. Notifies the admin via Telegram.

## Features

- 🤖 Connects Instagram Direct to any OpenClaw-compatible AI agent
- 💬 **Persistent conversation history** — remembers context per client (30 messages, 30 days)
- 📅 Auto-checks date availability before passing message to AI (calendar pre-check)
- 🔕 Pause/resume bot without restart (via `/tmp/instagram_bot_paused` flag file)
- 🚫 Block/restrict users via `user_rules.json`
- 📲 Admin notifications via Telegram Bot API
- ⚡ Message debouncing (3s) — combines rapid messages into one request

## How it works

```
Instagram DM → Meta Webhook → instagram-webhook → OpenClaw Agent → reply back to client
                                                              └→ Telegram notification to admin
```

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your values
```

### 3. Configure Meta Webhook

In [Meta Developer Console](https://developers.facebook.com/):
- Create an app with Instagram messaging permissions
- Set webhook URL: `https://yourdomain.com/instagram`
- Subscribe to `messages` field
- Set `META_VERIFY_TOKEN` to match your `.env`

### 4. Run

```bash
node index.js
```

Or with systemd — see `instagram-webhook.service.example`.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `META_VERIFY_TOKEN` | Token for webhook verification |
| `META_APP_SECRET` | App secret for signature validation |
| `META_PAGE_ACCESS_TOKEN` | Instagram page access token |
| `OPENCLAW_COMPLETIONS_URL` | OpenClaw completions endpoint (default: `http://127.0.0.1:18789/v1/chat/completions`) |
| `OPENCLAW_TOKEN` | OpenClaw API token |
| `OPENCLAW_AGENT_ID` | Agent ID to use (default: `my-agent`) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token for admin notifications |
| `TELEGRAM_ADMIN_ID` | Telegram chat ID to notify |

## User Rules

Edit `user_rules.json` to block or restrict users:

```json
{
  "blocked": [
    "instagram_user_id"
  ],
  "restricted": {
    "instagram_user_id": ["no_calendar"]
  }
}
```

**Restrictions:**
- `no_calendar` — bot won't share calendar links or prices with this user

## Conversation History

History is stored in `history/` directory (one JSON file per user).
- Max 30 messages per conversation
- Expires after 30 days of inactivity
- Cleaned up automatically every 6 hours

## Calendar Pre-check

If a message contains a date (e.g. "15 августа", "15.08"), the bridge pre-checks availability via a `calendar_checker.py` script and injects the result into the agent's context.

Configure the path in `index.js`:
```js
const CALENDAR_CHECKER = "/path/to/calendar_checker.py";
```

## License

MIT
