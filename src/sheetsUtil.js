// A -> 0, B -> 1, ..., Z -> 25, AA -> 26, ...
function colLetterToIndex(letter) {
  let index = 0;
  for (const ch of letter.toUpperCase()) {
    index = index * 26 + (ch.charCodeAt(0) - 64);
  }
  return index - 1;
}

const SHEETS_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);

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

module.exports = { colLetterToIndex, formatDateTimeGMT5 };
