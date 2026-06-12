
'use strict';

const https = require('https');
const http  = require('http');

const TOKEN      = process.env.BOT_TOKEN;
const ALLOWED_ID = Number(process.env.ALLOWED_ID);

const AVATAR_SERVER_URL = process.env.AVATAR_SERVER_URL || 'http://localhost:8800';
const CLOCKIN_SERVICE_URL = process.env.CLOCKIN_SERVICE_URL || 'http://localhost:8804';
const MEME_SERVICE_URL = process.env.MEME_SERVICE_URL || 'http://localhost:8807';
const AVATAR_TIMEOUT = 360000; // 360s (code mode uses Opus, can take ~5min)

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
      family: 4, // Force IPv4
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
      timeout: 60000,
      family: 4, // Force IPv4 — IPv6 is broken on this network, causes AggregateError
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

async function apiPostRetry(method, body, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await apiPost(method, body);
    } catch (e) {
      if (i < retries) {
        const delay = (i + 1) * 2000; // 2s, 4s
        console.warn(`[apiPost] ${method} failed (attempt ${i+1}/${retries+1}): ${e.message || e}, retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw e;
      }
    }
  }
}

function sendMessage(chatId, text) {
  return apiPostRetry('sendMessage', { chat_id: chatId, text }).catch(e =>
    console.error(`[sendMessage error] ${e.message || e} | text=${(text||'').slice(0,80)}`)
  );
}

function sendTyping(chatId) {
  return apiPost('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
}

function sendMessageWithKeyboard(chatId, text, inlineKeyboard) {
  const body = { chat_id: chatId, text };
  if (inlineKeyboard && inlineKeyboard.length > 0) {
    body.reply_markup = JSON.stringify({ inline_keyboard: inlineKeyboard });
  }
  return apiPost('sendMessage', body).catch(e =>
    console.error('[sendMessageWithKeyboard error]', e.message)
  );
}

function editMessageText(chatId, messageId, text, inlineKeyboard) {
  const body = { chat_id: chatId, message_id: messageId, text };
  if (inlineKeyboard && inlineKeyboard.length > 0) {
    body.reply_markup = JSON.stringify({ inline_keyboard: inlineKeyboard });
  } else {
    body.reply_markup = JSON.stringify({ inline_keyboard: [] });
  }
  return apiPost('editMessageText', body).catch(e =>
    console.error('[editMessageText error]', e.message)
  );
}

function answerCallbackQuery(callbackQueryId, text) {
  return apiPost('answerCallbackQuery', { callback_query_id: callbackQueryId, text }).catch(e =>
    console.error('[answerCallbackQuery error]', e.message)
  );
}

function sendSticker(chatId, fileId) {
  return apiPostRetry('sendSticker', { chat_id: chatId, sticker: fileId }).catch(e =>
    console.error(`[sendSticker error] ${e.message || e}`)
  );
}

function pinChatMessage(chatId, messageId) {
  return apiPost('pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: true }).catch(e =>
    console.error('[pinChatMessage error]', e.message)
  );
}

function avatarChat(message, userName, image_base64 = null, reply_to = null) {
  return new Promise((resolve, reject) => {
    const body = {
      message,
      context: 'telegram',
      user_name: userName,
    };
    if (image_base64) {
      body.image_base64 = image_base64;
    }
    if (reply_to) {
      body.reply_to = reply_to;
    }
    const payload = JSON.stringify(body);

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

function downloadTelegramFile(fileId) {
  return new Promise(async (resolve, reject) => {
    try {
      // Step 1: Get file path from Telegram
      const fileInfo = await apiRequest('getFile', { file_id: fileId });
      if (!fileInfo.ok || !fileInfo.result.file_path) {
        return reject(new Error('Failed to get file path from Telegram'));
      }

      const filePath = fileInfo.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;

      // Step 2: Download the file
      https.get(fileUrl, { timeout: 30000 }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
}

function avatarTranscribe(audioBuffer, contentType) {
  return new Promise((resolve, reject) => {
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="voice.ogg"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, audioBuffer, footer]);

    const url = new URL(AVATAR_SERVER_URL + '/transcribe');
    console.log(`[stt] POST ${url.href} (${body.length} bytes, boundary=${boundary})`);

    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      timeout: 30000,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`[stt] Response ${res.statusCode}: ${data.slice(0, 200)}`);
        try {
          const json = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject(new Error(json.detail || `STT error ${res.statusCode}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`STT returned invalid JSON: ${data.slice(0, 100)}`));
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('STT timeout')); });
    req.on('error', e => { console.error(`[stt] Request error: ${e.message}`); reject(e); });
    req.write(body);
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

function adminGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(AVATAR_SERVER_URL + path);
    const req = http.get({
      hostname: url.hostname, port: url.port, path: url.pathname, timeout: 5000,
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function adminPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(AVATAR_SERVER_URL + path);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: 'POST', timeout: 5000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// --- Clock-in service helpers ---
function clockinGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(CLOCKIN_SERVICE_URL + path);
    const req = http.get({
      hostname: url.hostname, port: url.port, path: url.pathname, timeout: 5000,
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function clockinPost(pathWithQuery) {
  return new Promise((resolve, reject) => {
    const url = new URL(CLOCKIN_SERVICE_URL + pathWithQuery);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      method: 'POST', timeout: 30000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': 0 },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// --- Meme service helpers ---
function memeGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(MEME_SERVICE_URL + path);
    const req = http.get({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search, timeout: 5000,
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function memePost(pathWithQuery) {
  return new Promise((resolve, reject) => {
    const url = new URL(MEME_SERVICE_URL + pathWithQuery);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      method: 'POST', timeout: 5000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': 0 },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// --- Emoji toggle for emotion tags in replies ---
let showEmotionTags = true;

// --- Sticker toggle ---
let stickersEnabled = true;

async function handleVoiceMessage(msg) {
  const chatId = msg.chat.id;
  const voice = msg.voice || msg.audio;
  const userName = 'Venomaru';

  console.log(`[voice] from=${msg.from.id} duration=${voice.duration}s size=${voice.file_size}`);

  if (voice.duration > 60) {
    await sendMessage(chatId, 'Voice message too long (max 60s).');
    return;
  }

  await sendTyping(chatId);

  try {
    // Download voice file from Telegram
    const audioBuffer = await downloadTelegramFile(voice.file_id);
    console.log(`[voice] Downloaded ${audioBuffer.length} bytes`);

    // Transcribe via avatar-server STT
    const sttResult = await avatarTranscribe(audioBuffer, voice.mime_type || 'audio/ogg');
    const transcribed = sttResult.text;
    console.log(`[voice] Transcribed (${sttResult.language}): "${transcribed}"`);

    if (!transcribed) {
      await sendMessage(chatId, "Couldn't hear what you said. Try again?");
      return;
    }

    // Send to chat pipeline
    const result = await avatarChat(transcribed, 'Venomaru');
    const emotionTag = (showEmotionTags && result.emotion) ? `[${result.emotion}] ` : '';
    await sendMessage(chatId, emotionTag + result.reply);
    if (stickersEnabled && result.sticker_id && Math.random() < 0.75) {
      await sendSticker(chatId, result.sticker_id);
    }
    console.log(`[avatar] replied: [${result.emotion}] ${result.reply.slice(0, 80)}`);
  } catch (e) {
    console.error(`[voice] Error: ${e.message || e}`);
    console.error(`[voice] Stack: ${e.stack || 'no stack'}`);
    if (e.message && (e.message.includes('STT') || e.message.includes('503'))) {
      await sendMessage(chatId, 'Voice recognition is offline. Send text instead.');
    } else {
      await sendMessage(chatId, 'Failed to process voice message. Try again.');
    }
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;

  // Handle voice messages
  if (msg.voice || msg.audio) {
    if (msg.from.id !== ALLOWED_ID) {
      await sendMessage(chatId, 'Unauthorized.');
      return;
    }
    messageCount++;
    lastMessageTime = Date.now();
    lastMessageFrom = msg.from.first_name || msg.from.username || String(msg.from.id);
    lastMessageText = '(voice message)';
    return handleVoiceMessage(msg);
  }

  // Handle photo messages — download, base64, send to avatar-server with caption
  if (msg.photo) {
    if (msg.from.id !== ALLOWED_ID) {
      await sendMessage(chatId, 'Unauthorized.');
      return;
    }
    messageCount++;
    lastMessageTime = Date.now();
    lastMessageFrom = msg.from.first_name || msg.from.username || String(msg.from.id);
    lastMessageText = msg.caption ? msg.caption.slice(0, 100) : '(photo)';

    await sendTyping(chatId);

    try {
      // Pick largest photo size (last in array)
      const photoSize = msg.photo[msg.photo.length - 1];
      const photoBuffer = await downloadTelegramFile(photoSize.file_id);
      console.log(`[photo] Downloaded ${photoBuffer.length} bytes`);

      const base64 = photoBuffer.toString('base64');
      const caption = msg.caption || '[User sent an image]';

      const result = await avatarChat(caption, 'Venomaru', base64);
      const emotionTag = (showEmotionTags && result.emotion) ? `[${result.emotion}] ` : '';
      await sendMessage(chatId, emotionTag + result.reply);
      if (stickersEnabled && result.sticker_id && Math.random() < 0.75) {
        await sendSticker(chatId, result.sticker_id);
      }
      console.log(`[avatar] replied: [${result.emotion}] ${result.reply.slice(0, 80)}`);
    } catch (e) {
      console.error(`[photo] Error: ${e.message || e}`);
      await sendMessage(chatId, 'Failed to process image. Try again.');
    }
    return;
  }

  // Handle sticker messages — lightweight: emoji → emotion → send sticker back (no LLM/TTS)
  if (msg.sticker) {
    if (msg.from.id !== ALLOWED_ID) return;
    if (!stickersEnabled) return;
    messageCount++;
    lastMessageTime = Date.now();
    lastMessageFrom = msg.from.first_name || msg.from.username || String(msg.from.id);
    lastMessageText = '(sticker)';
    const emoji = msg.sticker.emoji || '';
    const emojiToEmotion = {
      '😀': 'HAPPY', '😁': 'HAPPY', '😂': 'HAPPY', '🤣': 'HAPPY', '😊': 'HAPPY',
      '😄': 'HAPPY', '😆': 'HAPPY', '🥰': 'HAPPY', '😍': 'HAPPY', '🎉': 'HAPPY',
      '👍': 'HAPPY', '❤️': 'HAPPY', '💕': 'HAPPY', '✨': 'HAPPY', '🌟': 'HAPPY',
      '😢': 'SAD', '😭': 'SAD', '🥺': 'SAD', '😞': 'SAD', '😔': 'SAD', '💔': 'SAD',
      '😠': 'ANGRY', '😡': 'ANGRY', '🤬': 'ANGRY', '💢': 'ANGRY', '👊': 'ANGRY',
      '😮': 'SURPRISED', '😱': 'SURPRISED', '🤯': 'SURPRISED', '😲': 'SURPRISED', '❗': 'SURPRISED',
      '🤔': 'THINKING', '🧐': 'THINKING', '💭': 'THINKING', '❓': 'THINKING',
    };
    const emotion = emojiToEmotion[emoji] || ['HAPPY', 'ANGRY', 'SURPRISED'][Math.floor(Math.random() * 3)];
    try {
      const stickers = await adminGet('/stickers');
      const matches = stickers.filter(s => s.emotion === emotion && s.file_id);
      if (matches.length > 0) {
        const pick = matches[Math.floor(Math.random() * matches.length)];
        await sendSticker(chatId, pick.file_id);
        console.log(`[sticker] ${emoji} → ${emotion} → sent sticker back`);
      }
    } catch (e) {
      console.warn(`[sticker] Failed to fetch stickers: ${e.message}`);
    }
    return;
  }

  let text = (msg.text || '').trim();

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

  if (text === '/play' || text === '/play pvp' || text === '/play wild') {
    const mode = text.includes('pvp') ? 'pvp' : text.includes('wild') ? 'wild' : '';
    const url = mode
      ? `https://game.venomaru.dev/static/index.html?v=3?mode=${mode}`
      : 'https://game.venomaru.dev/static/index.html?v=3';
    await sendMessageWithKeyboard(chatId, 'Astral Idols', [
      [{ text: '🎮 Play', web_app: { url } }]
    ]);
    return;
  }

  if (text === '/start' || text === '/help') {
    await sendMessageWithKeyboard(chatId, HELP_HOME_TEXT, helpHomeKeyboard());
    return;
  }

  if (text === '/guide') {
    const pages = await buildGuidePages();
    await sendMessageWithKeyboard(chatId, pages[0], guideKeyboard(0, pages.length));
    return;
  }

  if (text === '/ping') {
    await sendMessage(chatId, 'Pong! Bot is running on Ubuntu server.');
    return;
  }

  // --- Admin commands ---

  if (text === '/settings') {
    try {
      const cfg = await adminGet('/admin/config');
      const s = cfg.sleep || {};
      const m = cfg.memory || {};
      let clockinStatus = 'unreachable';
      try {
        const ci = await clockinGet('/status');
        clockinStatus = ci.enabled ? 'on' : 'off';
      } catch (e) { /* service down */ }
      const stickerPct = Math.round((cfg.sticker_chance || 0) * 100);
      const lines = [
        'Current Settings',
        '',
        `STT: ${cfg.stt_enabled ? 'on' : 'off'}`,
        `TTS: ${cfg.tts_enabled ? 'on' : 'off'} (${cfg.tts_engine || '?'})`,
        `Voice: ${cfg.tts_language === 'jp' ? 'Japanese' : 'English'}`,
        `Idle talk: ${cfg.idle_talk_hours}h`,
        `Sticker chance: ${stickerPct}%`,
        `Stickers: ${stickersEnabled ? 'on' : 'off'}`,
        `Emotion tags: ${showEmotionTags ? 'on' : 'off'}`,
        `Touch: ${cfg.touch_enabled ? 'on' : 'off'}`,
        `Sleep: ${s.is_sleeping ? 'sleeping' : 'awake'} (${s.sleep_schedule})`,
        `Memory: ${m.total_messages} msgs, ${m.core_memories} core`,
        `Clock-in auto: ${clockinStatus}`,
        `Tool calls: ${cfg.tool_call_mode || 'normal'}`,
      ];
      await sendMessage(chatId, lines.join('\n'));
    } catch (e) {
      await sendMessage(chatId, 'Failed to get settings: ' + e.message);
    }
    return;
  }

  if (text.startsWith('/stt')) {
    const val = text.split(' ')[1];
    if (val !== 'on' && val !== 'off') {
      await sendMessage(chatId, 'Usage: /stt on|off');
      return;
    }
    try {
      await adminPost('/admin/config', { stt_enabled: val === 'on' });
      await sendMessage(chatId, `STT ${val === 'on' ? 'enabled' : 'disabled'}.`);
    } catch (e) {
      await sendMessage(chatId, 'Failed: ' + e.message);
    }
    return;
  }

  if (text.startsWith('/toolcall')) {
    const val = text.split(' ')[1];
    const valid = ['normal', 'semi_normal', 'semi_off', 'off'];
    if (!valid.includes(val)) {
      await sendMessage(chatId,
        'Usage: /toolcall <mode>\n\n' +
        '  normal      — all tools (default)\n' +
        '  semi_normal — only main tools from user; idle unrestricted\n' +
        '  semi_off    — no tools from user; idle can still use them\n' +
        '  off         — no tools anywhere'
      );
      return;
    }
    try {
      await adminPost('/admin/config', { tool_call_mode: val });
      await sendMessage(chatId, `Tool call mode: ${val}.`);
    } catch (e) {
      await sendMessage(chatId, 'Failed: ' + e.message);
    }
    return;
  }

  if (text.startsWith('/tts')) {
    const val = text.split(' ')[1];
    if (val !== 'on' && val !== 'off') {
      await sendMessage(chatId, 'Usage: /tts on|off');
      return;
    }
    try {
      await adminPost('/admin/config', { tts_enabled: val === 'on' });
      await sendMessage(chatId, `TTS ${val === 'on' ? 'enabled' : 'disabled'}.`);
    } catch (e) {
      await sendMessage(chatId, 'Failed: ' + e.message);
    }
    return;
  }

  if (text.startsWith('/sleep')) {
    const val = text.split(' ')[1];
    if (val !== 'on' && val !== 'off') {
      await sendMessage(chatId, 'Usage: /sleep on|off');
      return;
    }
    try {
      await adminPost('/admin/config', { sleep_force: val });
      await sendMessage(chatId, val === 'on' ? 'Going to sleep.' : 'Woke up.');
    } catch (e) {
      await sendMessage(chatId, 'Failed: ' + e.message);
    }
    return;
  }

  if (text.startsWith('/idle')) {
    const val = parseFloat(text.split(' ')[1]);
    if (isNaN(val) || val < 0.1 || val > 24) {
      await sendMessage(chatId, 'Usage: /idle <hours> (0.1-24)');
      return;
    }
    try {
      await adminPost('/admin/config', { idle_talk_hours: val });
      await sendMessage(chatId, `Idle talk interval set to ${val}h.`);
    } catch (e) {
      await sendMessage(chatId, 'Failed: ' + e.message);
    }
    return;
  }

  if (text.startsWith('/language')) {
    const val = text.split(' ')[1];
    if (val === 'en' || val === 'jp') {
      try {
        await adminPost('/admin/config', { tts_language: val });
        await sendMessage(chatId, `Voice language: ${val === 'jp' ? 'Japanese 🇯🇵' : 'English 🇺🇸'}`);
      } catch (e) {
        await sendMessage(chatId, 'Failed: ' + e.message);
      }
      return;
    }
    try {
      const cfg = await adminGet('/admin/config');
      const lang = cfg.tts_language || 'en';
      await sendMessage(chatId, `Current: ${lang === 'jp' ? 'Japanese 🇯🇵' : 'English 🇺🇸'}\nUsage: /language en|jp`);
    } catch (e) {
      await sendMessage(chatId, 'Usage: /language en|jp');
    }
    return;
  }

  if (text.startsWith('/sticker')) {
    const val = text.split(' ')[1];
    if (val !== 'on' && val !== 'off') {
      await sendMessage(chatId, 'Usage: /sticker on|off');
      return;
    }
    stickersEnabled = val === 'on';
    await sendMessage(chatId, `Stickers ${val === 'on' ? 'enabled' : 'disabled'}.`);
    return;
  }

  if (text.startsWith('/touch')) {
    const val = text.split(' ')[1];
    if (val !== 'on' && val !== 'off') {
      await sendMessage(chatId, 'Usage: /touch on|off');
      return;
    }
    try {
      await adminPost('/admin/config', { touch_enabled: val === 'on' });
      await sendMessage(chatId, `Touch interaction ${val === 'on' ? 'enabled' : 'disabled'}.`);
    } catch (e) {
      await sendMessage(chatId, 'Failed: ' + e.message);
    }
    return;
  }

  if (text.startsWith('/set')) {
    const parts = text.split(/\s+/);
    const key = parts[1];
    const rawVal = parts[2];
    const validKeys = {
      sticker_chance: { min: 0, max: 1, desc: '0-1' },
      sleep_hour: { min: 0, max: 23, desc: '0-23' },
      wake_hour: { min: 0, max: 23, desc: '0-23' },
    };
    if (!key || !rawVal || !validKeys[key]) {
      const keys = Object.entries(validKeys).map(([k, v]) => `  ${k} (${v.desc})`).join('\n');
      await sendMessage(chatId, `Usage: /set <key> <value>\n\nValid keys:\n${keys}`);
      return;
    }
    const val = parseFloat(rawVal);
    const range = validKeys[key];
    if (isNaN(val) || val < range.min || val > range.max) {
      await sendMessage(chatId, `${key} must be ${range.desc}`);
      return;
    }
    try {
      await adminPost('/admin/config', { [key]: val });
      const display = (key === 'sticker_chance' || key === 'idle_tool_chance')
        ? `${Math.round(val * 100)}%` : String(val);
      await sendMessage(chatId, `${key} set to ${display}.`);
    } catch (e) {
      await sendMessage(chatId, 'Failed: ' + e.message);
    }
    return;
  }

  if (text.startsWith('/mood')) {
    const arg = text.split(' ')[1];
    if (!arg) {
      // Show current mood
      try {
        const status = await adminGet('/status');
        const m = status.mood || {};
        await sendMessage(chatId, `Mood: ${Math.round(m.value || 0)}/100 (${m.bracket || '?'})`);
      } catch (e) {
        await sendMessage(chatId, 'Failed: ' + e.message);
      }
      return;
    }
    const val = parseInt(arg);
    if (isNaN(val) || val < 0 || val > 100) {
      await sendMessage(chatId, 'Usage: /mood [0-100]\nNo args = show current mood');
      return;
    }
    try {
      const result = await avatarChat(`/mood ${val}`, 'Venomaru');
      await sendMessage(chatId, result.reply);
    } catch (e) {
      await sendMessage(chatId, 'Failed: ' + e.message);
    }
    return;
  }

  if (text.startsWith('/emotion')) {
    const val = text.split(' ')[1];
    if (val !== 'on' && val !== 'off') {
      await sendMessage(chatId, 'Usage: /emotion on|off');
      return;
    }
    showEmotionTags = val === 'on';
    await sendMessage(chatId, `Emotion tags ${val === 'on' ? 'shown' : 'hidden'} in replies.`);
    return;
  }

  if (text.startsWith('/memory')) {
    const sub = text.split(' ')[1];
    if (sub === 'stats') {
      try {
        const stats = await adminGet('/admin/memory/stats');
        const lines = [
          'Memory Stats',
          '',
          `Messages: ${stats.total_messages}`,
          `Core memories: ${stats.core_memories}`,
          `Session: ${stats.session}`,
        ];
        if (stats.core_memory_list && stats.core_memory_list.length > 0) {
          lines.push('', `Core memories (${stats.core_memories} total):`);
          for (const m of stats.core_memory_list) {
            lines.push(`  #${m.id} [${m.category}] ${m.content}`);
          }
        }
        await sendMessage(chatId, lines.join('\n'));
      } catch (e) {
        await sendMessage(chatId, 'Failed: ' + e.message);
      }
      return;
    }
    if (sub === 'clear') {
      try {
        const result = await adminPost('/admin/memory/clear', {});
        await sendMessage(chatId, `Cleared ${result.cleared} messages. Core memories kept.`);
      } catch (e) {
        await sendMessage(chatId, 'Failed: ' + e.message);
      }
      return;
    }
    if (sub === 'forget') {
      const arg = text.split(' ').slice(2).join(' ').trim();
      if (!arg) {
        await sendMessage(chatId, 'Usage: /memory forget <id or keyword>\nExamples:\n  /memory forget 5\n  /memory forget boyfriend');
        return;
      }
      try {
        // If arg is a number, delete by ID
        if (/^\d+$/.test(arg)) {
          const result = await adminPost('/admin/memory/delete', { id: parseInt(arg) });
          if (result.ok) {
            await sendMessage(chatId, `Deleted memory #${arg}.`);
          } else {
            await sendMessage(chatId, result.error || 'Memory not found.');
          }
        } else {
          // Search and delete by keyword
          const result = await adminPost('/admin/memory/search-delete', { query: arg });
          if (result.deleted_count === 0) {
            await sendMessage(chatId, `No memories found matching "${arg}".`);
          } else {
            const lines = [`Deleted ${result.deleted_count} memor${result.deleted_count === 1 ? 'y' : 'ies'}:`];
            for (const m of result.deleted) {
              lines.push(`  #${m.id}: ${m.content}`);
            }
            await sendMessage(chatId, lines.join('\n'));
          }
        }
      } catch (e) {
        await sendMessage(chatId, 'Failed: ' + e.message);
      }
      return;
    }
    await sendMessage(chatId, 'Usage: /memory stats|clear|forget <id or keyword>');
    return;
  }

  // Clock-in moved to plugin: /p.clockin, /p.clockin.status

  if (text.startsWith('/meme')) {
    const sub = text.split(' ')[1];
    if (sub === 'on' || sub === 'off') {
      try {
        await memePost(`/toggle?enabled=${sub === 'on'}`);
        await sendMessage(chatId, `Political memes ${sub === 'on' ? 'enabled' : 'disabled'}.`);
      } catch (e) {
        await sendMessage(chatId, 'Meme service unreachable: ' + e.message);
      }
      return;
    }
    if (!sub || sub === 'status') {
      try {
        const st = await memeGet('/status');
        await sendMessage(chatId, `Meme service: ${st.enabled ? 'ON' : 'OFF'}\nFigures: ${st.figures}\nTotal memes: ${st.total_memes}`);
      } catch (e) {
        await sendMessage(chatId, 'Meme service unreachable: ' + e.message);
      }
      return;
    }
    await sendMessage(chatId, 'Usage: /meme on|off|status');
    return;
  }

  // Underscore alias from the "/" suggestion popup (dots are illegal in
  // registered commands): /p_worldcup_bets → /p.worldcup.bets
  if (text.startsWith('/p_')) {
    const sp = text.indexOf(' ');
    const token = (sp === -1 ? text : text.slice(0, sp)).slice(3);
    const rest = sp === -1 ? '' : text.slice(sp);
    try {
      const pluginList = await adminGet('/plugin/list');
      let real = null;
      for (const p of pluginList.plugins) {
        for (const c of (p.commands || [])) {
          if (commandAlias(c.command) === 'p_' + token) { real = c.command; break; }
        }
        if (real) break;
      }
      if (real) text = '/p.' + real + rest;
    } catch (e) { /* falls through to the unknown-command reply */ }
  }

  // Dynamic plugin commands: /p.tasks, /p.balance, /p.calories.target 5000, etc.
  if (text.startsWith('/p.')) {
    const parts = text.slice(3).split(' ');
    const cmdParts = parts[0].split('.');  // e.g. ["tasks"] or ["balance", "budget"]
    const args = parts.slice(1).join(' ');

    // Find which plugin owns this command
    try {
      const pluginList = await adminGet('/plugin/list');
      let targetPlugin = null;
      let targetCommand = null;

      // Two-pass matching: exact match first, then prefix match
      for (const p of pluginList.plugins) {
        for (const cmd of (p.commands || [])) {
          if (cmd.command === parts[0]) {
            targetPlugin = p.name;
            targetCommand = cmd.command;
            break;
          }
        }
        if (targetPlugin) break;
      }
      // Fallback: match base command (e.g. /p.gym → command="gym")
      if (!targetPlugin) {
        for (const p of pluginList.plugins) {
          for (const cmd of (p.commands || [])) {
            if (cmd.command === cmdParts[0]) {
              targetPlugin = p.name;
              targetCommand = cmd.command;
              break;
            }
          }
          if (targetPlugin) break;
        }
      }

      if (!targetPlugin) {
        await sendMessage(chatId, `Unknown plugin command: /p.${parts[0]}`);
        return;
      }

      const result = await adminPost('/plugin/command', {
        plugin: targetPlugin,
        command: targetCommand,
        args: args,
      });

      if (result.ok && result.text) {
        if (result.inline_keyboard) {
          await sendMessageWithKeyboard(chatId, result.text, result.inline_keyboard);
        } else {
          await sendMessage(chatId, result.text);
        }
      } else {
        await sendMessage(chatId, result.text || 'Plugin command failed.');
      }
    } catch (e) {
      await sendMessage(chatId, 'Plugin system error: ' + e.message);
    }
    return;
  }

  if (text.startsWith('/ask ')) {
    const question = text.slice(5).trim();
    if (!question) {
      await sendMessage(chatId, 'Usage: /ask <your question>');
      return;
    }

    await sendTyping(chatId);

    try {
      const result = await avatarChat(question, 'Venomaru');
      const emotionTag = (showEmotionTags && result.emotion) ? `[${result.emotion}] ` : '';
      await sendMessage(chatId, emotionTag + result.reply);
      if (stickersEnabled && result.sticker_id && Math.random() < 0.75) {
        await sendSticker(chatId, result.sticker_id);
      }
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
    await sendTyping(chatId);
    try {
      // Capture reply-to context if user is replying to a message
      let replyTo = null;
      if (msg.reply_to_message?.text) {
        const from = msg.reply_to_message.from?.first_name || 'Someone';
        replyTo = `${from}: ${msg.reply_to_message.text}`;
      }
      const result = await avatarChat(text, 'Venomaru', null, replyTo);
      const emotionTag = (showEmotionTags && result.emotion) ? `[${result.emotion}] ` : '';
      // Attach Mini App button if a game battle tool was triggered
      const gameTools = { challenge_suisei: 'pvp', start_battle: 'wild' };
      const gameMode = gameTools[result.tool_executed];
      if (gameMode) {
        const gameUrl = 'https://game.venomaru.dev/static/index.html?v=3';
        console.log(`[game] Sending Play button: tool=${result.tool_executed}`);
        // Only send Suisei's chat line, strip the battle data (Mini App handles it)
        const replyLines = result.reply.split('\n');
        const chatLine = replyLines[0] || result.reply;
        await sendMessageWithKeyboard(chatId, emotionTag + chatLine, [
          [{ text: '🎮 Play', web_app: { url: gameUrl } }]
        ]);
      } else {
        await sendMessage(chatId, emotionTag + result.reply);
      }
      if (stickersEnabled && result.sticker_id && Math.random() < 0.75) {
        await sendSticker(chatId, result.sticker_id);
      }
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
let _pollBackoff = 0;
const _POLL_BACKOFF_MAX = 60000; // max 60s between retries

// ---- /help paginated menu ----
const HELP_HOME_TEXT = 'Companion Bot — pick a category:';

function helpHomeKeyboard() {
  return [
    [{ text: '⚙ System', callback_data: 'help:system' }, { text: '🔘 Toggles', callback_data: 'help:toggles' }],
    [{ text: '🧩 Plugins', callback_data: 'help:plugins' }, { text: '✨ Features', callback_data: 'help:features' }],
    [{ text: '🎮 Games', callback_data: 'help:games' }, { text: '📖 Guide', callback_data: 'help:guide' }],
  ];
}
const HELP_BACK = [[{ text: '‹ Back', callback_data: 'help:home' }]];

const HELP_SYSTEM_TEXT =
  '⚙ System\n\n' +
  '/ping — test the bot\n' +
  '/avatar — server status\n' +
  '/settings — current config\n' +
  '/set <key> <value> — change a setting\n' +
  '/memory stats|clear|forget — memory ops\n' +
  '/idle <hours> — idle-talk interval\n' +
  '/mood <0-100> — view or set mood\n' +
  '/toolcall <normal|semi_normal|semi_off|off> — tool sensitivity\n' +
  '/ask <question> — ask her directly\n' +
  '/language en|jp — TTS voice language';

const HELP_TOGGLES_TEXT =
  '🔘 Toggles  (each takes on|off)\n\n' +
  '/stt — speech-to-text\n' +
  '/tts — text-to-speech\n' +
  '/sleep — force sleep\n' +
  '/sticker — sticker replies\n' +
  '/emotion — emotion tags\n' +
  '/touch — touch interaction\n' +
  '/meme — meme service';

const HELP_FEATURES_TEXT =
  '✨ Features — just talk naturally, no command needed\n\n' +
  '• Costume — "change into your maid costume"\n' +
  '• Memory — "remember that I like coffee"\n' +
  '• Gacha — "open gacha"\n' +
  '• Roulette — "spin the roulette"\n' +
  '• THR — "give me THR"\n' +
  '• Web search — "search for X" (smart mode)';

const HELP_GAMES_TEXT =
  '🎮 Games\n\n' +
  '/play — Astral Idols (Mini App)\n' +
  '/play pvp — PvP mode\n' +
  '/play wild — Wild encounter mode';

// Returns an array of page strings (each < Telegram's 4096 limit), split on
// plugin boundaries. The full plugin list overflows one message, so /help
// paginates it with Prev/Next buttons.
const HELP_PLUGINS_HEADER = '🧩 Plugins — start a message with her nickname (e.g. "suichan, ...").\n\n';
async function buildPluginsPages() {
  let plugins;
  try {
    const data = await adminGet('/plugin/list');
    plugins = (data && data.plugins) || [];
  } catch (e) {
    return ['🧩 Plugins\n(server unreachable)'];
  }
  const blocks = [];
  for (const p of plugins) {
    const cmds = p.commands || [];
    if (!cmds.length) continue;
    let b = `${p.name} — ${p.description || ''}\n`;
    for (const c of cmds) b += `  /p.${c.command} — ${c.description}\n`;
    blocks.push(b);
  }
  if (!blocks.length) return ['🧩 Plugins\n(no plugin commands)'];

  const CAP = 3500; // soft cap so header + page body stay well under 4096
  const pages = [];
  let cur = '';
  for (const b of blocks) {
    if (cur && (HELP_PLUGINS_HEADER.length + cur.length + b.length) > CAP) {
      pages.push(cur);
      cur = '';
    }
    cur += b + '\n';
  }
  if (cur) pages.push(cur);
  return pages.map((body, i) =>
    HELP_PLUGINS_HEADER + body.trimEnd() +
    (pages.length > 1 ? `\n\nPage ${i + 1}/${pages.length}` : ''));
}

// ---- /guide paginated menu (same pattern as /help plugins pages) ----
const GUIDE_HEADER = '📖 Guide — say it like this:\n\n';
async function buildGuidePages() {
  let nick = 'nickname', sections = [];
  try {
    const status = await adminGet('/status');
    nick = (status.character_nicknames && status.character_nicknames[0]) || 'nickname';
    const guideData = await adminGet('/plugin/guide');
    sections = guideData.sections || [];
  } catch (e) {
    return ['📖 Guide\n(server unreachable)'];
  }

  const blocks = [];
  for (const s of sections) {
    let b = `${s.name}\n`;
    for (const ex of (s.examples || []).slice(0, 3)) b += `  "${nick}, ${ex}"\n`;
    blocks.push(b);
  }
  // Features (no nickname) — keep in sync with HELP_FEATURES_TEXT.
  blocks.push(
    'Features (no nickname needed)\n' +
    '  "change into your maid costume" → costume\n' +
    '  "remember that I like coffee" → memory\n' +
    '  "open gacha" / "spin the roulette" → games\n' +
    '  "give me THR" → THR envelopes\n' +
    '  "search for X" → web search (smart mode)\n'
  );

  const CAP = 3500;
  const pages = [];
  let cur = '';
  for (const b of blocks) {
    if (cur && (GUIDE_HEADER.length + cur.length + b.length) > CAP) {
      pages.push(cur);
      cur = '';
    }
    cur += b + '\n';
  }
  if (cur) pages.push(cur);
  return pages.map((body, i) =>
    GUIDE_HEADER + body.trimEnd() +
    (pages.length > 1 ? `\n\nPage ${i + 1}/${pages.length}` : ''));
}

function guideKeyboard(i, total) {
  const nav = [];
  if (i > 0) nav.push({ text: '‹ Prev', callback_data: `guide:${i - 1}` });
  if (i < total - 1) nav.push({ text: 'Next ›', callback_data: `guide:${i + 1}` });
  const rows = [];
  if (nav.length) rows.push(nav);
  rows.push([{ text: '‹ Help menu', callback_data: 'help:home' }]);
  return rows;
}

async function handleCallbackQuery(query) {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const data = query.data || '';

  // Format: plugin:<name>:<action>:<item_id>
  if (data.startsWith('plugin:')) {
    const parts = data.split(':');
    if (parts.length >= 4) {
      const pluginName = parts[1];
      const action = parts[2];
      const itemId = parts[3];

      try {
        const result = await adminPost('/plugin/callback', {
          plugin: pluginName,
          action,
          item_id: itemId,
        });

        await answerCallbackQuery(query.id, result.message || 'Done');

        // If updated view available, refresh the message
        if (result.ok && result.updated && result.updated.text) {
          await editMessageText(
            chatId, messageId,
            result.updated.text,
            result.updated.inline_keyboard
          );
        } else if (result.ok) {
          // Just append status to existing message
          const existingText = query.message?.text || '';
          await editMessageText(chatId, messageId, existingText + '\n\n' + (result.message || '✓'), null);
        }
      } catch (e) {
        await answerCallbackQuery(query.id, 'Error: ' + e.message);
      }
    }
  }

  // Format: guide:<page>  (paginated /guide menu)
  if (data.startsWith('guide:')) {
    await answerCallbackQuery(query.id);
    const idx = parseInt(data.slice(6), 10) || 0;
    const pages = await buildGuidePages();
    const i = Math.max(0, Math.min(idx, pages.length - 1));
    await editMessageText(chatId, messageId, pages[i], guideKeyboard(i, pages.length));
    return;
  }

  // Format: help:<category>  (paginated /help menu)
  if (data.startsWith('help:')) {
    const cat = data.slice(5);
    await answerCallbackQuery(query.id);
    if (cat === 'home') {
      await editMessageText(chatId, messageId, HELP_HOME_TEXT, helpHomeKeyboard());
      return;
    }
    if (cat === 'guide') {
      const pages = await buildGuidePages();
      await editMessageText(chatId, messageId, pages[0], guideKeyboard(0, pages.length));
      return;
    }
    let body, keyboard = HELP_BACK;
    if (cat === 'system') body = HELP_SYSTEM_TEXT;
    else if (cat === 'toggles') body = HELP_TOGGLES_TEXT;
    else if (cat === 'features') body = HELP_FEATURES_TEXT;
    else if (cat === 'games') {
      body = HELP_GAMES_TEXT;
      keyboard = [
        [{ text: '🎮 Play', web_app: { url: 'https://game.venomaru.dev/static/index.html?v=3' } }],
        [{ text: '‹ Back', callback_data: 'help:home' }],
      ];
    } else if (cat === 'plugins' || cat.startsWith('plugins:')) {
      const idx = cat.includes(':') ? (parseInt(cat.split(':')[1], 10) || 0) : 0;
      const pages = await buildPluginsPages();
      const i = Math.max(0, Math.min(idx, pages.length - 1));
      body = pages[i];
      const nav = [];
      if (i > 0) nav.push({ text: '‹ Prev', callback_data: `help:plugins:${i - 1}` });
      if (i < pages.length - 1) nav.push({ text: 'Next ›', callback_data: `help:plugins:${i + 1}` });
      keyboard = nav.length
        ? [nav, [{ text: '‹ Back', callback_data: 'help:home' }]]
        : HELP_BACK;
    } else return;
    await editMessageText(chatId, messageId, body, keyboard);
  }
}

async function poll() {
  try {
    const res = await apiRequest('getUpdates', {
      offset,
      timeout: 30,
      allowed_updates: JSON.stringify(['message', 'callback_query']),
    });

    // Success — reset backoff
    if (_pollBackoff > 0) {
      console.log(`[poll] Recovered after network error (was backing off ${_pollBackoff / 1000}s)`);
    }
    _pollBackoff = 0;

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
          if (update.callback_query) {
            await handleCallbackQuery(update.callback_query).catch(e =>
              console.error('[handleCallback error]', e.message)
            );
          } else if (update.message) {
            await handleMessage(update.message).catch(e =>
              console.error('[handleMessage error]', e.message)
            );
          }
        }
      }
    }
  } catch (e) {
    // Exponential backoff: 5s → 10s → 20s → 40s → 60s (capped)
    _pollBackoff = Math.min((_pollBackoff || 2500) * 2, _POLL_BACKOFF_MAX);
    console.error(`[poll error] ${e.message} — retrying in ${_pollBackoff / 1000}s`);
    await new Promise(r => setTimeout(r, _pollBackoff));
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

// ---- "/" command suggestions (Telegram setMyCommands) ----
// Registered commands show in Telegram's autocomplete popup when typing "/".
// Telegram only allows [a-z0-9_], so dot-style plugin commands get underscore
// aliases (/p.worldcup.bets → /p_worldcup_bets), resolved back before routing.
const STATIC_COMMANDS = [
  ['help', 'Command menu'],
  ['guide', 'How to trigger her tools'],
  ['ping', 'Test the bot'],
  ['avatar', 'Server status'],
  ['settings', 'Current config'],
  ['set', 'Change a setting'],
  ['mood', 'View or set mood (0-100)'],
  ['idle', 'Idle-talk interval (hours)'],
  ['memory', 'Memory ops: stats|clear|forget'],
  ['ask', 'Ask her directly'],
  ['language', 'TTS voice language en|jp'],
  ['toolcall', 'Tool sensitivity'],
  ['play', 'Astral Idols (Mini App)'],
  ['stt', 'Speech-to-text on|off'],
  ['tts', 'Text-to-speech on|off'],
  ['sleep', 'Force sleep on|off'],
  ['sticker', 'Sticker replies on|off'],
  ['emotion', 'Emotion tags on|off'],
  ['touch', 'Touch interaction on|off'],
  ['meme', 'Meme service on|off'],
];

// Shared transform for plugin-command aliases — must stay in sync with the
// resolver in handleMessage (dots AND any other illegal char become "_").
function commandAlias(command) {
  return ('p_' + String(command).toLowerCase().replace(/[^a-z0-9]/g, '_')).slice(0, 32);
}

async function registerBotCommands(attempt = 1) {
  const commands = STATIC_COMMANDS.map(([command, description]) => ({ command, description }));
  let gotPlugins = false;
  try {
    const data = await adminGet('/plugin/list');
    const seen = new Set(commands.map(c => c.command));
    for (const p of (data.plugins || [])) {
      for (const c of (p.commands || [])) {
        const alias = commandAlias(c.command);
        if (seen.has(alias)) continue;
        seen.add(alias);
        commands.push({
          command: alias,
          description: String(c.description || p.name).slice(0, 256),
        });
      }
    }
    gotPlugins = true;
  } catch (e) {
    console.error('[commands] Plugin list unavailable (attempt ' + attempt + '):', e.message);
  }
  try {
    await apiPost('setMyCommands', { commands: commands.slice(0, 100) });
    console.log(`[commands] Registered ${Math.min(commands.length, 100)} commands (plugins included: ${gotPlugins})`);
  } catch (e) {
    console.error('[commands] setMyCommands failed:', e.message);
  }
  // Avatar-server may still be booting — retry until plugin commands make it in.
  if (!gotPlugins && attempt < 5) setTimeout(() => registerBotCommands(attempt + 1), 60000);
}

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
console.log(' Companion Bot — starting');
console.log(' Avatar  :', AVATAR_SERVER_URL);
console.log(' API     : http://0.0.0.0:' + API_PORT);
console.log('═══════════════════════════════════════');

apiServer.listen(API_PORT, '0.0.0.0', () => {
  console.log(`[api] HTTP API listening on port ${API_PORT}`);
});

registerBotCommands();
// Re-register daily so newly deployed plugins show up in the "/" popup
// without a bot restart.
setInterval(() => registerBotCommands(), 24 * 3600 * 1000);

poll();
