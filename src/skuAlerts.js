const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const STATE_FILE = path.join(DATA_DIR, "notified-skus.json");
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 3000;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const topicId = process.env.TELEGRAM_TOPIC_ID;
  if (!token || !chatId) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_thread_id: topicId ? Number(topicId) : undefined,
        text,
      }),
      signal: controller.signal,
    });
  } catch {
    // Telegram'ga yetkazib bo'lmadi — asosiy jarayon uchun ahamiyatsiz
  } finally {
    clearTimeout(timeout);
  }
}

// MoySklad'da mosi topilmagan SKU haqida bir marta (24 soatlik sovish davri bilan)
// Telegram'ga xabar beradi, toki xato har 2 daqiqada takrorlanavermasin.
async function notifyIfNew(sku) {
  if (!sku) return;
  try {
    const state = loadState();
    const lastNotifiedAt = state[sku];
    if (lastNotifiedAt && Date.now() - lastNotifiedAt < COOLDOWN_MS) return;

    await sendTelegramMessage(sku);

    state[sku] = Date.now();
    saveState(state);
  } catch {
    // fayl/tarmoq xatosi SKU ogohlantirishni to'xtatishi mumkin, lekin
    // buyurtma sinxronizatsiyasini to'xtatmasligi kerak
  }
}

module.exports = { notifyIfNew };
