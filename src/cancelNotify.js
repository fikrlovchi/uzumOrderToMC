// Bekor qilingan buyurtma haqida boy (buyurtma IDsi + shop nomi + tarkibi)
// teglangan Telegram xabari. cancelSync (24h monitoring) va orderStatusSync
// (tasdiqlashdan oldin bekor bo'lgan holat) shu moduldan foydalanadi.
const config = require("../config.json");
const logger = require("./logger");
const { colLetterToIndex } = require("./sheetsUtil");
const { getSheetsClient } = require("./oauthSheets");
const { sendTelegramMessage } = require("./telegram");

const DET = Object.fromEntries(
  Object.entries(config.columns.details).map(([k, v]) => [k, colLetterToIndex(v)])
);
const SHOP = {
  shopId: colLetterToIndex(config.columns.shops.shopId),
  name: colLetterToIndex(config.columns.shops.name),
};
const PROD = {
  ref: colLetterToIndex(config.columns.products.ref),
  name: colLetterToIndex(config.columns.products.name),
};

// uzum_shop (shopId->nom) va mc_product (ref->nom) xaritalari faqat xabar
// yuborilganda (kamdan-kam) bir marta o'qiladi va process davomida keshlanadi.
let shopNames = null;
let productNames = null;

async function readSheet(range) {
  const sheets = getSheetsClient();
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  return data.values || [];
}

async function loadShopNames() {
  if (shopNames) return shopNames;
  shopNames = new Map();
  try {
    const rows = await readSheet(config.sheets.shops);
    for (let i = 1; i < rows.length; i++) {
      const id = rows[i][SHOP.shopId];
      if (id !== undefined && id !== null && id !== "") {
        shopNames.set(String(id), String(rows[i][SHOP.name] ?? ""));
      }
    }
  } catch (e) {
    logger.error(`uzum_shop nomlarini o'qishda xato: ${e.message}`);
  }
  return shopNames;
}

async function loadProductNames() {
  if (productNames) return productNames;
  productNames = new Map();
  try {
    const rows = await readSheet(config.sheets.products);
    for (let i = 1; i < rows.length; i++) {
      const ref = rows[i][PROD.ref];
      if (ref !== undefined && ref !== null && ref !== "") {
        productNames.set(String(ref).trim(), String(rows[i][PROD.name] ?? ""));
      }
    }
  } catch (e) {
    logger.error(`mc_product nomlarini o'qishda xato: ${e.message}`);
  }
  return productNames;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
}

// CANCEL_NOTIFY_CONTACTS="Ismi:chatId,Ismi2:chatId2" — bir nechta odamni belgilash.
function buildTags() {
  return (process.env.CANCEL_NOTIFY_CONTACTS || "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => {
      const [name, chatId] = e.split(":").map((s) => s.trim());
      return name && chatId ? `<a href="tg://user?id=${chatId}">${escapeHtml(name)}</a>` : null;
    })
    .filter(Boolean)
    .join(" ");
}

function buildItemLines(details, orderId, prodMap) {
  const lines = [];
  const target = String(orderId).trim();
  for (let j = 1; j < details.length; j++) {
    const row = details[j];
    if (String(row[DET.orderId] ?? "").trim() !== target) continue;
    const ref = String(row[DET.product] ?? "").trim();
    const name = prodMap.get(ref) || ref || "(nomsiz)";
    const qty = row[DET.quantity];
    lines.push(` • ${escapeHtml(name)}${qty !== undefined && qty !== "" ? ` × ${escapeHtml(qty)}` : ""}`);
  }
  return lines;
}

// header — xabar sarlavhasi (masalan "❌ Buyurtma bekor qilindi" yoki
// "⚠️ Buyurtma tasdiqlashdan oldin bekor bo'ldi"). details — uzum_order_detail
// qatorlari (index.js batchGet'dan). Muvaffaqiyatni (true/false) qaytaradi.
async function notifyCancellation({ orderId, shopId, details, header }) {
  const [shopMap, prodMap] = [await loadShopNames(), await loadProductNames()];
  const shopName = shopMap.get(String(shopId ?? "")) || String(shopId ?? "");
  const items = buildItemLines(details || [], orderId, prodMap);
  const tags = buildTags();

  const text =
    `${header}\n` +
    `🆔 Buyurtma: <b>${escapeHtml(orderId)}</b>\n` +
    `🏪 Do'kon: ${escapeHtml(shopName || "-")}\n` +
    (items.length ? `📦 Tarkibi:\n${items.join("\n")}\n` : "") +
    (tags ? `\n${tags}` : "");

  return sendTelegramMessage({ text, parseMode: "HTML" });
}

module.exports = { notifyCancellation };
