
'use strict';

const https = require('https');
const http  = require('http');

const TOKEN      = process.env.BOT_TOKEN;
const ALLOWED_ID = Number(process.env.ALLOWED_ID);

const AVATAR_SERVER_URL = process.env.AVATAR_SERVER_URL || 'http://100.83.33.113:8800';
const AVATAR_TIMEOUT = 120000; // 120s (LLM + TTS + margin)

const API_PORT = 3001;

const MAX_LOGS = 200;
const logBuffer = [];
const startTime = Date.now();
let messageCount = 0;
let lastMessageTime = null;
let lastMessageFrom = null;
let lastMessageText = null;

const origLog  = console.log.bind(console);
const origErr  = console.error.bind(console);
const origWarn = console.warn.bind(console);

function pushLog(level, args) {
  const entry = {
    ts: Date.now(),
    level,
    msg: args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '),
  };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
}

console.log   = (...args) => { pushLog('info', args);  origLog(...args); };
console.error = (...args) => { pushLog('error', args); origErr(...args); };
console.warn  = (...args) => { pushLog('warn', args);  origWarn(...args); };

let offset = 0;

function apiRequest(method, params = {}) {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams(
      Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
    ).toString();

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/${method}${query ? '?' + query : ''}`,
      method: 'GET',
      timeout: 35000,
    };

    const req = https.get(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse failed: ' + data.slice(0, 100))); }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
  });
}

function apiPost(method, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/${method}`,
      method: 'POST',
      timeout: 35000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.ok) reject(new Error(json.description || 'Telegram API error'));
          else resolve(json);
        } catch (e) { reject(new Error('JSON parse failed: ' + data.slice(0, 100))); }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sendMessage(chatId, text) {
  return apiPost('sendMessage', { chat_id: chatId, text }).catch(e =>
    console.error('[sendMessage error]', e.message)
  );
}

function avatarChat(message, userName) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      message,
      context: 'telegram',
      user_name: userName,
    });

    const url = new URL(AVATAR_SERVER_URL + '/chat');

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      timeout: AVATAR_TIMEOUT,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    let settled = false;

    const hardTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        req.destroy();
        reject(new Error('Avatar server hard timeout'));
      }
    }, AVATAR_TIMEOUT + 5000);

    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(new Error('Avatar server returned invalid JSON'));
        }
      });
    });

    req.on('timeout', () => {
      if (!settled) { settled = true; clearTimeout(hardTimer); req.destroy(); reject(new Error('Avatar server timeout')); }
    });
    req.on('error', e => {
      if (!settled) { settled = true; clearTimeout(hardTimer); reject(e); }
    });
    req.write(payload);
    req.end();
  });
}

function avatarStatus() {
  return new Promise((resolve, reject) => {
    const url = new URL(AVATAR_SERVER_URL + '/status');

    const req = http.get({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      timeout: 5000,
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON')); }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', e => reject(e));
  });
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text   = (msg.text || '').trim();

  if (!text) return;

  messageCount++;
  lastMessageTime = Date.now();
  lastMessageFrom = msg.from.first_name || msg.from.username || String(msg.from.id);
  lastMessageText = text.slice(0, 100);

  console.log(`[msg] from=${msg.from.id} text="${text}"`);

  if (msg.from.id !== ALLOWED_ID) {
    console.warn('[auth] blocked user:', msg.from.id);
    await sendMessage(chatId, 'Unauthorized.');
    return;
  }

  if (text === '/start' || text === '/help') {
    await sendMessage(chatId,
      'Suisei Bot\n\n' +
      'Commands:\n' +
      '  /ping — test bot is alive\n' +
      '  /ask <question> — ask the AI avatar\n' +
      '  /avatar — check avatar server status\n' +
      '  /help — show this message\n\n' +
      'Just type normally to chat with Suisei AI!\n\n' +
      'Keyword Triggers (say naturally):\n' +
      '  Expenses: "spent 20000 on food", "bought coffee 5000"\n' +
      '  Income: "got paid 5000000", "got paycheck 500k"\n' +
      '  Balance: "check my balance", "how much do I have"\n' +
      '  Tasks: "remind me to buy groceries"\n' +
      '  Tasks+Time: "remind me to X at 18:00"\n' +
      '  Recurring: "water plants daily at 08:00"\n' +
      '  Complete: "done with laundry"\n' +
      '  Task list: "what\'s on my list"\n' +
      '  Weather: "how\'s the weather"\n' +
      '  Calendar: "what\'s on my schedule"\n' +
      '  Costume: "change to casual outfit"\n' +
      '  Sleep: "go to sleep", "oyasumi"\n' +
      '  Memory: "note this: ..." or "remember ..."\n'
    );
    return;
  }

  if (text === '/ping') {
    await sendMessage(chatId, 'Pong! Bot is running on Ubuntu server.');
    return;
  }

  if (text.startsWith('/ask ')) {
    const question = text.slice(5).trim();
    if (!question) {
      await sendMessage(chatId, 'Usage: /ask <your question>');
      return;
    }

    await sendMessage(chatId, '...');

    try {
      const result = await avatarChat(question, msg.from.first_name || 'User');
      const emotionTag = result.emotion ? `[${result.emotion}] ` : '';
      await sendMessage(chatId, emotionTag + result.reply);
      console.log(`[avatar] replied: [${result.emotion}] ${result.reply.slice(0, 80)}`);
    } catch (e) {
      console.warn(`[avatar] AI server unreachable: ${e.message}`);
      await sendMessage(chatId, 'AI server is offline. Try again later.\n\nCore commands still work: /ping');
    }
    return;
  }

  if (text === '/avatar') {
    try {
      const status = await avatarStatus();
      const lines = [
        'Avatar AI Server',
        '',
        `Server: ${status.server}`,
        `LM Studio: ${status.lm_studio}`,
        `TTS: ${status.tts}`,
        `RVC: ${status.rvc}`,
        `STT: ${status.stt}`,
        `WebSocket clients: ${status.websocket_clients}`,
        `Uptime: ${Math.floor(status.uptime_seconds / 60)}m ${status.uptime_seconds % 60}s`,
      ];
      await sendMessage(chatId, lines.join('\n'));
    } catch (e) {
      await sendMessage(chatId, 'Avatar AI server is offline.');
    }
    return;
  }

  if (!text.startsWith('/')) {
    await sendMessage(chatId, '...');
    try {
      const result = await avatarChat(text, msg.from.first_name || 'User');
      const emotionTag = result.emotion ? `[${result.emotion}] ` : '';
      await sendMessage(chatId, emotionTag + result.reply);
      console.log(`[avatar] replied: [${result.emotion}] ${result.reply.slice(0, 80)}`);
    } catch (e) {
      console.warn(`[avatar] AI server unreachable: ${e.message}`);
      await sendMessage(chatId, 'AI server is offline. Try again later.\n\nCore commands still work: /ping');
    }
    return;
  }

  await sendMessage(chatId, `Unknown command: ${text}\nSend /help for usage.`);
}

let _firstPoll = true;

async function poll() {
  try {
    const res = await apiRequest('getUpdates', {
      offset,
      timeout: 30,
      allowed_updates: 'message',
    });

    if (!res.ok) {
      console.error('[poll] Telegram error:', res.description);
    } else {
      if (_firstPoll && res.result.length > 0) {
        const skipped = res.result.length;
        offset = res.result[res.result.length - 1].update_id + 1;
        console.log(`[poll] Skipped ${skipped} stale message(s) from before restart`);
        _firstPoll = false;
      } else {
        _firstPoll = false;
        for (const update of res.result) {
          offset = update.update_id + 1;
          if (update.message) {
            await handleMessage(update.message).catch(e =>
              console.error('[handleMessage error]', e.message)
            );
          }
        }
      }
    }
  } catch (e) {
    console.error('[poll error]', e.message);
    await new Promise(r => setTimeout(r, 5000));
  }

  setImmediate(poll);
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const apiServer = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${API_PORT}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/status') {
    const uptimeMs = Date.now() - startTime;
    const payload = {
      ok: true,
      status: 'running',
      uptime: formatUptime(uptimeMs),
      uptimeMs,
      messageCount,
      lastMessage: lastMessageTime ? {
        time: lastMessageTime,
        from: lastMessageFrom,
        text: lastMessageText,
      } : null,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }

  if (req.method === 'GET' && path === '/logs') {
    const since = url.searchParams.get('since');
    let entries = logBuffer;
    if (since) {
      const sinceTs = Number(since);
      entries = logBuffer.filter(e => e.ts > sinceTs);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, logs: entries }));
    return;
  }

  if (req.method === 'POST' && path === '/telegram') {
    try {
      const body = JSON.parse(await readBody(req));
      const text = String(body.text || '').slice(0, 4000);
      if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'text is required' }));
        return;
      }
      const result = await sendMessage(ALLOWED_ID, text);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Not found' }));
});

function validateConfig() {
  const errors = [];
  if (!TOKEN)                        errors.push('BOT_TOKEN env var is not set');
  if (!ALLOWED_ID || isNaN(ALLOWED_ID)) errors.push('ALLOWED_ID env var is not set');
  if (errors.length) {
    console.error('Config errors:\n' + errors.map(e => '  - ' + e).join('\n'));
    process.exit(1);
  }
}

validateConfig();

console.log('═══════════════════════════════════════');
console.log(' Suisei Bot — starting');
console.log(' Avatar  :', AVATAR_SERVER_URL);
console.log(' API     : http://0.0.0.0:' + API_PORT);
console.log('═══════════════════════════════════════');

apiServer.listen(API_PORT, '0.0.0.0', () => {
  console.log(`[api] HTTP API listening on port ${API_PORT}`);
});

poll();
