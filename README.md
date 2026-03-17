# Telegram Bot

Telegram bot that bridges user messages to an AI companion backend. Zero dependencies — pure Node.js with built-in `http`/`https` modules.

## Features

- **Chat Relay** — forwards Telegram messages to avatar-server, returns AI responses
- **Voice Messages** — transcribes voice via STT, sends to chat pipeline
- **User Whitelist** — only responds to authorized Telegram user ID
- **Sticker Support** — sends matching stickers after AI replies (configurable chance)
- **Admin Commands** — toggle STT, TTS, sleep, stickers, touch, emotion tags
- **Settings Management** — `/set` command to change sticker chance, idle tool chance, sleep hours
- **Notification API** — HTTP endpoint for other services to send messages through the bot
- **Log Buffer** — in-memory ring buffer of recent logs, accessible via API

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
| `AVATAR_SERVER_URL` | No | Backend URL (default: `http://localhost:8800`) |
| `CLOCKIN_SERVICE_URL` | No | Clock-in service URL (default: `http://localhost:8804`) |

## Commands

```
/ping          — test bot
/avatar        — server status
/settings      — current config
/set <k> <v>   — change setting (sticker_chance, idle_tool_chance, sleep_hour, wake_hour)
/stt on|off    — voice recognition
/tts on|off    — voice synthesis
/sleep on|off  — force sleep/wake
/idle <hours>  — idle talk interval
/sticker on|off — toggle stickers
/emotion on|off — emotion tags in replies
/touch on|off  — touch interaction on avatar
/memory stats|clear — memory management
/clockin on|off|status — clock-in automation
/help          — command list + keyword triggers
```

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/telegram` | Send a message through the bot (`{"text": "..."}`) |
| `GET` | `/status` | Health check + uptime + last message |
| `GET` | `/logs` | Recent log entries (supports `?since=timestamp`) |

## License

MIT
