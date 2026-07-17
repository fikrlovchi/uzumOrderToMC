const logger = require("./logger");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Kunlik so'rov limiti tugaganini bildiradi — sweep to'xtaydi, lekin oldin
// topilgan buyurtmalar MoySklad'da baribir yangilanadi.
class BudgetExhaustedError extends Error {
  constructor(cabinetName) {
    super(`"${cabinetName}" kabineti uchun Uzum kunlik so'rov limiti tugadi`);
  }
}

function buildUrl(shopId, page, cfg) {
  return (
    `${cfg.baseUrl}/v2/fbs/orders?shopIds=${shopId}` +
    `&status=${cfg.status}&scheme=${cfg.scheme}&page=${page}&size=${cfg.pageSize}`
  );
}

// Bitta sahifani oladi. Har bir haqiqiy HTTP urinish oldidan spend() chaqiriladi,
// shunda retry'lar ham kunlik limitdan yechiladi.
async function requestPage(url, token, maxRetry, spend, cabinetName) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    if (!spend()) throw new BudgetExhaustedError(cabinetName);

    let res;
    try {
      res = await fetch(url, { headers: { Authorization: token } });
    } catch (e) {
      lastErr = e; // tarmoq xatosi — kutib qayta urinamiz
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }

    if (res.status === 200) return res.json();

    lastErr = new Error(`Uzum API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    lastErr.httpStatus = res.status;
    // 4xx (429'dan tashqari) — token yoki parametr xato, qayta urinish foydasiz
    if (res.status >= 400 && res.status < 500 && res.status !== 429) throw lastErr;

    const retryAfterSec = parseInt(res.headers.get("retry-after") || "0", 10) || 0;
    await sleep(Math.max(retryAfterSec * 1000, 1000 * 2 ** (attempt - 1)));
  }
  throw lastErr;
}

// MUHIM: Uzum bu ro'yxatni buyurtmaning dateCancelled emas, balki dateCreated
// bo'yicha KAMAYISH tartibida qaytaradi (eng yangi yaratilgan birinchi) —
// amalda tekshirilgan. Bu degani: eski (ancha oldin yaratilgan) buyurtma
// bugun bekor qilinsa ham, u ro'yxatda o'zining ASL yaratilgan sanasiga mos
// chuqur sahifada qoladi — sahifa raqamlari vaqt o'tishi bilan "muhrlanmaydi".
// Shuning uchun sahifa kursorini SAQLAMAYMIZ (bu noto'g'ri va buyurtmalarni
// o'tkazib yuborishi mumkin edi): har safar 0-sahifadan boshlaymiz va faqat
// sahifadagi ENG ESKI yozuvning dateCreated'i cfg.maxLookbackDays'dan eski
// bo'lib qolganda to'xtatamiz — ro'yxat shu tartibda ekan, undan naryog'i
// ham albatta eskiroq bo'ladi, demak bizning (yaqinda yaratilgan, hali
// yechilmagan) nomzodlarimiz orasida bo'lishi mumkin emas.
async function sweepShop(cabinet, shopId, budget, cfg, ids) {
  const spend = () => budget.trySpend(cabinet.name);
  const cutoffMs = Date.now() - cfg.maxLookbackDays * 24 * 3600 * 1000;

  for (let page = 0; page < cfg.maxPagesPerSweep; page++) {
    let json;
    try {
      json = await requestPage(buildUrl(shopId, page, cfg), cabinet.token, cfg.maxRetry, spend, cabinet.name);
    } catch (e) {
      if (e instanceof BudgetExhaustedError) return { exhausted: true, capped: false };
      throw e;
    }

    const orders = (json && json.payload && json.payload.orders) || [];
    if (orders.length === 0) return { exhausted: false, capped: false };

    for (const order of orders) ids.add(String(order.id));

    const oldestOnPage = orders[orders.length - 1]?.dateCreated;
    if (typeof oldestOnPage === "number" && oldestOnPage < cutoffMs) {
      return { exhausted: false, capped: false };
    }

    if (orders.length < cfg.pageSize) return { exhausted: false, capped: false };

    if (cfg.requestDelayMs) await sleep(cfg.requestDelayMs);
  }

  return { exhausted: false, capped: true };
}

// Kabinetning har bir do'konini 0-sahifadan skanerlaydi (yuqoridagi izohga
// qarang — kursor endi ishlatilmaydi). Budjet tugasa qolgan do'konlar
// keyingi run'ga qoldiriladi.
async function sweepCabinet(cabinet, budget, cfg) {
  const ids = new Set();
  let exhausted = false;

  for (const shopId of cabinet.shopIds) {
    try {
      const { exhausted: ex, capped } = await sweepShop(cabinet, shopId, budget, cfg, ids);
      if (capped) {
        logger.info(
          `"${cabinet.name}" do'kon ${shopId}: bir run chegarasi (${cfg.maxPagesPerSweep} sahifa) — ` +
            `qolgani keyingi run'da`
        );
      }
      if (ex) {
        exhausted = true;
        break;
      }
    } catch (e) {
      logger.error(`"${cabinet.name}" do'kon ${shopId} skanerlashda xato: ${e.message}`);
    }

    if (cfg.requestDelayMs) await sleep(cfg.requestDelayMs);
  }

  return { ids, exhausted };
}

module.exports = { sweepCabinet, BudgetExhaustedError };
