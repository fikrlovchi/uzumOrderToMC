// MoySklad remap 1.2 API'da mavjud entity'ni yangilash uchun PUT ishlatiladi
// (faqat o'zgartirilishi kerak bo'lgan maydonlar yuboriladi, POST yangi
// yaratish uchun index.js'da ishlatilgani kabi qoladi).

const CUSTOMERORDER_URL = "https://api.moysklad.ru/api/remap/1.2/entity/customerorder";

// uzum_order!S ustunida faqat MoySklad ID (UUID) saqlanadi, to'liq href emas.
function customerOrderHref(moySkladId) {
  return `${CUSTOMERORDER_URL}/${moySkladId}`;
}

async function setOrderState(href, stateHref, token) {
  const response = await fetch(href, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: JSON.stringify({
      state: { meta: { href: stateHref, type: "state", mediaType: "application/json" } },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MoySklad holatini o'rnatib bo'lmadi (${response.status}): ${text}`);
  }
}

async function getOrderStateHref(href, token) {
  const response = await fetch(href, {
    headers: { Authorization: "Bearer " + token },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`MoySklad buyurtmasini o'qib bo'lmadi (${response.status}): ${text}`);
  }

  const json = await response.json();
  return json.state?.meta?.href || null;
}

module.exports = { setOrderState, getOrderStateHref, customerOrderHref };
