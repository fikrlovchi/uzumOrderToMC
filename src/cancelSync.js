const fs = require("fs");
const path = require("path");
const config = require("../config.json");
const logger = require("./logger");
const { colLetterToIndex, parseSheetTimeToEpochMs } = require("./sheetsUtil");
const { getOrderStatus } = require("./uzumApi");
const { parseCabinets, buildShopTokenMap } = require("./uzumCabinets");
const { sendTelegramMessage } = require("./telegram");
const { isDryRun } = require("./dryRun");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Uzum'ning haqiqiy tezlik-limiti (token-bucket: 2/soniya) — boshqa
// modullar bilan bir xil tanaffus.
const REQUEST_DELAY_MS = config.cancelSync?.requestDelayMs || 600;
// Buyurtma tushganidan (W ustuni) shuncha soat o'tguncha Uzum'da har tsiklda
// bekor qilinganini tekshiramiz; o'tgach avtomatik cancelHandled=1 qilamiz.
const MONITOR_WINDOW_MS = (config.cancelSync?.monitorWindowHours || 24) * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
// Yakshanba (0) — ombor buyurtmalarni Uzum'ga jo'natmaydigan dam olish kuni.
const SKIP_WEEKDAY = 0;

// Toshkent vaqti bo'yicha hafta kuni (0=Yakshanba .. 6=Shanba).
function tashkentWeekday(ms) {
  return new Date(ms + TASHKENT_OFFSET_MS).getUTCDay();
}

// 24 soatlik monitoring muddati. Agar muddat Toshkent bo'yicha YAKSHANBA'ga
// to'g'ri kelsa, +1 kun (dushanbaga) suriladi: yakshanba kuni buyurtmalar
// omborga jo'natilmaydi, shuning uchun o'sha kun bekor bo'lganini hali ham
// kuzatib, Uzum'ga jo'natilishini oldini olishimiz kerak (aks holda ombor
// bekorligini bilmay jo'natadi -> ortiqcha logistika xarajati).
function monitorDeadline(arrivedMs) {
  let deadline = arrivedMs + MONITOR_WINDOW_MS;
  if (tashkentWeekday(deadline) === SKIP_WEEKDAY) deadline += DAY_MS;
  return deadline;
}

const ORD = Object.fromEntries(
  Object.entries(config.columns.orders).map(([k, v]) => [k, colLetterToIndex(v)])
);

function cell(value) {
  return value === undefined || value === null ? "" : value;
}

// 2020-01-01'gacha bo'lgan epoch qiymatlarni ishonchsiz deb null qaytaradi
// (noto'g'ri format/birlik natijasi) — shunda yangi buyurtma xato yosh bilan
// avtomatik yopilib qolmaydi.
const MIN_SANE_MS = Date.UTC(2020, 0, 1);
function saneArrival(ms) {
  return ms != null && ms >= MIN_SANE_MS ? ms : null;
}

// Round-robin kursor: tekshirilgan buyurtmalar soni bir tsikl byudjetidan ko'p
// bo'lsa (masalan 269 > 46), har tsiklda yuqoridan boshlanmasin — oxirgi
// to'xtagan buyurtmadan davom etsin. Shunda barcha buyurtmalar bir necha
// tsiklda navbat bilan to'liq tekshiriladi.
const CURSOR_FILE = path.join(__dirname, "..", "data", "cancelCursor.json");
function loadCursorId() {
  try {
    return JSON.parse(fs.readFileSync(CURSOR_FILE, "utf8")).lastOrderId || null;
  } catch {
    return null;
  }
}
function saveCursorId(lastOrderId) {
  try {
    fs.mkdirSync(path.dirname(CURSOR_FILE), { recursive: true });
    fs.writeFileSync(CURSOR_FILE, JSON.stringify({ lastOrderId: String(lastOrderId || "") }));
  } catch (e) {
    logger.error(`Bekor kursorini saqlashda xato: ${e.message}`);
  }
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

// 24 soatlik bekor qilish monitoringi (4-band). Q=1 (MoySklad'da yaratilgan)
// va V (cancelHandled) hali bo'sh bo'lgan har bir buyurtma uchun:
//  - mcState="hold" (oyna ichida ushlab turilgan) qatorlar O'TKAZIB YUBORILADI
//    — ularni 11:01 promotion (orderStatusSync.promoteHeldOrders / 3-band) hal
//    qiladi, shu bilan held-xabar va bu yerdagi teglangan xabar aralashmaydi.
//  - W (buyurtma tushgan vaqt) 24 soatdan oldin bo'lsa: Uzum'ga umuman so'rov
//    yubormasdan V=1 qilinadi (avtomatik yopiladi).
//  - W 24 soat ichida bo'lsa: Uzum'dan aynan shu buyurtmaning holatini so'raydi.
//    CANCELED bo'lsa — CANCEL_NOTIFY_CONTACTS odamlarini belgilab Telegram'ga
//    xabar beradi va V=1 qiladi. (MoySklad holati bu yerda o'zgartirilmaydi.)
async function run({ sheets, orders }) {
  const ordersSheetName = config.sheets.orders;
  const shopTokens = buildShopTokenMap(parseCabinetsSafe());
  const rowUpdates = [];
  let errorCount = 0;
  let checkedCount = 0;
  let canceledCount = 0;
  let autoFlaggedCount = 0;

  const now = Date.now();
  const runDeadline = now + (config.cancelSync?.run?.maxDurationMs || 60000);

  const n = orders.length - 1; // ma'lumot qatorlari (1..n)
  // Oxirgi tekshirilgan buyurtmadan keyin boshlaymiz (round-robin) — shunda
  // buyurtmalar soni bir tsikl byudjetidan ko'p bo'lsa ham hammasi navbat
  // bilan qamraladi, pastdagi yangi buyurtmalar tashlab ketilmaydi.
  const cursorId = loadCursorId();
  let startOffset = 0;
  if (cursorId) {
    for (let k = 1; k <= n; k++) {
      if (String(orders[k][ORD.orderId]) === String(cursorId)) {
        startOffset = k;
        break;
      }
    }
  }
  let lastExaminedId = cursorId;

  for (let step = 0; step < n; step++) {
    if (Date.now() > runDeadline) {
      logger.info("Bekor qilish tekshiruvi uchun vaqt byudjeti tugadi — qolgani keyingi tsiklda.");
      break;
    }

    const i = ((startOffset + step) % n) + 1; // kursordan keyin, aylanma tartib
    const row = orders[i];
    const orderId = row[ORD.orderId];
    const sentToMoySklad = row[ORD.status];
    const cancelHandled = row[ORD.cancelHandled];
    if (!orderId) continue;
    lastExaminedId = orderId; // kursor har bir ko'rilgan qatordan keyin suriladi
    if (sentToMoySklad != 1 || cancelHandled == 1) continue;
    // Hali oyna ichida ushlab turilgan buyurtmalar 11:01 promotion tomonidan
    // tekshiriladi (3-band) — bu yerda tegmaymiz.
    if (row[ORD.mcState] === "hold") continue;

    // Buyurtma tushgan vaqt (W); yo'q bo'lsa Uzum dateCreated (C) ga tayanamiz.
    // 2020'gacha bo'lgan qiymat ishonchsiz (masalan sekund-timestamp ms deb
    // noto'g'ri o'qilgan) — bunday holatda null deb hisoblab, avtomatik V=1
    // qilib qo'ymaymiz, xavfsizroq tomon: tekshirishda davom etamiz.
    const arrivedMs = saneArrival(
      parseSheetTimeToEpochMs(row[ORD.arrivedAt]) ?? parseSheetTimeToEpochMs(row[ORD.dateCreated])
    );

    // Monitoring muddati o'tgan buyurtma — Uzum'ga so'rov yubormasdan avtomatik
    // yopamiz. Muddat yakshanbaga tushsa dushanbagacha uzaytiriladi (yuqoriga q.)
    if (arrivedMs != null && now > monitorDeadline(arrivedMs)) {
      if (isDryRun()) {
        logger.info(`[DRY_RUN] Order ${orderId} 24 soatdan o'tgan — V=1 qilinardi.`);
      } else {
        markCancelHandled(orders, i, ordersSheetName, rowUpdates);
      }
      autoFlaggedCount++;
      continue;
    }

    const shopId = String(cell(row[ORD.shopId]));
    const shopToken = shopTokens.get(shopId);
    if (!shopToken) {
      logger.error(`Order ${orderId} uchun shop ${shopId} tokeni topilmadi (.env UZUM_SHOP_*) — bekor qilish tekshiruvi o'tkazib yuborildi.`);
      errorCount++;
      continue;
    }

    checkedCount++;

    try {
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

  // Keyingi tsikl shu joydan davom etsin.
  saveCursorId(lastExaminedId);

  if (rowUpdates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: { valueInputOption: "RAW", data: rowUpdates },
    });
  }

  logger.info(
    `Bekor qilish tekshiruvi: ${checkedCount} tekshirildi, ${canceledCount} bekor qilingan topildi, ` +
      `${autoFlaggedCount} 24 soatdan o'tgani avtomatik yopildi, ${errorCount} xato.`
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
