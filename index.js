import http from "http";
import https from "https";
import crypto from "crypto";
import { execSync } from "child_process";
import fs from "fs";

const PAUSE_FLAG = "/tmp/instagram_bot_paused";

const CALENDAR_CHECKER = process.env.CALENDAR_CHECKER || "./calendar_checker.py";
const MONTHS_RU = {
  "января":1,"февраля":2,"марта":3,"апреля":4,"мая":5,"июня":6,
  "июля":7,"августа":8,"сентября":9,"октября":10,"ноября":11,"декабря":12
};

function extractDate(text) {
  // "15 августа" / "августа 15"
  const m1 = text.match(/(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/i)
            || text.match(/(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{1,2})/i);
  if (m1) {
    const day = parseInt(m1[1]) || parseInt(m1[2]);
    const monthName = (m1[1].match(/\d/) ? m1[2] : m1[1]).toLowerCase();
    const month = MONTHS_RU[monthName];
    if (day && month) return `${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
  }
  // "15.08" / "15/08" / "08-15"
  const m2 = text.match(/(\d{2})[.\/-](\d{2})/);
  if (m2) return `${m2[1]}-${m2[2]}`;
  return null;
}

function checkCalendar(dateMD) {
  try {
    const result = execSync(
      `python3 ${CALENDAR_CHECKER} --date ${dateMD}`,
      { timeout: 8000, encoding: "utf8" }
    ).trim();
    return result; // FREE, FREE_AFTER_12PM, BUSY
  } catch (e) {
    return null;
  }
}

const USER_RULES_FILE = new URL("user_rules.json", import.meta.url).pathname;

function loadUserRules() {
  try {
    return JSON.parse(fs.readFileSync(USER_RULES_FILE, "utf8"));
  } catch {
    return { blocked: [], restricted: {} };
  }
}

// --- Persistent conversation history ---
const HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const HISTORY_MAX_MESSAGES = 30; // max messages per conversation (user+assistant pairs)
const HISTORY_DIR = new URL("history/", import.meta.url).pathname;

function historyPath(senderId) {
  // Sanitize senderId to safe filename
  return `${HISTORY_DIR}${senderId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
}

function getHistory(senderId) {
  try {
    const raw = fs.readFileSync(historyPath(senderId), "utf8");
    const entry = JSON.parse(raw);
    if (Date.now() - entry.lastActivity > HISTORY_TTL_MS) {
      fs.unlinkSync(historyPath(senderId));
      return [];
    }
    return entry.messages || [];
  } catch {
    return [];
  }
}

function saveHistory(senderId, userText, assistantReply) {
  const history = getHistory(senderId);
  history.push({ role: "user", content: userText });
  history.push({ role: "assistant", content: assistantReply });
  const trimmed = history.slice(-HISTORY_MAX_MESSAGES);
  const entry = { messages: trimmed, lastActivity: Date.now() };
  try {
    fs.writeFileSync(historyPath(senderId), JSON.stringify(entry), "utf8");
  } catch (e) {
    console.error("Failed to save history:", e.message);
  }
}

// Periodically clean up expired history files
setInterval(() => {
  try {
    const now = Date.now();
    for (const file of fs.readdirSync(HISTORY_DIR)) {
      if (!file.endsWith(".json")) continue;
      const fpath = `${HISTORY_DIR}${file}`;
      try {
        const entry = JSON.parse(fs.readFileSync(fpath, "utf8"));
        if (now - entry.lastActivity > HISTORY_TTL_MS) fs.unlinkSync(fpath);
      } catch { fs.unlinkSync(fpath); }
    }
  } catch (e) {
    console.error("History cleanup error:", e.message);
  }
}, 6 * 60 * 60 * 1000); // every 6 hours

const PORT = 3001;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET;
const META_PAGE_ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN;
const GRAPH_API_URL = "https://graph.instagram.com/v21.0";

const OPENCLAW_COMPLETIONS_URL = process.env.OPENCLAW_COMPLETIONS_URL || "http://127.0.0.1:18789/v1/chat/completions";
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN;
const OPENCLAW_AGENT_ID = process.env.OPENCLAW_AGENT_ID || "my-agent";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ADMIN_ID = process.env.TELEGRAM_ADMIN_ID;

function verifySignature(rawBody, signature) {
  if (!signature || !META_APP_SECRET) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", META_APP_SECRET).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

async function httpRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || "POST",
      headers: options.headers,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getOpenclaWReply(senderId, userMessage, restrictions = []) {
  // Pre-check calendar availability if message contains a date
  let calendarNote = "";
  const dateMD = extractDate(userMessage);
  if (dateMD) {
    const status = checkCalendar(dateMD);
    if (status) {
      calendarNote = `\n\n[Автоматическая проверка даты ${dateMD}: ${status}. Используй этот результат — НЕ запускай calendar_checker.py самостоятельно.]`;
      console.log(`Calendar check ${dateMD}: ${status}`);
    }
  }

  const restrictionNotes = [];
  if (restrictions.includes("no_calendar")) {
    restrictionNotes.push("- НЕ отправляй клиенту ссылку на календарь и НЕ называй цены. При вопросах о датах/ценах — уведоми Диму молча, клиенту ничего не отвечай.");
  }
  const restrictionBlock = restrictionNotes.length > 0 ? `\n\nОГРАНИЧЕНИЯ ДЛЯ ЭТОГО КЛИЕНТА:\n${restrictionNotes.join("\n")}` : "";

  // Load conversation history
  const history = getHistory(senderId);

  const payload = JSON.stringify({
    model: `openclaw:${OPENCLAW_AGENT_ID}`,
    user: `instagram:${senderId}`,
    messages: [
      {
        role: "system",
        content: `Клиент пишет через Instagram Direct (не Telegram). Отвечай так же, как отвечал бы в Telegram.\n\nВАЖНО для этого канала:\n- НЕ используй message tool для ответа клиенту — внешний сервис (instagram-webhook) сам доставит твой ответ напрямую в Instagram\n- НЕ пиши [[reply_to_current]] — просто напиши текст ответа клиенту\n- Инструменты (calendar_checker.py, showings.py) запускать можно и нужно\n- НЕ используй message tool для уведомлений — уведомление администратору уже отправляется отдельно${calendarNote}${restrictionBlock}`,
      },
      ...history,
      {
        role: "user",
        content: userMessage,
      },
    ],
  });

  const result = await httpRequest(OPENCLAW_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENCLAW_TOKEN}`,
      "Content-Length": Buffer.byteLength(payload),
    },
  }, payload);

  if (result.status !== 200) {
    throw new Error(`OpenClaw completions error ${result.status}: ${result.body.slice(0, 300)}`);
  }

  const data = JSON.parse(result.body);
  let reply = data.choices[0].message.content;
  // Strip openclaw service tags
  reply = reply.replace(/\[\[\s*reply_to[^\]]*\]\]\s*/g, "");
  // Strip tool error lines (⚠️ prefixed) that leaked into response
  reply = reply.replace(/^⚠️.*$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  // Instagram doesn't render Markdown — convert [text](url) to plain URL
  reply = reply.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$2");
  return reply;
}

async function sendInstagramMessage(recipientId, text) {
  if (!META_PAGE_ACCESS_TOKEN) {
    console.error("META_PAGE_ACCESS_TOKEN not set");
    return;
  }

  const payload = JSON.stringify({
    recipient: { id: recipientId },
    message: { text },
  });

  const result = await httpRequest(`${GRAPH_API_URL}/me/messages?access_token=${META_PAGE_ACCESS_TOKEN}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    },
  }, payload);

  if (result.status === 200) {
    console.log(`Sent to Instagram ${recipientId}: ${text.slice(0, 80)}`);
  } else {
    console.error(`Instagram send error ${result.status}: ${result.body.slice(0, 300)}`);
  }
}

async function notifyAdmin(senderId, userText, botReply) {
  if (!TELEGRAM_BOT_TOKEN) return;

  const text = `📩 *Instagram*\n\n👤 Клиент: \`${senderId}\`\n💬 Вопрос: ${userText}\n\n🤖 Ответ: ${botReply}`;
  const payload = JSON.stringify({
    chat_id: TELEGRAM_ADMIN_ID,
    text,
    parse_mode: "Markdown",
  });

  try {
    await httpRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, payload);
  } catch (err) {
    console.error("Telegram notify error:", err.message);
  }
}

async function processMessage(senderId, text) {
  try {
    console.log(`Processing Instagram message from ${senderId}: ${text.slice(0, 100)}`);

    const rules = loadUserRules();

    // Blocked users: skip AI entirely, notify admin to respond manually
    if (rules.blocked.includes(senderId)) {
      console.log(`Blocked user ${senderId}, skipping AI`);
      await notifyAdmin(senderId, text, "[ЗАБЛОКИРОВАН — ответьте вручную через Instagram]");
      return;
    }

    const restrictions = rules.restricted[senderId] || [];
    const reply = await getOpenclaWReply(senderId, text, restrictions);
    console.log(`OpenClaw reply: ${reply.slice(0, 100)}`);

    // If bot produced no response, skip sending to client and notify admin to respond manually
    if (!reply || reply === "No response from OpenClaw.") {
      console.log(`No reply from bot for ${senderId}, notifying admin to respond manually`);
      await notifyAdmin(senderId, text, "[БОТ ПРОМОЛЧАЛ — ответьте вручную через Instagram]");
      return;
    }

    await sendInstagramMessage(senderId, reply);
    saveHistory(senderId, text, reply);
    await notifyAdmin(senderId, text, reply);
  } catch (err) {
    console.error("Error processing message:", err.message);
  }
}

// Debounce: buffer messages per sender
const messageBuffer = {};
const debounceTimers = {};
const DEBOUNCE_MS = 3000;

function scheduleProcessing(senderId, text) {
  if (fs.existsSync(PAUSE_FLAG)) {
    console.log(`Bot paused, skipping message from ${senderId}`);
    return;
  }
  if (!messageBuffer[senderId]) messageBuffer[senderId] = [];
  messageBuffer[senderId].push(text);

  if (debounceTimers[senderId]) clearTimeout(debounceTimers[senderId]);

  debounceTimers[senderId] = setTimeout(async () => {
    const combined = messageBuffer[senderId].join("\n");
    messageBuffer[senderId] = [];
    delete debounceTimers[senderId];
    await processMessage(senderId, combined);
  }, DEBOUNCE_MS);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  console.log(`${req.method} ${req.url}`);

  // GET — webhook verification from Meta
  if (req.method === "GET" && url.pathname === "/instagram") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === META_VERIFY_TOKEN) {
      console.log(`Webhook verified, challenge: ${challenge}`);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(challenge);
    } else {
      res.writeHead(403);
      res.end("Forbidden");
    }
    return;
  }

  // POST — incoming Instagram messages
  if (req.method === "POST" && url.pathname === "/instagram") {
    let rawBody = "";
    req.on("data", (chunk) => (rawBody += chunk));
    req.on("end", async () => {
      const signature = req.headers["x-hub-signature-256"];

      if (META_APP_SECRET && !verifySignature(rawBody, signature)) {
        console.warn("Invalid signature");
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }

      // Always respond 200 to Meta immediately
      res.writeHead(200);
      res.end("OK");

      try {
        const body = JSON.parse(rawBody);
        for (const entry of body.entry || []) {
          for (const msg of entry.messaging || []) {
            const senderId = msg.sender?.id;
            const message = msg.message;

            if (!senderId || !message) continue;

            // Skip echo messages (bot's own outgoing messages)
            if (message.is_echo) {
              console.log(`Skipping echo from ${senderId}`);
              continue;
            }

            // Skip attachments (story mentions, media, etc.)
            if (message.attachments) {
              console.log(`Skipping attachment from ${senderId}`);
              continue;
            }

            const text = message.text?.trim();
            if (!text || text.length <= 2) {
              console.log(`Skipping empty/emoji message from ${senderId}`);
              continue;
            }

            console.log(`Instagram message from ${senderId}: ${text.slice(0, 100)}`);
            scheduleProcessing(senderId, text);
          }
        }
      } catch (err) {
        console.error("Error parsing webhook body:", err);
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Instagram webhook bridge listening on port ${PORT}`);
  if (!OPENCLAW_TOKEN) console.warn("WARNING: OPENCLAW_TOKEN not set!");
  if (!META_PAGE_ACCESS_TOKEN) console.warn("WARNING: META_PAGE_ACCESS_TOKEN not set!");
});
