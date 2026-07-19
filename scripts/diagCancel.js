// Bekor qilish monitoringini diagnostika qilish (FAQAT O'QIYDI — hech narsa
// yozmaydi/xabar bermaydi). Berilgan order ID'lar uchun sheet holati + jonli
// Uzum statusini ko'rsatadi va umumiy poll sonini vaqt byudjeti bilan solishtiradi.
//
//   node scripts/diagCancel.js 117808968 117769714 117755847 117694681
require("dotenv").config();
const config = require("../config.json");
const { getSheetsClient } = require("../src/oauthSheets");
const { colLetterToIndex, parseSheetTimeToEpochMs } = require("../src/sheetsUtil");
const { getOrderStatus } = require("../src/uzumApi");
const { parseCabinets, buildShopTokenMap } = require("../src/uzumCabinets");

const ORD = Object.fromEntries(
  Object.entries(config.columns.orders).map(([k, v]) => [k, colLetterToIndex(v)])
);
const ids = process.argv.slice(2).map(String);

const MONITOR_WINDOW_MS = (config.cancelSync?.monitorWindowHours || 24) * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const TZ = 5 * 3600 * 1000;
function tashkentWeekday(ms) { return new Date(ms + TZ).getUTCDay(); }
function monitorDeadline(a) { let d = a + MONITOR_WINDOW_MS; if (tashkentWeekday(d) === 0) d += DAY_MS; return d; }
function saneArrival(ms) { return ms != null && ms >= Date.UTC(2020, 0, 1) ? ms : null; }

(async () => {
  const sheets = getSheetsClient();
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: config.sheets.orders,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const rows = data.values || [];
  const shopTokens = buildShopTokenMap(parseCabinets(process.env));
  const now = Date.now();

  let q1 = 0, hold = 0, wouldPoll = 0, wouldFlag = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[ORD.orderId] || r[ORD.status] != 1 || r[ORD.cancelHandled] == 1) continue;
    q1++;
    if (r[ORD.mcState] === "hold") { hold++; continue; }
    const sane = saneArrival(parseSheetTimeToEpochMs(r[ORD.arrivedAt]) ?? parseSheetTimeToEpochMs(r[ORD.dateCreated]));
    if (sane != null && now > monitorDeadline(sane)) wouldFlag++;
    else wouldPoll++;
  }

  const delay = Number(config.cancelSync?.requestDelayMs || 1000);
  const budgetMs = Number(config.cancelSync?.run?.maxDurationMs || 60000);
  const perCycle = Math.floor(budgetMs / (delay + 300));

  console.log("\n=== UMUMIY HOLAT ===");
  console.log(`Q=1 & V bo'sh jami: ${q1}  |  hold (11:01 promotion kutmoqda): ${hold}`);
  console.log(`Har tsiklda Uzum'ga so'raladigan (poll): ${wouldPoll}  |  avtomatik yopiladigan: ${wouldFlag}`);
  console.log(`~1 tsiklda byudjetga sig'adigan poll: ~${perCycle} ta`);
  if (wouldPoll > perCycle) {
    console.log(`⚠️  POLL (${wouldPoll}) > byudjet (${perCycle}) — pastdagi buyurtmalar HAR TSIKLDA tekshirilmay qolyapti (throughput muammosi).`);
  } else {
    console.log(`OK — barcha pollar bitta tsiklda sig'adi.`);
  }

  console.log("\n=== BERILGAN BUYURTMALAR ===");
  for (const id of ids) {
    let idx = -1;
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][ORD.orderId]) === id) { idx = i; break; }
    }
    if (idx === -1) { console.log(`${id}: SHEETDA TOPILMADI`); continue; }
    const r = rows[idx];
    const sane = saneArrival(parseSheetTimeToEpochMs(r[ORD.arrivedAt]) ?? parseSheetTimeToEpochMs(r[ORD.dateCreated]));
    const ageH = sane ? ((now - sane) / 3600000).toFixed(1) : "?";
    const past = sane != null ? now > monitorDeadline(sane) : false;
    const shopId = String(r[ORD.shopId] ?? "");
    const tok = shopTokens.get(shopId);
    let uzum = tok ? "?" : `TOKEN YO'Q (shop ${shopId})`;
    if (tok) {
      try { const o = await getOrderStatus({ shopToken: tok, orderId: id }); uzum = o?.status || "null"; }
      catch (e) { uzum = "XATO: " + e.message; }
    }
    console.log(
      `${id}: satr=${idx + 1} Q=${r[ORD.status] ?? ""} V=${r[ORD.cancelHandled] ?? ""} ` +
      `mcState=${r[ORD.mcState] || "-"} S=${r[ORD.moySkladId] ? "bor" : "YO'Q"} shop=${shopId} ` +
      `yosh=${ageH}soat muddat_o'tgan=${past} Uzum=${uzum}`
    );
  }
  process.exit(0);
})().catch((e) => { console.error("DIAG XATO:", e.stack || e.message); process.exit(1); });
