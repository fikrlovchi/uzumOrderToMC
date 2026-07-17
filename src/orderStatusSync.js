const config = require("../config.json");
const logger = require("./logger");
const { colLetterToIndex } = require("./sheetsUtil");
const { tashkentMinutesNow, parseHHMM, isInHoldWindow } = require("./timeWindow");
const { confirmOrder } = require("./uzumApi");
const { parseCabinets, buildShopTokenMap } = require("./uzumCabinets");
const moysklad = require("./moysklad");
const { isDryRun } = require("./dryRun");

const ORD = Object.fromEntries(
  Object.entries(config.columns.orders).map(([k, v]) => [k, colLetterToIndex(v)])
);

function cell(value) {
  return value === undefined || value === null ? "" : value;
}

function windowBounds() {
  return {
    startMin: parseHHMM(process.env.WINDOW_HOLD_START || "06:10"),
    endMin: parseHHMM(process.env.WINDOW_HOLD_END || "11:00"),
  };
}

function loadShopTokens() {
  try {
    return buildShopTokenMap(parseCabinets(process.env));
  } catch (e) {
    logger.error(`Uzum do'kon tokenlarini o'qishda xato: ${e.message}`);
    return new Map();
  }
}

function cellUpdate(sheetName, columnKey, rowIndex, value) {
  const columnLetter = config.columns.orders[columnKey];
  return { range: `${sheetName}!${columnLetter}${rowIndex + 1}`, values: [[value]] };
}

async function confirmOnUzum({ orders, rowIndex, orderId, shopTokens, rowUpdates, ordersSheetName }) {
  const row = orders[rowIndex];
  const shopId = String(cell(row[ORD.shopId]));
  const shopToken = shopTokens.get(shopId);
  if (!shopToken) {
    logger.error(`Order ${orderId} uchun shop ${shopId} tokeni topilmadi (.env UZUM_SHOP_*) — confirm o'tkazib yuborildi.`);
    return false;
  }
  if (isDryRun()) {
    logger.info(`[DRY_RUN] Order ${orderId} Uzum'da tasdiqlanardi (shop ${shopId}).`);
    return true;
  }
  try {
    await confirmOrder({ shopToken, orderId });
    rowUpdates.push(cellUpdate(ordersSheetName, "uzumConfirmed", rowIndex, 1));
    row[ORD.uzumConfirmed] = 1;
    return true;
  } catch (e) {
    logger.error(`Order ${orderId} Uzum'da tasdiqlanmadi: ${e.message}`);
    return false;
  }
}

// Q=1 (MoySklad'da yaratilgan), hali cancelHandled=1 bo'lmagan va mcState hali
// "done" bo'lmagan buyurtmalar uchun:
//  - Toshkent vaqti hold oynasida (WINDOW_HOLD_START..END) bo'lsa: Uzum'da
//    HALI TASDIQLANMAYDI — faqat MoySklad holati "hold"ga o'rnatiladi.
//  - Oyna tashqarisida bo'lsa: Uzum'da darhol tasdiqlanadi VA MoySklad holati
//    "confirmed"ga o'rnatiladi (bir vaqtda).
// Oyna ichida "hold" qilib qo'yilgan buyurtmalarni oyna tugagach Uzum'da
// tasdiqlash + "confirmed"ga o'tkazish ishi promoteHeldOrders'da amalga oshadi.
async function confirmAndSetInitialState({ sheets, orders, moyskladToken }) {
  const ordersSheetName = config.sheets.orders;
  const shopTokens = loadShopTokens();
  const { startMin, endMin } = windowBounds();
  const rowUpdates = [];
  let errorCount = 0;

  for (let i = 1; i < orders.length; i++) {
    const row = orders[i];
    const orderId = row[ORD.orderId];
    const sentToMoySklad = row[ORD.status];
    const cancelHandled = row[ORD.cancelHandled];
    if (!orderId || sentToMoySklad != 1 || cancelHandled == 1) continue;
    if (row[ORD.mcState] === "done" || row[ORD.mcState] === "hold") continue;

    const moySkladId = row[ORD.moySkladId];
    if (!moySkladId) continue;
    const href = moysklad.customerOrderHref(moySkladId);

    const holding = isInHoldWindow(tashkentMinutesNow(), startMin, endMin);

    if (holding) {
      if (isDryRun()) {
        logger.info(`[DRY_RUN] Order ${orderId} MoySklad holati o'rnatilardi: hold (Uzum hali tasdiqlanmaydi).`);
        continue;
      }
      try {
        await moysklad.setOrderState(href, config.moyskladStates.holdHref, moyskladToken);
        rowUpdates.push(cellUpdate(ordersSheetName, "mcState", i, "hold"));
        row[ORD.mcState] = "hold";
        logger.info(`Order ${orderId} MoySklad holati o'rnatildi: hold (Uzum 11:01dan keyin tasdiqlanadi).`);
      } catch (e) {
        logger.error(`Order ${orderId} uchun MoySklad holatini o'rnatishda xato: ${e.message}`);
        errorCount++;
      }
      continue;
    }

    const confirmed = await confirmOnUzum({ orders, rowIndex: i, orderId, shopTokens, rowUpdates, ordersSheetName });
    if (!confirmed) {
      errorCount++;
      continue;
    }
    if (isDryRun()) {
      logger.info(`[DRY_RUN] Order ${orderId} MoySklad holati o'rnatilardi: confirmed.`);
      continue;
    }

    try {
      await moysklad.setOrderState(href, config.moyskladStates.confirmedHref, moyskladToken);
      rowUpdates.push(cellUpdate(ordersSheetName, "mcState", i, "done"));
      row[ORD.mcState] = "done";
      logger.info(`Order ${orderId} Uzum'da tasdiqlandi va MoySklad holati "confirmed" qilindi.`);
    } catch (e) {
      logger.error(`Order ${orderId} uchun MoySklad holatini o'rnatishda xato: ${e.message}`);
      errorCount++;
    }
  }

  if (rowUpdates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: { valueInputOption: "RAW", data: rowUpdates },
    });
  }

  return { errorCount };
}

// mcState="hold" bo'lgan buyurtmalarni, oyna tugagach (hozir hold oynasida
// bo'lmasa): agar hali Uzum'da tasdiqlanmagan bo'lsa — tasdiqlaydi, so'ng
// MoySklad holatini "confirmed"ga o'tkazadi.
async function promoteHeldOrders({ sheets, orders, moyskladToken }) {
  const ordersSheetName = config.sheets.orders;
  const { startMin, endMin } = windowBounds();

  if (isInHoldWindow(tashkentMinutesNow(), startMin, endMin)) return { errorCount: 0 };

  const shopTokens = loadShopTokens();
  const rowUpdates = [];
  let errorCount = 0;

  for (let i = 1; i < orders.length; i++) {
    const row = orders[i];
    const orderId = row[ORD.orderId];
    if (row[ORD.mcState] !== "hold" || row[ORD.cancelHandled] == 1) continue;

    const moySkladId = row[ORD.moySkladId];
    if (!moySkladId) continue;
    const href = moysklad.customerOrderHref(moySkladId);

    if (row[ORD.uzumConfirmed] != 1) {
      const confirmed = await confirmOnUzum({ orders, rowIndex: i, orderId, shopTokens, rowUpdates, ordersSheetName });
      if (!confirmed) {
        errorCount++;
        continue;
      }
    }

    if (isDryRun()) {
      logger.info(`[DRY_RUN] Order ${orderId} oyna tugagach "confirmed" holatiga o'tkazilardi.`);
      continue;
    }

    try {
      await moysklad.setOrderState(href, config.moyskladStates.confirmedHref, moyskladToken);
      rowUpdates.push(cellUpdate(ordersSheetName, "mcState", i, "done"));
      row[ORD.mcState] = "done";
      logger.info(`Order ${orderId} oyna tugagach Uzum'da tasdiqlandi va "confirmed" holatiga o'tkazildi.`);
    } catch (e) {
      logger.error(`Order ${orderId} holatini "confirmed"ga o'tkazishda xato: ${e.message}`);
      errorCount++;
    }
  }

  if (rowUpdates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: { valueInputOption: "RAW", data: rowUpdates },
    });
  }

  return { errorCount };
}

module.exports = { confirmAndSetInitialState, promoteHeldOrders };
