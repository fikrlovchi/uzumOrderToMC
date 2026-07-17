// A -> 0, B -> 1, ..., Z -> 25, AA -> 26, ...
function colLetterToIndex(letter) {
  let index = 0;
  for (const ch of letter.toUpperCase()) {
    index = index * 26 + (ch.charCodeAt(0) - 64);
  }
  return index - 1;
}

const SHEETS_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

// Hozirgi Toshkent vaqti "yyyy-MM-dd HH:mm:ss" ko'rinishida (receiveMCPost
// bilan bir xil format) — uzum_order!W (buyurtma tushgan vaqt) ustuniga
// yoziladi. Inson o'qiy oladigan format tanlangan, chunki eski qatorlar
// uchun foydalanuvchi qo'lda "eski" vaqt kiritishi mumkin bo'lishi kerak.
function tashkentNowString() {
  return new Date(Date.now() + TASHKENT_OFFSET_MS)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

// uzum_order!W qiymatini absolut UTC epoch-millisekundga aylantiradi (yosh
// hisoblash uchun). Uchta ko'rinishni qabul qiladi:
//  - "yyyy-MM-dd[ HH:mm[:ss]]" matn (Toshkent devor-soati deb talqin qilinadi),
//  - Sheets serial sana (kichik son, 1899-12-30 dan beri kunlar, devor-soati),
//  - epoch-ms (katta son, allaqachon absolut UTC).
// Qiymat bo'sh/tanib bo'lmaydigan bo'lsa null qaytaradi.
function parseSheetTimeToEpochMs(raw) {
  if (raw === undefined || raw === null || raw === "") return null;

  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    if (raw < 100000) {
      // Sheets serial (Toshkent devor-soati) -> absolut UTC
      return SHEETS_EPOCH_UTC_MS + raw * 86400 * 1000 - TASHKENT_OFFSET_MS;
    }
    return raw; // epoch-ms (UTC)
  }

  const s = String(raw).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (match) {
    const [, y, mo, d, h, mi, se] = match;
    return Date.UTC(+y, +mo - 1, +d, +(h || 0), +(mi || 0), +(se || 0)) - TASHKENT_OFFSET_MS;
  }

  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : parsed;
}

// The order date column in this sheet holds either:
//  - a native Sheets serial date (small number, days since 1899-12-30, naive
//    wall-clock value already in the spreadsheet's local time), or
//  - a raw Unix epoch-ms timestamp (large number, an absolute UTC instant) —
//    this is what a script-populated cell (setValue(number)) actually stores.
// Both must render as "yyyy-MM-dd HH:mm:ss" in GMT+5, matching the original
// Utilities.formatDate(new Date(dateRaw), "GMT+5", "yyyy-MM-dd HH:mm:ss").
function formatDateTimeGMT5(dateRaw) {
  const num = Number(dateRaw);
  const GMT5_OFFSET_MS = 5 * 3600 * 1000;

  // Native serial dates for any real-world date are well under 100000;
  // epoch-ms timestamps for the same dates are in the trillions.
  const shifted =
    num < 100000
      ? new Date(SHEETS_EPOCH_UTC_MS + num * 86400 * 1000)
      : new Date(num + GMT5_OFFSET_MS);

  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  );
}

module.exports = { colLetterToIndex, formatDateTimeGMT5, tashkentNowString, parseSheetTimeToEpochMs };
