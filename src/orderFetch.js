const config = require("../config.json");
const logger = require("./logger");
const { getSheetsClient } = require("./oauthSheets");
const { fetchOrdersPage } = require("./uzumApi");
const { parseCabinets, buildShopTokenMap } = require("./uzumCabinets");
const { isDryRun } = require("./dryRun");

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
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${ordersSheetName}!A:M`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: newOrdersBatch },
    });
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

  logger.info(`Uzum import: ${newOrdersBatch.length} ta yangi buyurtma, ${newItemsBatch.length} ta yangi item qo'shildi.`);
}

module.exports = { run };
