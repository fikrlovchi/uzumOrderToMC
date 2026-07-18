// Uzum label'larni umumiy (shared) papkaga cache qiladi.
// uzumpdfs generatsiya paytida shu papkadan o'qiydi (Uzum'ga urmasdan).
// Serverda LABEL_CACHE_DIR ikkala servisda bir xil bo'lishi kerak.
const fs = require("fs");
const path = require("path");
const logger = require("./logger");
const { fetchLabel } = require("./uzumApi");

const LABELS_DIR = process.env.LABEL_CACHE_DIR || path.join(process.cwd(), "labels");
if (!fs.existsSync(LABELS_DIR)) fs.mkdirSync(LABELS_DIR, { recursive: true });

// orderId label'ini cache'ga saqlaydi (agar hali yo'q bo'lsa). true = yangi olindi.
async function cacheLabel(shopToken, orderId) {
  const p = path.join(LABELS_DIR, `${orderId}.pdf`);
  if (fs.existsSync(p)) return false;
  const b64 = await fetchLabel({ shopToken, orderId });
  if (!b64) {
    logger.error(`Label olinmadi: order ${orderId}`);
    return false;
  }
  fs.writeFileSync(p, Buffer.from(b64, "base64"));
  return true;
}

module.exports = { cacheLabel, LABELS_DIR };
