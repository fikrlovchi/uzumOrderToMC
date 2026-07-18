const logger = require("./logger");

const TIMEOUT_MS = 3000;

// Muvaffaqiyat/muvaffaqiyatsizlikni qaytaradi (throw qilmaydi) — chaqiruvchi
// muvaffaqiyatsiz urinishni "yuborildi" deb belgilamasligi kerak.
// chatId/topicId berilsa — o'sha guruh/topic'ka yuboriladi (masalan SKU
// ogohlantirishlari alohida guruhga); berilmasa .env'dagi TELEGRAM_CHAT_ID/
// TELEGRAM_TOPIC_ID (bekor qilingan buyurtmalar guruhi) ishlatiladi.
async function sendTelegramMessage({ text, parseMode, chatId, topicId } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const targetChat = chatId || process.env.TELEGRAM_CHAT_ID;
  const targetTopic = topicId || process.env.TELEGRAM_TOPIC_ID;
  if (!token || !targetChat) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: targetChat,
        message_thread_id: targetTopic ? Number(targetTopic) : undefined,
        text,
        parse_mode: parseMode,
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

module.exports = { sendTelegramMessage };
