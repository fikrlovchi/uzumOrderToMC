const config = require("../config.json");
const logger = require("./logger");
const { colLetterToIndex } = require("./sheetsUtil");
const { fetchOrdersPage } = require("./uzumApi");
const moysklad = require("./moysklad");
const { sendTelegramMessage } = require("./telegram");

const MAX_PAGES_PER_SHOP = 20;
const PAGE_SIZE = 50;

const ORD = Object.fromEntries(
  Object.entries(config.columns.orders).map(([k, v]) => [k, colLetterToIndex(v)])
);

function cell(value) {
  return value === undefined || value === null ? "" : value;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
}

// Uzum'da CANCELED bo'lgan, lekin bizda hali cancelHandled=1 deb belgilanmagan
// buyurtmalarni topib, MoySklad holatini bekor qilingan qilib qo'yadi va
// mas'ul odamga Telegram orqali xabar beradi. Har bir do'kon uchun sahifa 0
// dan boshlanadi (saqlangan "kursor" ishlatilmaydi — Uzum ro'yxati vaqt
// bo'yicha kamayish tartibida bo'lishi mumkin, bu holda saqlangan sahifa
// raqami vaqt o'tishi bilan noto'g'ri yozuvlarga ishora qila boshlaydi).
// O'rniga: har bir do'kon uchun nomzodlar to'plami bo'shagach yoki bo'sh
// sahifa/MAX_PAGES_PER_SHOP chegarasiga yetilgach to'xtatiladi.
async function run({ sheets, orders, moyskladToken }) {
  const spreadsheetId = config.spreadsheetId;
  const ordersSheetName = config.sheets.orders;
  const shopsSheetName = config.sheets.shops;

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: shopsSheetName,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const shopRows = data.values || [];
  const shopTokens = new Map();
  for (let i = 1; i < shopRows.length; i++) {
    const shopId = shopRows[i][0];
    const token = shopRows[i][2];
    if (shopId && token) shopTokens.set(String(shopId), String(token));
  }

  const candidatesByShop = new Map(); // shopId -> Map(orderId -> rowIndex)
  for (let i = 1; i < orders.length; i++) {
    const row = orders[i];
    const orderId = row[ORD.orderId];
    const sentToMoySklad = row[ORD.status];
    const cancelHandled = row[ORD.cancelHandled];
    if (!orderId || sentToMoySklad != 1 || cancelHandled == 1) continue;

    const shopId = String(cell(row[ORD.shopId]));
    if (!candidatesByShop.has(shopId)) candidatesByShop.set(shopId, new Map());
    candidatesByShop.get(shopId).set(String(orderId), i);
  }

  const rowUpdates = [];
  let errorCount = 0;

  for (const [shopId, candidates] of candidatesByShop) {
    const token = shopTokens.get(shopId);
    if (!token || candidates.size === 0) continue;

    for (let page = 0; page < MAX_PAGES_PER_SHOP && candidates.size > 0; page++) {
      const pageOrders = await fetchOrdersPage({
        shopId,
        shopToken: token,
        status: "CANCELED",
        page,
        size: PAGE_SIZE,
      });

      if (pageOrders === null) {
        logger.error(`Uzum'dan bekor qilingan buyurtmalarni olishda xato (shop ${shopId}, sahifa ${page}) — bu do'kon uchun to'xtatildi.`);
        errorCount++;
        break;
      }
      if (pageOrders.length === 0) break;

      for (const o of pageOrders) {
        const orderId = String(o.id);
        if (!candidates.has(orderId)) continue;

        const rowIndex = candidates.get(orderId);
        candidates.delete(orderId);
        const ok = await handleCanceledOrder({ orders, rowIndex, orderId, moyskladToken, ordersSheetName, rowUpdates });
        if (!ok) errorCount++;
      }
    }
  }

  if (rowUpdates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: "RAW", data: rowUpdates },
    });
  }

  return { errorCount };
}

// rowUpdates'ga Sheets uchun push qiladi VA joriy tsikldan keyin ishga
// tushadigan bosqichlar (promoteHeldOrders) eskirgan qiymatni ko'rmasligi
// uchun xotiradagi `orders` massivini ham darhol yangilaydi.
function markCancelHandled(orders, rowIndex, ordersSheetName, rowUpdates) {
  const columnLetter = config.columns.orders.cancelHandled;
  rowUpdates.push({ range: `${ordersSheetName}!${columnLetter}${rowIndex + 1}`, values: [[1]] });
  orders[rowIndex][ORD.cancelHandled] = 1;
}

async function handleCanceledOrder({ orders, rowIndex, orderId, moyskladToken, ordersSheetName, rowUpdates }) {
  const row = orders[rowIndex];
  const moySkladId = row[ORD.moySkladId];
  if (!moySkladId) return true;

  const href = moysklad.customerOrderHref(moySkladId);

  try {
    const currentStateHref = await moysklad.getOrderStateHref(href, moyskladToken);

    if (currentStateHref === config.moyskladStates.protectedHref) {
      markCancelHandled(orders, rowIndex, ordersSheetName, rowUpdates);
      logger.info(`Order ${orderId} Uzum'da bekor qilingan, lekin MoySklad'da himoyalangan holatda — tegilmadi.`);
      return true;
    }

    await moysklad.setOrderState(href, config.moyskladStates.canceledHref, moyskladToken);
    markCancelHandled(orders, rowIndex, ordersSheetName, rowUpdates);
    logger.info(`Order ${orderId} Uzum'da bekor qilingan, MoySklad'da ham bekor qilindi.`);

    const name = process.env.CANCEL_NOTIFY_NAME;
    const chatId = process.env.CANCEL_NOTIFY_CHAT_ID;
    const tag = name && chatId ? `<a href="tg://user?id=${chatId}">${escapeHtml(name)}</a>` : "";
    await sendTelegramMessage({
      text: `❌ Buyurtma bekor qilindi: ${escapeHtml(orderId)}${tag ? "\n" + tag : ""}`,
      parseMode: "HTML",
    });
    return true;
  } catch (e) {
    logger.error(`Order ${orderId} bekor qilishni sinxronlashda xato: ${e.message}`);
    return false;
  }
}

module.exports = { run };
