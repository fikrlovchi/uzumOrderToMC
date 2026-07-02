const fs = require("fs");
const path = require("path");
const logger = require("./logger");

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

// Muvaffaqiyat/muvaffaqiyatsizlikni qaytaradi (throw qilmaydi) — chaqiruvchi
// muvaffaqiyatsiz urinishni "notified" deb belgilamasligi kerak, aks holda
// vaqtinchalik tarmoq xatosi 24 soatga SKU'ni butunlay soqov qilib qo'yadi.
async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const topicId = process.env.TELEGRAM_TOPIC_ID;
  if (!token || !chatId) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_thread_id: topicId ? Number(topicId) : undefined,
        text,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.error(`Telegram xabar yuborilmadi (${response.status}): ${await response.text()}`);
      return false;
    }
    return true;
  } catch (e) {
    logger.error(`Telegram'ga ulanib bo'lmadi: ${e.message}`);
    return false;
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

    const sent = await sendTelegramMessage(sku);
    if (!sent) return; // muvaffaqiyatsiz bo'lsa, keyingi tsiklda qayta sinaladi

    state[sku] = Date.now();
    saveState(state);
  } catch (e) {
    logger.error(`SKU ogohlantirish xatosi (${sku}): ${e.message}`);
  }
}

module.exports = { notifyIfNew };
