const MAX_RETRY = 3;
const RETRY_SLEEP_MS = 1000;
const BASE_URL = "https://api-seller.uzum.uz/api/seller-openapi";

// 429 (tezlik-limiti) yoki vaqtincha 5xx kelganda shuncha marta orqaga chekinib
// qayta uriniladi. Serverda bir nechta servis bir xil Uzum tokenlarini ulashgani
// uchun birlashgan tezlik limitdan oshib 429 kelishi mumkin — bu holda xato
// bermасdan kutib qayta yuboramiz.
const RATE_LIMIT_MAX_RETRY = 5;
const RATE_LIMIT_MAX_WAIT_MS = 10000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Barcha Uzum so'rovlari shu wrapper orqali o'tadi: 429/503/5xx bo'lsa
// Retry-After sarlavhasini (bo'lsa) yoki eksponensial backoff'ni hurmat qilib
// kutadi va qayta yuboradi. Retry tugagach oxirgi javobni qaytaradi (chaqiruvchi
// baribir !ok'ni xato deb hal qiladi).
async function uzumFetch(url, options = {}) {
  let response;
  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRY; attempt++) {
    response = await fetch(url, options);
    const retryable = response.status === 429 || (response.status >= 500 && response.status < 600);
    if (!retryable || attempt === RATE_LIMIT_MAX_RETRY) return response;

    const retryAfter = parseInt(response.headers.get("retry-after") || "", 10);
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, RATE_LIMIT_MAX_WAIT_MS)
        : Math.min(500 * 2 ** attempt, RATE_LIMIT_MAX_WAIT_MS);
    await sleep(waitMs);
  }
  return response;
}

// Bitta sahifani MAX_RETRY marta urinib oladi; barcha urinishlar muvaffaqiyatsiz
// bo'lsa null qaytaradi (chaqiruvchi shu do'kon/bosqich uchun to'xtatishga qaror
// qiladi, boshqa do'konlar davom etadi).
async function fetchOrdersPage({ shopId, shopToken, status, page, size = 50, scheme = "FBS" }) {
  const url = `${BASE_URL}/v2/fbs/orders?shopIds=${shopId}&status=${status}&scheme=${scheme}&page=${page}&size=${size}`;

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const response = await uzumFetch(url, { headers: { Authorization: shopToken } });
      if (response.ok) {
        const json = await response.json();
        return json?.payload?.orders || [];
      }
    } catch {
      // keyingi urinishga o'tiladi
    }
    if (attempt < MAX_RETRY) await sleep(RETRY_SLEEP_MS);
  }
  return null;
}

async function confirmOrder({ shopToken, orderId }) {
  const response = await uzumFetch(`${BASE_URL}/v1/fbs/order/${orderId}/confirm`, {
    method: "POST",
    headers: { Authorization: shopToken },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Uzum confirm xatosi (${response.status}): ${text}`);
  }
}

// Bitta buyurtmaning joriy holatini so'raydi (bekor qilinganini tekshirish
// uchun) — Uzum'ning butun CANCELED ro'yxatini sahifalab o'qishdan farqli
// o'laroq, faqat bitta buyurtma haqida so'rov yuboradi.
async function getOrderStatus({ shopToken, orderId }) {
  const response = await uzumFetch(`${BASE_URL}/v1/fbs/order/${orderId}`, {
    headers: { Authorization: shopToken },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Uzum buyurtma holatini so'rashda xato (${response.status}): ${text}`);
  }

  const json = await response.json();
  return json?.payload || null;
}

// Buyurtmani Uzum'da bekor qiladi (MoySklad'da operator bekor qilganda,
// mcCancelServer chaqiradi). Uzum "allaqachon bekor qilingan" (seller-order-13)
// deb javob bersa — buni ham muvaffaqiyat deb hisoblaydi (idempotent).
// Qaytaradi: { alreadyCanceled: boolean }.
async function cancelOrder({ shopToken, orderId, reason = "OTHER", comment = "" }) {
  const response = await uzumFetch(`${BASE_URL}/v1/fbs/order/${orderId}/cancel`, {
    method: "POST",
    headers: {
      accept: "*/*",
      Authorization: shopToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ reason, comment }),
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // JSON emas — pastda status bo'yicha hal qilinadi
  }

  const errorCode = json?.errors?.[0]?.code;
  if (errorCode === "seller-order-13") {
    return { alreadyCanceled: true };
  }

  if (response.ok && !json?.error) {
    return { alreadyCanceled: false };
  }

  throw new Error(`Uzum bekor qilish xatosi (${response.status}): ${text}`);
}

// Buyurtma uchun LARGE label'ni oladi (base64 hujjat). Xato bo'lsa null.
// uzumFetch orqali — 429/5xx'da qayta uriniladi (umumiy rate-limit bilan).
async function fetchLabel({ shopToken, orderId, size = "LARGE" }) {
  const url = `${BASE_URL}/v1/fbs/order/${orderId}/labels/print?size=${size}`;
  try {
    const response = await uzumFetch(url, { headers: { accept: "*/*", Authorization: shopToken } });
    if (!response.ok) return null;
    const json = await response.json();
    return json?.payload?.document || null;
  } catch {
    return null;
  }
}

module.exports = { fetchOrdersPage, confirmOrder, getOrderStatus, cancelOrder, fetchLabel };
