# Telegram Bot

Telegram bot that bridges user messages to an AI companion backend. Zero dependencies — pure Node.js with built-in `http`/`https` modules.

## Features

- **Chat Relay** — forwards Telegram messages to avatar-server, returns AI responses
- **User Whitelist** — only responds to authorized Telegram user ID
- **Notification API** — HTTP endpoint for other services to send messages through the bot
- **Log Buffer** — in-memory ring buffer of recent logs, accessible via API
- **Keyword Help** — `/help` shows available chat triggers (tasks, money, weather, etc.)

## Setup

```bash
# Set environment variables
export BOT_TOKEN=your-telegram-bot-token
export ALLOWED_ID=your-telegram-user-id
export AVATAR_SERVER_URL=http://your-server:8800

# Run
node index.js
```

## Docker

```bash
docker build -t telegram-bot .
docker run -e BOT_TOKEN=xxx -e ALLOWED_ID=xxx -e AVATAR_SERVER_URL=http://your-server:8800 -p 3001:3001 telegram-bot
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_TOKEN` | Yes | Telegram bot token from @BotFather |
| `ALLOWED_ID` | Yes | Your Telegram user ID (number) |
| `AVATAR_SERVER_URL` | No | Backend URL (default: `http://100.83.33.113:8800`) |

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/send` | Send a message through the bot (`{"text": "..."}`) |
| `GET` | `/health` | Health check |
| `GET` | `/logs` | Recent log entries |

## License

MIT
