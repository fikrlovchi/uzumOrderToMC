require("dotenv").config();

const path = require("path");
const { google } = require("googleapis");
const config = require("../config.json");
const { colLetterToIndex, formatDateTimeGMT5 } = require("./sheetsUtil");
const logger = require("./logger");
const reporter = require("./reporter");

const ORD = Object.fromEntries(
  Object.entries(config.columns.orders).map(([k, v]) => [k, colLetterToIndex(v)])
);
const DET = Object.fromEntries(
  Object.entries(config.columns.details).map(([k, v]) => [k, colLetterToIndex(v)])
);

const MOYSKLAD_ORDER_URL = "https://api.moysklad.ru/api/remap/1.2/entity/customerorder";

function cell(value) {
  return value === undefined || value === null ? "" : value;
}

function toHref(raw, entityType) {
  const value = cell(raw).toString().trim();
  if (value.includes("https://")) return value.replace("online.moysklad.ru", "api.moysklad.ru");
  return `https://api.moysklad.ru/api/remap/1.2/entity/${entityType}/${value}`;
}

// Detects XLOOKUP/VLOOKUP-style error text (e.g. "#N/A (Did not find value ...)")
// that can end up in the product-ref cell when a SKU has no mapping yet.
function isUsableRef(raw) {
  const value = cell(raw).toString().trim();
  if (!value) return false;
  if (value.startsWith("#")) return false;
  return true;
}

function buildPositions(details, orderId) {
  const positions = [];
  for (let j = 1; j < details.length; j++) {
    const row = details[j];
    if (cell(row[DET.orderId]).toString().trim() !== orderId.toString().trim()) continue;

    if (!isUsableRef(row[DET.product])) {
      throw new Error(`mahsulot ID/link topilmadi (detail qator ${j + 1}): "${cell(row[DET.product])}"`);
    }

    let entityType = cell(row[DET.entityType]).toString().trim().toLowerCase() || "product";
    const prodHref = toHref(row[DET.product], entityType);

    positions.push({
      quantity: parseFloat(row[DET.quantity]),
      price: parseFloat(row[DET.price]) * 100,
      reserve: entityType === "service" ? 0 : 1,
      assortment: {
        meta: { href: prodHref, type: entityType, mediaType: "application/json" },
      },
    });
  }
  return positions;
}

function buildPayload(order, orderId, trackingNumber, positions, mc) {
  const orgHref = toHref(order[ORD.organization], "organization");
  const channelHref = toHref(order[ORD.salesChannel], "saleschannel");
  const deliveryPlannedMoment = formatDateTimeGMT5(order[ORD.date]);

  return {
    name: orderId.toString(),
    externalCode: orderId.toString(),
    shipmentAddress: cell(order[ORD.shipmentAddress]).toString(),
    deliveryPlannedMoment,
    organization: { meta: { href: orgHref, type: "organization", mediaType: "application/json" } },
    agent: { meta: { href: mc.agentHref, type: "counterparty", mediaType: "application/json" } },
    store: { meta: { href: mc.storeHref, type: "store", mediaType: "application/json" } },
    salesChannel: { meta: { href: channelHref, type: "saleschannel", mediaType: "application/json" } },
    attributes: [
      {
        meta: { href: mc.deliveryTypeAttr, type: "attributemetadata", mediaType: "application/json" },
        value: { meta: { href: mc.deliveryValue, type: "customentity", mediaType: "application/json" }, name: "Uzum" },
      },
      {
        meta: { href: mc.orderNumAttr, type: "attributemetadata", mediaType: "application/json" },
        value: orderId.toString(),
      },
      {
        meta: { href: mc.trackingAttr, type: "attributemetadata", mediaType: "application/json" },
        value: trackingNumber,
      },
    ],
    positions,
  };
}

async function markRowSent(sheets, spreadsheetId, ordersSheetName, rowNumber, moySkladId) {
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: [
        { range: `${ordersSheetName}!Q${rowNumber}`, values: [[1]] },
        { range: `${ordersSheetName}!S${rowNumber}`, values: [[moySkladId]] },
      ],
    },
  });
}

function deriveStatus(successCount, errorCount) {
  if (errorCount === 0) return "success";
  if (successCount === 0) return "error";
  return "partial";
}

async function createMoySkladOrders() {
  const startedAt = new Date().toISOString();
  let successCount = 0;
  let errorCount = 0;

  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, "..", config.credentialsPath),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = config.spreadsheetId;
  const ordersSheetName = config.sheets.orders;
  const detailsSheetName = config.sheets.details;

  const { data } = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: [ordersSheetName, detailsSheetName, config.sheets.tokenCell],
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const orders = data.valueRanges[0].values || [];
  const details = data.valueRanges[1].values || [];
  const token = cell(data.valueRanges[2].values?.[0]?.[0]).toString().trim();

  if (!token) {
    throw new Error(`Token topilmadi (${config.sheets.tokenCell} bo'sh)`);
  }

  for (let i = 1; i < orders.length; i++) {
    const order = orders[i];
    const orderId = order[ORD.orderId];
    const status = order[ORD.status];
    const trackingNumber = cell(order[ORD.trackingNumber]).toString();

    if (status == 1 || !orderId) continue;

    let positions;
    try {
      positions = buildPositions(details, orderId);
    } catch (e) {
      logger.error(`Order ${orderId} o'tkazib yuborildi: ${e.message}`);
      errorCount++;
      continue;
    }
    if (positions.length === 0) {
      logger.info(`Order ${orderId} uchun pozitsiyalar topilmadi.`);
      continue;
    }

    const payload = buildPayload(order, orderId, trackingNumber, positions, config.moysklad);

    try {
      const response = await fetch(MOYSKLAD_ORDER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify(payload),
      });
      const resText = await response.text();

      if (response.status === 200 || response.status === 201) {
        const moySkladId = JSON.parse(resText).id;
        await markRowSent(sheets, spreadsheetId, ordersSheetName, i + 1, moySkladId);
        logger.info(`Order ${orderId} muvaffaqiyatli yaratildi (${moySkladId}).`);
        successCount++;
      } else {
        logger.error(`Order ${orderId} xatolik: ${resText}`);
        errorCount++;
      }
    } catch (e) {
      logger.error(`Order ${orderId} texnik xato: ${e.message}`);
      errorCount++;
    }
  }

  return { startedAt, successCount, errorCount };
}

createMoySkladOrders()
  .then(async ({ startedAt, successCount, errorCount }) => {
    logger.info("Ish yakunlandi.");
    await reporter.reportRun({
      startedAt,
      status: deriveStatus(successCount, errorCount),
      successCount,
      errorCount,
      summary: `${successCount} muvaffaqiyat, ${errorCount} xato`,
    });
  })
  .catch(async (e) => {
    logger.error(`Umumiy xato: ${e.stack || e.message}`);
    process.exitCode = 1;
    await reporter.reportRun({
      startedAt: new Date().toISOString(),
      status: "error",
      successCount: 0,
      errorCount: 1,
      summary: e.message,
    });
  });
