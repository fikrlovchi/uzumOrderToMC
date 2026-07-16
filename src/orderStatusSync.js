const config = require("../config.json");
const logger = require("./logger");
const { colLetterToIndex } = require("./sheetsUtil");
const { tashkentMinutesNow, parseHHMM, isInHoldWindow } = require("./timeWindow");
const { confirmOrder } = require("./uzumApi");
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

async function loadShopTokens(sheets) {
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: config.sheets.shops,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = data.values || [];
  const tokens = new Map();
  for (let i = 1; i < rows.length; i++) {
    const shopId = rows[i][0];
    const token = rows[i][2];
    if (shopId && token) tokens.set(String(shopId), String(token));
  }
  return tokens;
}

function cellUpdate(sheetName, columnKey, rowIndex, value) {
  const columnLetter = config.columns.orders[columnKey];
  return { range: `${sheetName}!${columnLetter}${rowIndex + 1}`, values: [[value]] };
}

// Q=1 (MoySklad'da yaratilgan), T bo'sh (hali Uzum'da tasdiqlanmagan) yoki
// U hali "done" bo'lmagan buyurtmalar uchun: Uzum'da tasdiqlaydi (T=1, faqat
// bir marta — muvaffaqiyatsiz MoySklad holat o'rnatish Uzum'ga qayta so'rov
// yubormaydi, faqat holatni qayta urinadi), so'ng joriy vaqtga qarab MoySklad
// holatini "hold" yoki "confirmed" qilib qo'yadi.
async function confirmAndSetInitialState({ sheets, orders, moyskladToken }) {
  const ordersSheetName = config.sheets.orders;
  const shopTokens = await loadShopTokens(sheets);
  const { startMin, endMin } = windowBounds();
  const rowUpdates = [];
  let errorCount = 0;

  for (let i = 1; i < orders.length; i++) {
    const row = orders[i];
    const orderId = row[ORD.orderId];
    const sentToMoySklad = row[ORD.status];
    const cancelHandled = row[ORD.cancelHandled];
    if (!orderId || sentToMoySklad != 1 || cancelHandled == 1) continue;

    const moySkladId = row[ORD.moySkladId];
    if (!moySkladId) continue;
    const href = moysklad.customerOrderHref(moySkladId);

    if (row[ORD.uzumConfirmed] != 1) {
      const shopId = String(cell(row[ORD.shopId]));
      const shopToken = shopTokens.get(shopId);
      if (!shopToken) {
        logger.error(`Order ${orderId} uchun shop ${shopId} tokeni topilmadi (uzum_shop) — confirm o'tkazib yuborildi.`);
        errorCount++;
        continue;
      }
      if (isDryRun()) {
        logger.info(`[DRY_RUN] Order ${orderId} Uzum'da tasdiqlanardi (shop ${shopId}).`);
      } else {
        try {
          await confirmOrder({ shopToken, orderId });
          rowUpdates.push(cellUpdate(ordersSheetName, "uzumConfirmed", i, 1));
          row[ORD.uzumConfirmed] = 1;
        } catch (e) {
          logger.error(`Order ${orderId} Uzum'da tasdiqlanmadi: ${e.message}`);
          errorCount++;
          continue;
        }
      }
    }

    if (row[ORD.mcState] === "done") continue;

    const holding = isInHoldWindow(tashkentMinutesNow(), startMin, endMin);
    const targetHref = holding ? config.moyskladStates.holdHref : config.moyskladStates.confirmedHref;

    if (isDryRun()) {
      logger.info(`[DRY_RUN] Order ${orderId} MoySklad holati o'rnatilardi: ${holding ? "hold" : "confirmed"}.`);
      continue;
    }

    try {
      await moysklad.setOrderState(href, targetHref, moyskladToken);
      const newState = holding ? "hold" : "done";
      rowUpdates.push(cellUpdate(ordersSheetName, "mcState", i, newState));
      row[ORD.mcState] = newState;
      logger.info(`Order ${orderId} MoySklad holati o'rnatildi: ${holding ? "hold" : "confirmed"}.`);
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

// U="hold" bo'lgan buyurtmalarni, oyna tugagach (hozir hold oynasida bo'lmasa),
// "confirmed" holatiga o'tkazadi.
async function promoteHeldOrders({ sheets, orders, moyskladToken }) {
  const ordersSheetName = config.sheets.orders;
  const { startMin, endMin } = windowBounds();

  if (isInHoldWindow(tashkentMinutesNow(), startMin, endMin)) return { errorCount: 0 };

  const rowUpdates = [];
  let errorCount = 0;

  for (let i = 1; i < orders.length; i++) {
    const row = orders[i];
    const orderId = row[ORD.orderId];
    if (row[ORD.mcState] !== "hold" || row[ORD.cancelHandled] == 1) continue;

    const moySkladId = row[ORD.moySkladId];
    if (!moySkladId) continue;
    const href = moysklad.customerOrderHref(moySkladId);

    if (isDryRun()) {
      logger.info(`[DRY_RUN] Order ${orderId} oyna tugagach "confirmed" holatiga o'tkazilardi.`);
      continue;
    }

    try {
      await moysklad.setOrderState(href, config.moyskladStates.confirmedHref, moyskladToken);
      rowUpdates.push(cellUpdate(ordersSheetName, "mcState", i, "done"));
      row[ORD.mcState] = "done";
      logger.info(`Order ${orderId} oyna tugagach "confirmed" holatiga o'tkazildi.`);
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
