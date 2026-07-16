const fs = require("fs");
const path = require("path");
const logger = require("./logger");
const { sendTelegramMessage } = require("./telegram");

const DATA_DIR = path.join(__dirname, "..", "data");
const STATE_FILE = path.join(DATA_DIR, "notified-skus.json");
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

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

// MoySklad'da mosi topilmagan SKU haqida bir marta (24 soatlik sovish davri bilan)
// Telegram'ga xabar beradi, toki xato har 2 daqiqada takrorlanavermasin.
async function notifyIfNew(sku) {
  if (!sku) return;
  try {
    const state = loadState();
    const lastNotifiedAt = state[sku];
    if (lastNotifiedAt && Date.now() - lastNotifiedAt < COOLDOWN_MS) return;

    const sent = await sendTelegramMessage({ text: sku });
    if (!sent) return; // muvaffaqiyatsiz bo'lsa, keyingi tsiklda qayta sinaladi

    state[sku] = Date.now();
    saveState(state);
  } catch (e) {
    logger.error(`SKU ogohlantirish xatosi (${sku}): ${e.message}`);
  }
}

module.exports = { notifyIfNew };
