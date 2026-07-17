const MAX_RETRY = 3;
const RETRY_SLEEP_MS = 1000;
const BASE_URL = "https://api-seller.uzum.uz/api/seller-openapi";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bitta sahifani MAX_RETRY marta urinib oladi; barcha urinishlar muvaffaqiyatsiz
// bo'lsa null qaytaradi (chaqiruvchi shu do'kon/bosqich uchun to'xtatishga qaror
// qiladi, boshqa do'konlar davom etadi).
async function fetchOrdersPage({ shopId, shopToken, status, page, size = 50, scheme = "FBS" }) {
  const url = `${BASE_URL}/v2/fbs/orders?shopIds=${shopId}&status=${status}&scheme=${scheme}&page=${page}&size=${size}`;

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const response = await fetch(url, { headers: { Authorization: shopToken } });
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
  const response = await fetch(`${BASE_URL}/v1/fbs/order/${orderId}/confirm`, {
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
  const response = await fetch(`${BASE_URL}/v1/fbs/order/${orderId}`, {
    headers: { Authorization: shopToken },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Uzum buyurtma holatini so'rashda xato (${response.status}): ${text}`);
  }

  const json = await response.json();
  return json?.payload || null;
}

module.exports = { fetchOrdersPage, confirmOrder, getOrderStatus };
