// MoySklad remap 1.2 API'da mavjud entity'ni yangilash uchun PUT ishlatiladi
// (faqat o'zgartirilishi kerak bo'lgan maydonlar yuboriladi, POST yangi
// yaratish uchun index.js'da ishlatilgani kabi qoladi).

const CUSTOMERORDER_URL = "https://api.moysklad.ru/api/remap/1.2/entity/customerorder";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// uzum_order!S ustunida faqat MoySklad ID (UUID) saqlanadi, to'liq href emas.
function customerOrderHref(moySkladId) {
  return `${CUSTOMERORDER_URL}/${moySkladId}`;
}

// MoySklad tezlik limiti (45 so'rov / 3 soniya) uchun: 429 kelsa server aytgan
// intervalcha kutib, 3 martagacha qayta urinadi.
async function msFetch(url, options, token) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
        ...(options.headers || {}),
      },
    });
    if (response.status !== 429) return response;
    const waitMs = parseInt(response.headers.get("x-lognex-retry-timeinterval") || "1000", 10) || 1000;
    await sleep(Math.min(Math.max(waitMs, 500), 5000));
  }
  throw new Error("MoySklad 429: tezlik limiti 3 urinishdan keyin ham o'tmadi");
}

async function setOrderState(href, stateHref, token) {
  const response = await msFetch(
    href,
    {
      method: "PUT",
      body: JSON.stringify({
        state: { meta: { href: stateHref, type: "state", mediaType: "application/json" } },
      }),
    },
    token
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MoySklad holatini o'rnatib bo'lmadi (${response.status}): ${text}`);
  }
}

async function getOrderStateHref(href, token) {
  const response = await msFetch(href, { method: "GET" }, token);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MoySklad buyurtmasini o'qib bo'lmadi (${response.status}): ${text}`);
  }

  const json = await response.json();
  return json.state?.meta?.href || null;
}

// Uzum buyurtma ID'si MoySklad'da externalCode sifatida saqlanadi
// (index.js shunday yaratadi) — shu orqali buyurtmani sheetga bog'liq
// bo'lmasdan topish mumkin.
async function findByExternalCode(externalCode, token) {
  const url = `${CUSTOMERORDER_URL}?filter=${encodeURIComponent(`externalCode=${externalCode}`)}&limit=1`;
  const response = await msFetch(url, { method: "GET" }, token);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MoySklad qidiruv xatosi (${response.status}): ${text}`);
  }
  const json = await response.json();
  return (json.rows && json.rows[0]) || null;
}

module.exports = { setOrderState, getOrderStateHref, customerOrderHref, findByExternalCode };
