// BIR MARTALIK to'liq sweep: barcha Q=1 & V bo'sh (hold emas) buyurtmalarni
// vaqt byudjetisiz tekshiradi. CANCELED bo'lsa — Telegram'ga (bekor guruhiga,
// teglar bilan) xabar beradi va V=1 qiladi; monitoring muddati o'tganini
// avtomatik V=1 qiladi. Katta backlogni darhol tozalash uchun.
//
//   node scripts/sweepCancel.js
require("dotenv").config();
const config = require("../config.json");
const logger = require("../src/logger");
const { getSheetsClient } = require("../src/oauthSheets");
const { colLetterToIndex, parseSheetTimeToEpochMs } = require("../src/sheetsUtil");
const { getOrderStatus } = require("../src/uzumApi");
const { parseCabinets, buildShopTokenMap } = require("../src/uzumCabinets");
const { sendTelegramMessage } = require("../src/telegram");

const ORD = Object.fromEntries(
  Object.entries(config.columns.orders).map(([k, v]) => [k, colLetterToIndex(v)])
);
const ordersSheetName = config.sheets.orders;
const cancelHandledCol = config.columns.orders.cancelHandled;
const REQUEST_DELAY_MS = config.cancelSync?.requestDelayMs || 1000;
const MONITOR_WINDOW_MS = (config.cancelSync?.monitorWindowHours || 24) * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const TZ = 5 * 3600 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tashkentWeekday(ms) { return new Date(ms + TZ).getUTCDay(); }
function monitorDeadline(a) { let d = a + MONITOR_WINDOW_MS; if (tashkentWeekday(d) === 0) d += DAY_MS; return d; }
function saneArrival(ms) { return ms != null && ms >= Date.UTC(2020, 0, 1) ? ms : null; }
function escapeHtml(v) { return String(v).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

function notifyTags() {
  return (process.env.CANCEL_NOTIFY_CONTACTS || "")
    .split(",").map((e) => e.trim()).filter(Boolean)
    .map((e) => { const [name, id] = e.split(":").map((s) => s.trim()); return name && id ? `<a href="tg://user?id=${id}">${escapeHtml(name)}</a>` : null; })
    .filter(Boolean).join(" ");
}

async function notifyCancellation(orderId) {
  const tags = notifyTags();
  return sendTelegramMessage({
    text: `❌ Buyurtma bekor qilindi: ${escapeHtml(orderId)}${tags ? "\n" + tags : ""}`,
    parseMode: "HTML",
  });
}

(async () => {
  const sheets = getSheetsClient();
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: ordersSheetName,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = data.values || [];
  const shopTokens = buildShopTokenMap(parseCabinets(process.env));
  const now = Date.now();
  const updates = [];
  let checked = 0, canceled = 0, flagged = 0, errors = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const orderId = row[ORD.orderId];
    if (!orderId || row[ORD.status] != 1 || row[ORD.cancelHandled] == 1) continue;
    if (row[ORD.mcState] === "hold") continue;

    const arrivedMs = saneArrival(parseSheetTimeToEpochMs(row[ORD.arrivedAt]) ?? parseSheetTimeToEpochMs(row[ORD.dateCreated]));
    if (arrivedMs != null && now > monitorDeadline(arrivedMs)) {
      updates.push({ range: `${ordersSheetName}!${cancelHandledCol}${i + 1}`, values: [[1]] });
      flagged++;
      continue;
    }

    const shopId = String(row[ORD.shopId] ?? "");
    const shopToken = shopTokens.get(shopId);
    if (!shopToken) { errors++; logger.error(`SWEEP: order ${orderId} shop ${shopId} tokeni yo'q`); continue; }

    checked++;
    try {
      const o = await getOrderStatus({ shopToken, orderId });
      if (o && o.status === "CANCELED") {
        await notifyCancellation(orderId);
        updates.push({ range: `${ordersSheetName}!${cancelHandledCol}${i + 1}`, values: [[1]] });
        canceled++;
        console.log(`  ❌ ${orderId} bekor — xabar berildi, V=1`);
      }
    } catch (e) {
      errors++;
      logger.error(`SWEEP: order ${orderId} tekshirishda xato: ${e.message}`);
    }
    if (checked % 20 === 0) console.log(`  ... ${checked} tekshirildi (${canceled} bekor)`);
    await sleep(REQUEST_DELAY_MS);
  }

  if (updates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: { valueInputOption: "RAW", data: updates },
    });
  }
  console.log(`\nSWEEP tugadi: ${checked} tekshirildi, ${canceled} bekor topildi, ${flagged} muddat o'tgani avtoyopildi, ${errors} xato.`);
  process.exit(0);
})().catch((e) => { console.error("SWEEP XATO:", e.stack || e.message); process.exit(1); });
