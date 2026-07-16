const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

// Date.now() har doim UTC epoch millisekund qaytaradi (server TZ sozlamasidan
// qat'i nazar), shuning uchun bu +5:00 qo'shish serverning mahalliy vaqt
// zonasidan mustaqil ishlaydi. O'zbekistonda DST yo'q, shuning uchun qo'shimcha
// kutubxona kerak emas.
function tashkentMinutesNow() {
  const tashkentMs = Date.now() + TASHKENT_OFFSET_MS;
  const date = new Date(tashkentMs);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function parseHHMM(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) throw new Error(`Vaqt formati noto'g'ri (HH:mm kutilgan): "${value}"`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours * 60 + minutes;
}

// Yarim ochiq oraliq: [startMin, endMin). "Ichida"/"tashqarida" tekshiruvlari
// har doim shu bitta funksiyaning natijasi va uning inkori orqali olinishi
// kerak — ikkita alohida yozilgan shart hech qachon bir-biriga zid kelmasligi
// uchun.
function isInHoldWindow(nowMin, startMin, endMin) {
  if (endMin <= startMin) {
    throw new Error(
      `WINDOW_HOLD_END (${endMin}) WINDOW_HOLD_START (${startMin}) dan katta bo'lishi kerak (yarim tunni kesib o'tuvchi oraliq hali qo'llab-quvvatlanmaydi)`
    );
  }
  return nowMin >= startMin && nowMin < endMin;
}

module.exports = { tashkentMinutesNow, parseHHMM, isInHoldWindow };
