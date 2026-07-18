const config = require("../config.json");
const logger = require("./logger");
const { getSheetsClient } = require("./oauthSheets");
const { fetchOrdersPage } = require("./uzumApi");
const { parseCabinets, buildShopTokenMap } = require("./uzumCabinets");
const { cacheLabel } = require("./labels");
const { isDryRun } = require("./dryRun");
const { tashkentNowString } = require("./sheetsUtil");

const ARRIVED_AT_COL = config.columns.orders.arrivedAt;

// append javobidagi updatedRange ("uzum_order!A100:M105") ichidan qo'shilgan
// birinchi va oxirgi qator raqamlarini ajratadi. Topa olmasa null qaytaradi.
function parseAppendedRowRange(updatedRange) {
  const match = /![A-Z]+(\d+):[A-Z]+(\d+)$/.exec(String(updatedRange || ""));
  if (!match) return null;
  return { first: Number(match[1]), last: Number(match[2]) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Uzum'ning haqiqiy tezlik-limiti (token-bucket: 2/soniya) — cancelSync bilan
// bir xil tanaffusdan foydalanamiz, chunki bu bitta umumiy API cheklovi.
const REQUEST_DELAY_MS = config.cancelSync?.requestDelayMs || 600;

// Uzum'dan CREATED holatidagi yangi buyurtmalarni olib, uzum_order/
// uzum_order_detail'ga qo'shadi. uzbuyo@gmail.com OAuth akkaunti nomidan
// yozadi (service account emas) — qolgan barcha o'qish/yozishlar hamon
// service account orqali (index.js).
async function run() {
  let sheets;
  try {
    sheets = getSheetsClient();
  } catch (e) {
    logger.error(`Uzum import o'tkazib yuborildi (oauth.json topilmadi/noto'g'ri): ${e.message}`);
    return;
  }

  let cabinets;
  try {
    cabinets = parseCabinets(process.env);
  } catch (e) {
    logger.error(`Uzum import o'tkazib yuborildi: ${e.message}`);
    return;
  }
  const shopTokens = buildShopTokenMap(cabinets);

  const spreadsheetId = config.spreadsheetId;
  const ordersSheetName = config.sheets.orders;
  const detailsSheetName = config.sheets.details;

  const { data } = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: [ordersSheetName, detailsSheetName],
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const orders = data.valueRanges[0].values || [];
  const details = data.valueRanges[1].values || [];

  const existingOrderIds = new Set();
  for (let i = 1; i < orders.length; i++) {
    if (orders[i][0]) existingOrderIds.add(String(orders[i][0]));
  }

  const existingItemIds = new Set();
  for (let i = 1; i < details.length; i++) {
    if (details[i][0]) existingItemIds.add(String(details[i][0]));
  }

  const newOrdersBatch = [];
  const newItemsBatch = [];
  const newLabelTargets = [];   // {orderId, shopToken} — label oldindan olish uchun

  for (const [shopId, shopToken] of shopTokens) {
    let page = 0;

    while (true) {
      const pageOrders = await fetchOrdersPage({
        shopId,
        shopToken,
        status: "CREATED",
        page,
      });

      if (pageOrders === null) {
        logger.error(`Uzum'dan yangi buyurtmalarni olishda xato (shop ${shopId}, sahifa ${page}) — bu do'kon uchun to'xtatildi.`);
        break;
      }
      if (pageOrders.length === 0) break;

      for (const o of pageOrders) {
        const orderId = String(o.id);
        if (!existingOrderIds.has(orderId)) {
          newOrdersBatch.push([
            o.id,
            o.status,
            o.dateCreated,
            o.acceptUntil,
            o.deliverUntil,
            o.price,
            o.shopId,
            o.stock?.title || "",
            o.stock?.address || "",
            o.place || "",
            o.invoiceNumber || "",
            o.dropOffPoint?.address || "",
            o.scheme || "",
          ]);
          existingOrderIds.add(orderId);
          newLabelTargets.push({ orderId, shopToken });
        }

        for (const it of o.orderItems || []) {
          const itemId = String(it.id);
          if (itemId && !existingItemIds.has(itemId)) {
            newItemsBatch.push([
              it.id,
              it.barcode || "",
              it.skuTitle || "",
              it.title || "",
              it.price || "",
              it.amount || "",
              it.photo?.photo?.["720"]?.high || "",
              o.id,
            ]);
            existingItemIds.add(itemId);
          }
        }
      }

      page++;
      await sleep(REQUEST_DELAY_MS);
    }
  }

  if (isDryRun()) {
    logger.info(
      `[DRY_RUN] Uzum import: ${newOrdersBatch.length} ta yangi buyurtma, ${newItemsBatch.length} ta yangi item qo'shilardi (order ID'lar: ${newOrdersBatch.map((r) => r[0]).join(", ") || "yo'q"}).`
    );
    return;
  }

  if (newOrdersBatch.length > 0) {
    const appendRes = await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${ordersSheetName}!A:M`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: newOrdersBatch },
    });

    // W (buyurtma tushgan vaqt) ustunini alohida yozamiz — A:M append'iga
    // qo'shib bo'lmaydi, chunki M va W orasidagi ustunlarda (O/P/R va h.k.)
    // sheet formulalari bor, ularni bo'sh qiymat bilan bosib yubormasligimiz
    // kerak. append qaytargan updatedRange orqali qaysi qatorlar qo'shilganini
    // aniqlab, faqat shu qatorlarning W kataklariga vaqt-belgi yozamiz.
    const rowRange = parseAppendedRowRange(appendRes?.data?.updates?.updatedRange);
    if (rowRange) {
      // W-yozuvi tushsa ham qolgan tsikl (MoySklad yaratish, cancelSync va h.k.)
      // to'xtamasligi kerak — W bo'lmasa cancelSync C (dateCreated) ga tayanadi.
      try {
        const now = tashkentNowString();
        const wValues = [];
        for (let r = rowRange.first; r <= rowRange.last; r++) wValues.push([now]);
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${ordersSheetName}!${ARRIVED_AT_COL}${rowRange.first}:${ARRIVED_AT_COL}${rowRange.last}`,
          valueInputOption: "RAW",
          requestBody: { values: wValues },
        });
      } catch (e) {
        logger.error(`W ustunini yozishda xato (tsikl davom etadi): ${e.message}`);
      }
    } else {
      logger.error("W ustunini yozib bo'lmadi: append javobida updatedRange topilmadi.");
    }
  }

  if (newItemsBatch.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${detailsSheetName}!A:H`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: newItemsBatch },
    });
  }

  // Label pre-fetch: yangi orderlar labelini oldindan shared cache'ga olamiz.
  // Shunda uzumpdfs generatsiyasi Uzum'ga urmaydi (429 kamayadi, tez bo'ladi).
  let labelsFetched = 0;
  for (const { orderId, shopToken } of newLabelTargets) {
    try {
      if (await cacheLabel(shopToken, orderId)) labelsFetched++;
    } catch (e) {
      logger.error(`Label cache xato (order ${orderId}): ${e.message}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }
  if (newLabelTargets.length) {
    logger.info(`Label cache: ${labelsFetched}/${newLabelTargets.length} ta yangi label olindi.`);
  }

  logger.info(`Uzum import: ${newOrdersBatch.length} ta yangi buyurtma, ${newItemsBatch.length} ta yangi item qo'shildi.`);
}

module.exports = { run };
