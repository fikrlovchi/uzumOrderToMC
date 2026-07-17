const config = require("../config.json");
const logger = require("./logger");
const { colLetterToIndex } = require("./sheetsUtil");
const { getOrderStatus } = require("./uzumApi");
const { parseCabinets, buildShopTokenMap } = require("./uzumCabinets");
const moysklad = require("./moysklad");
const { sendTelegramMessage } = require("./telegram");
const { isDryRun } = require("./dryRun");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Uzum'ning haqiqiy tezlik-limiti (token-bucket: 2/soniya) — boshqa
// modullar bilan bir xil tanaffus.
const REQUEST_DELAY_MS = config.cancelSync?.requestDelayMs || 600;

const ORD = Object.fromEntries(
  Object.entries(config.columns.orders).map(([k, v]) => [k, colLetterToIndex(v)])
);

function cell(value) {
  return value === undefined || value === null ? "" : value;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
}

// CANCEL_NOTIFY_CONTACTS="Ismi:chatId,Ismi2:chatId2" — bir nechta odamni
// bitta xabarda belgilash (tag qilish) imkonini beradi.
function parseNotifyContacts() {
  const raw = process.env.CANCEL_NOTIFY_CONTACTS || "";
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, chatId] = entry.split(":").map((s) => s.trim());
      return name && chatId ? { name, chatId } : null;
    })
    .filter(Boolean);
}

async function notifyCancellation(orderId) {
  const contacts = parseNotifyContacts();
  const tags = contacts
    .map((c) => `<a href="tg://user?id=${c.chatId}">${escapeHtml(c.name)}</a>`)
    .join(" ");
  await sendTelegramMessage({
    text: `❌ Buyurtma bekor qilindi: ${escapeHtml(orderId)}${tags ? "\n" + tags : ""}`,
    parseMode: "HTML",
  });
}

function cellUpdate(sheetName, columnKey, rowIndex, value) {
  const columnLetter = config.columns.orders[columnKey];
  return { range: `${sheetName}!${columnLetter}${rowIndex + 1}`, values: [[value]] };
}

// Q=1 (MoySklad'da yaratilgan) va V (cancelHandled) hali bo'sh bo'lgan har bir
// buyurtma uchun:
//  1. Avval MoySklad holatini S (moySkladId) orqali tekshiradi — arzon so'rov.
//     Agar allaqachon "himoyalangan" (yakuniy) holatda bo'lsa, V=1 qilib
//     qo'yiladi va boshqa hech narsa qilinmaydi.
//  2. Aks holda, Uzum'dan aynan shu buyurtmaning joriy holatini so'raydi
//     (butun CANCELED ro'yxatini emas — faqat bitta buyurtma). Agar Uzum
//     statusi CANCELED bo'lsa: mas'ul odamlarni belgilab Telegram'ga xabar
//     beradi va V=1 qilib qo'yadi. MoySklad holati BU YERDA o'zgartirilmaydi
//     — faqat ogohlantirish va belgilash.
async function run({ sheets, orders, moyskladToken }) {
  const ordersSheetName = config.sheets.orders;
  const shopTokens = buildShopTokenMap(parseCabinetsSafe());
  const rowUpdates = [];
  let errorCount = 0;
  let checkedCount = 0;
  let canceledCount = 0;
  let alreadyProtectedCount = 0;

  const runDeadline = Date.now() + (config.cancelSync?.run?.maxDurationMs || 60000);

  for (let i = 1; i < orders.length; i++) {
    if (Date.now() > runDeadline) {
      logger.info("Bekor qilish tekshiruvi uchun vaqt byudjeti tugadi — qolgani keyingi tsiklda.");
      break;
    }

    const row = orders[i];
    const orderId = row[ORD.orderId];
    const sentToMoySklad = row[ORD.status];
    const cancelHandled = row[ORD.cancelHandled];
    if (!orderId || sentToMoySklad != 1 || cancelHandled == 1) continue;

    const moySkladId = row[ORD.moySkladId];
    if (!moySkladId) continue;
    const href = moysklad.customerOrderHref(moySkladId);

    checkedCount++;

    try {
      const currentStateHref = await moysklad.getOrderStateHref(href, moyskladToken);

      if (currentStateHref === config.moyskladStates.protectedHref) {
        markCancelHandled(orders, i, ordersSheetName, rowUpdates);
        alreadyProtectedCount++;
        continue;
      }

      const shopId = String(cell(row[ORD.shopId]));
      const shopToken = shopTokens.get(shopId);
      if (!shopToken) {
        logger.error(`Order ${orderId} uchun shop ${shopId} tokeni topilmadi (.env UZUM_SHOP_*) — bekor qilish tekshiruvi o'tkazib yuborildi.`);
        errorCount++;
        continue;
      }

      const uzumOrder = await getOrderStatus({ shopToken, orderId });

      if (uzumOrder && uzumOrder.status === "CANCELED") {
        if (isDryRun()) {
          logger.info(`[DRY_RUN] Order ${orderId} Uzum'da bekor qilingan — Telegram xabari yuborilardi va V=1 qilinardi.`);
        } else {
          await notifyCancellation(orderId);
          markCancelHandled(orders, i, ordersSheetName, rowUpdates);
          canceledCount++;
          logger.info(`Order ${orderId} Uzum'da bekor qilingan — Telegram'ga xabar berildi.`);
        }
      }
    } catch (e) {
      errorCount++;
      logger.error(`Order ${orderId} bekor qilishni tekshirishda xato: ${e.message}`);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  if (rowUpdates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: { valueInputOption: "RAW", data: rowUpdates },
    });
  }

  logger.info(
    `Bekor qilish tekshiruvi: ${checkedCount} tekshirildi, ${canceledCount} bekor qilingan topildi, ` +
      `${alreadyProtectedCount} allaqachon himoyalangan, ${errorCount} xato.`
  );

  return { errorCount };
}

function markCancelHandled(orders, rowIndex, ordersSheetName, rowUpdates) {
  rowUpdates.push(cellUpdate(ordersSheetName, "cancelHandled", rowIndex, 1));
  orders[rowIndex][ORD.cancelHandled] = 1;
}

function parseCabinetsSafe() {
  try {
    return parseCabinets(process.env);
  } catch (e) {
    logger.error(`Uzum kabinetlarini o'qishda xato: ${e.message}`);
    return [];
  }
}

module.exports = { run };
