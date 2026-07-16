const logger = require("./logger");

const TIMEOUT_MS = 3000;

// Muvaffaqiyat/muvaffaqiyatsizlikni qaytaradi (throw qilmaydi) — chaqiruvchi
// muvaffaqiyatsiz urinishni "yuborildi" deb belgilamasligi kerak.
async function sendTelegramMessage({ text, parseMode } = {}) {
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
