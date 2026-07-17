require("dotenv").config();

const http = require("http");
const config = require("../config.json");
const logger = require("./logger");
const { getSheetsClient } = require("./oauthSheets");
const { cancelOrder } = require("./uzumApi");
const { parseCabinets, buildShopTokenMap } = require("./uzumCabinets");
const { colLetterToIndex } = require("./sheetsUtil");
const { isDryRun } = require("./dryRun");

/*
 * ============ MoySklad -> Uzum bekor qilish servisi (5-band) ============
 * MoySklad'da operator buyurtmani bekor qilganda, MoySklad script bu servisga
 * customerorder href/id'sini POST qiladi. Servis:
 *   1. uzum_order!S (moySkladId) ustunidan mos qatorni topadi,
 *   2. o'sha qatordagi Uzum orderId (A) va shopId (G) orqali buyurtmani
 *      Uzum'da CANCELED holatiga o'tkazadi (allaqachon bekor qilingan bo'lsa —
 *      muvaffaqiyat deb hisoblaydi),
 *   3. Telegram'ga HECH NARSA yubormaydi,
 *   4. uzum_order!V (cancelHandled) bo'sh bo'lsa 1 qilib qo'yadi.
 *
 * uzumOrderToMC bilan bir xil modullardan (config, oauth, uzumApi, .env
 * kabinetlari) foydalanadi. Doimiy ishlaydigan alohida process (2 daqiqalik
 * cron'dan mustaqil). Port: MC_CANCEL_PORT yoki config.mcCancelServer.port.
 */

const ORD = Object.fromEntries(
  Object.entries(config.columns.orders).map(([k, v]) => [k, colLetterToIndex(v)])
);

const PORT = Number(process.env.MC_CANCEL_PORT || config.mcCancelServer?.port || 4042);
const ENDPOINT = config.mcCancelServer?.path || "/mc-cancel";
const REQUEST_DELAY_MS = config.cancelSync?.requestDelayMs || 600;
const CACHE_TTL_MS = 15000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

const CANCELHANDLED_COL = config.columns.orders.cancelHandled;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cell(value) {
  return value === undefined || value === null ? "" : value;
}

// --- customerorder id ni so'rovdan ajratish (receiveMCPost bilan bir xil) ---
function orderIdFromEvent(ev) {
  if (!ev || typeof ev !== "object") return null;
  const id = ev.id || (ev.meta && ev.meta.href ? ev.meta.href.split("/").pop() : null);
  const type = ev.type || (ev.meta ? ev.meta.type : null);
  if (!id || !type || String(type).toLowerCase() !== "customerorder") return null;
  return String(id);
}

function extractOrderIds(query, body) {
  const ids = [];

  // 1) URL query (?id=...&type=customerorder yoki type kelmasa ham qabul)
  if (query && query.get("id")) {
    const type = query.get("type");
    if (!type || String(type).toLowerCase() === "customerorder") {
      ids.push(String(query.get("id")));
    }
  }

  // 2) JSON body: MoySklad events[] yoki tekis obyekt
  if (body && typeof body === "object") {
    const events = Array.isArray(body.events) ? body.events : [body];
    for (const ev of events) {
      const id = orderIdFromEvent(ev);
      if (id) ids.push(id);
    }
  }

  return [...new Set(ids)];
}

// --- uzum_order qisqa muddatli keshi (bursda qayta-qayta o'qimaslik uchun) ---
let cache = { rows: null, at: 0 };

async function loadOrders(sheets) {
  if (cache.rows && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: config.sheets.orders,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  cache.rows = data.values || [];
  cache.at = Date.now();
  return cache.rows;
}

// Bitta MoySklad customerorder id'sini qayta ishlash. Qator topilmasa (kesh
// eskirgan bo'lishi mumkin) bir marta keshni yangilab qayta urinadi.
async function processCustomerOrder(sheets, shopTokens, mcId, allowReload = true) {
  const rows = await loadOrders(sheets);

  let rowIndex = -1;
  for (let i = 1; i < rows.length; i++) {
    if (String(cell(rows[i][ORD.moySkladId])) === String(mcId)) {
      rowIndex = i;
      break;
    }
  }
  if (rowIndex === -1) {
    if (allowReload) {
      // Kesh eskirgan bo'lishi mumkin — majburan yangilab bir marta qayta urinamiz.
      cache = { rows: null, at: 0 };
      return processCustomerOrder(sheets, shopTokens, mcId, false);
    }
    logger.error(`MC cancel: customerorder ${mcId} uchun uzum_order!S da mos qator topilmadi.`);
    return "not_found";
  }

  const row = rows[rowIndex];
  const uzumOrderId = row[ORD.orderId];
  const shopId = String(cell(row[ORD.shopId]));
  const shopToken = shopTokens.get(shopId);
  if (!uzumOrderId) {
    logger.error(`MC cancel: customerorder ${mcId} qatorida Uzum orderId (A) yo'q.`);
    return "no_order_id";
  }
  if (!shopToken) {
    logger.error(`MC cancel: order ${uzumOrderId} uchun shop ${shopId} tokeni topilmadi (.env UZUM_SHOP_*).`);
    return "no_token";
  }

  if (isDryRun()) {
    logger.info(`[DRY_RUN] MC cancel: order ${uzumOrderId} Uzum'da bekor qilinardi va V=1 qilinardi.`);
    return "dry_run";
  }

  const { alreadyCanceled } = await cancelOrder({ shopToken, orderId: uzumOrderId });

  // V (cancelHandled) bo'sh bo'lsa 1 qilib qo'yamiz — shunda 24h monitoring
  // (cancelSync) bu buyurtmani qayta ko'rib Telegram xabari yubormaydi.
  if (row[ORD.cancelHandled] != 1) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.spreadsheetId,
      range: `${config.sheets.orders}!${CANCELHANDLED_COL}${rowIndex + 1}`,
      valueInputOption: "RAW",
      requestBody: { values: [[1]] },
    });
    row[ORD.cancelHandled] = 1;
  }

  logger.info(
    `MC cancel: order ${uzumOrderId} (customerorder ${mcId}) ` +
      (alreadyCanceled ? "Uzum'da allaqachon bekor qilingan edi" : "Uzum'da bekor qilindi") +
      ", V=1."
  );
  return alreadyCanceled ? "already_canceled" : "canceled";
}

function parseCabinetsSafe() {
  try {
    return buildShopTokenMap(parseCabinets(process.env));
  } catch (e) {
    logger.error(`Uzum kabinetlarini o'qishda xato: ${e.message}`);
    return new Map();
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("So'rov tanasi juda katta"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    res.writeHead(400).end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "mc->uzum cancel", port: PORT, endpoint: ENDPOINT }));
    return;
  }

  if (req.method !== "POST" || url.pathname !== ENDPOINT) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: "not found" }));
    return;
  }

  try {
    const raw = await readBody(req);
    let body = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = null; // JSON bo'lmasa query'ga tayanamiz
      }
    }

    const ids = extractOrderIds(url.searchParams, body);
    if (ids.length === 0) {
      logger.error("MC cancel: so'rovda customerorder id topilmadi.");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, accepted: 0 }));
      return;
    }

    const sheets = getSheetsClient();
    const shopTokens = parseCabinetsSafe();

    const results = [];
    for (const id of ids) {
      try {
        results.push({ id, result: await processCustomerOrder(sheets, shopTokens, id) });
      } catch (e) {
        logger.error(`MC cancel: customerorder ${id} qayta ishlashda xato: ${e.message}`);
        results.push({ id, result: "error", error: e.message });
      }
      await sleep(REQUEST_DELAY_MS);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, accepted: ids.length, results }));
  } catch (e) {
    logger.error(`MC cancel: so'rovni qayta ishlashda xato: ${e.message}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: e.message }));
  }
});

server.listen(PORT, () => {
  logger.info(`MoySklad->Uzum bekor qilish servisi ${PORT} portda ishlayapti (endpoint: ${ENDPOINT}).`);
});
