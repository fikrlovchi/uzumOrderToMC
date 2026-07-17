// Bir martalik migratsiya: status-sinxronizatsiya funksiyasi ishga tushishidan
// OLDIN bir marta ishga tushiriladi. T/U/V ustunlari yangi bo'lgani uchun,
// ular yozilmasa, tizim BARCHA eski (Q=1) buyurtmalarni "hali tasdiqlanmagan/
// hali tekshirilmagan" deb hisoblab, ularning barchasini Uzum'da qayta
// tasdiqlashga va MoySklad holatini o'zgartirishga urinardi.
//
// Bu skript allaqachon MoySklad'ga yuborilgan (Q=1) har bir qatorni
// "allaqachon bajarilgan" deb belgilaydi (T=1, U=done, V=1) — shunda yangi
// mantiq faqat shu skript ishga tushirilgandan KEYIN paydo bo'ladigan
// buyurtmalarga tegadi.
//
// Ishlatilishi: node scripts/backfillStatusFlags.js
require("dotenv").config();
const config = require("../config.json");
const { colLetterToIndex } = require("../src/sheetsUtil");
const { getSheetsClient } = require("../src/oauthSheets");

const ORD = Object.fromEntries(
  Object.entries(config.columns.orders).map(([k, v]) => [k, colLetterToIndex(v)])
);

const CHUNK_SIZE = 500;

async function main() {
  const sheets = getSheetsClient();
  const spreadsheetId = config.spreadsheetId;
  const ordersSheetName = config.sheets.orders;

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: ordersSheetName,
    valueRenderOption: "UNFORMATTED_VALUE",
  });
  const orders = data.values || [];

  const rowUpdates = [];
  let count = 0;

  for (let i = 1; i < orders.length; i++) {
    const row = orders[i];
    const sentToMoySklad = row[ORD.status];
    if (sentToMoySklad != 1) continue; // hali yuborilmagan — yangi oqim o'zi to'g'ri ishlov beradi

    const alreadyDone = row[ORD.uzumConfirmed] == 1 && row[ORD.mcState] && row[ORD.cancelHandled] == 1;
    if (alreadyDone) continue;

    const rowNumber = i + 1;
    rowUpdates.push({ range: `${ordersSheetName}!${config.columns.orders.uzumConfirmed}${rowNumber}`, values: [[1]] });
    rowUpdates.push({ range: `${ordersSheetName}!${config.columns.orders.mcState}${rowNumber}`, values: [["done"]] });
    rowUpdates.push({ range: `${ordersSheetName}!${config.columns.orders.cancelHandled}${rowNumber}`, values: [[1]] });
    count++;
  }

  console.log(`${count} ta eski buyurtma topildi (jami ${rowUpdates.length} ta katak yoziladi).`);

  for (let i = 0; i < rowUpdates.length; i += CHUNK_SIZE) {
    const chunk = rowUpdates.slice(i, i + CHUNK_SIZE);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: "RAW", data: chunk },
    });
    console.log(`${Math.min(i + CHUNK_SIZE, rowUpdates.length)}/${rowUpdates.length} yozildi...`);
  }

  console.log(`Tugadi: ${count} ta eski buyurtma "allaqachon bajarilgan" deb belgilandi.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
