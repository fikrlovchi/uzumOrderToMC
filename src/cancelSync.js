const config = require("../config.json");
const logger = require("./logger");
const cancelState = require("./cancelState");
const { parseCabinets } = require("./uzumCabinets");
const { sweepCabinet } = require("./uzumCancelSweep");
const moysklad = require("./moysklad");
const { sendTelegramMessage } = require("./telegram");
const { isDryRun } = require("./dryRun");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeHtml(value) {
  return String(value).replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]));
}

async function notifyCancellation(orderId) {
  const name = process.env.CANCEL_NOTIFY_NAME;
  const chatId = process.env.CANCEL_NOTIFY_CHAT_ID;
  const tag = name && chatId ? `<a href="tg://user?id=${chatId}">${escapeHtml(name)}</a>` : "";
  await sendTelegramMessage({
    text: `❌ Buyurtma bekor qilindi: ${escapeHtml(orderId)}${tag ? "\n" + tag : ""}`,
    parseMode: "HTML",
  });
}

// Eski ikki GAS/cancelUzumOrder skriptning birlashmasi (CANCELED oqimi):
//  1-bosqich: Uzum'dan CANCELED buyurtma ID'larini har do'konning saqlangan
//    sahifa kursoridan yig'ib, yangi ko'rilganlarini lokal holatga "pending"
//    qilib qo'shadi (data/cancel-state.json — uzum_order sheetga bog'liq emas).
//  2-bosqich: har bir pending buyurtmani MoySklad'da externalCode orqali topib
//    (Uzum order ID == MoySklad externalCode), agar allaqachon "himoyalangan"
//    (yakuniy) holatda bo'lmasa — bekor qilingan holatga o'tkazadi va mas'ul
//    odamni belgilab Telegram'ga xabar beradi.
async function run({ moyskladToken }) {
  const cfg = config.cancelSync;
  const stats = {
    newOrders: 0,
    updated: 0,
    alreadyDone: 0,
    waitingMoySklad: 0,
    givenUp: 0,
    sweepErrors: 0,
    msErrors: 0,
  };

  let cabinets;
  try {
    cabinets = parseCabinets(process.env);
  } catch (e) {
    logger.error(`Bekor qilish tekshiruvi o'tkazib yuborildi: ${e.message}`);
    return { errorCount: 1 };
  }

  const dailyLimit = parseInt(process.env.UZUM_DAILY_REQUEST_LIMIT || "500", 10);
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1) {
    logger.error("UZUM_DAILY_REQUEST_LIMIT musbat butun son bo'lishi kerak — bekor qilish tekshiruvi o'tkazib yuborildi.");
    return { errorCount: 1 };
  }

  const state = cancelState.load();
  const budget = cancelState.createBudget(state, dailyLimit);

  // Har tsiklda to'liq maxLookbackDays'gacha (masalan 30 kun) skanerlash
  // Uzum'ni tez-tez 429'ga uchratadi (bekor qilinganlar ko'p to'plangan
  // do'konlarda o'nlab sahifa kerak bo'lishi mumkin). Shuning uchun:
  //  - har tsiklda YENGIL skanerlash (bir necha sahifa) — yaqinda yaratilgan
  //    buyurtmaning bekor qilinishini tez ushlaydi (eng ko'p uchraydigan holat).
  //  - deepSweepIntervalMs'da bir marta CHUQUR skanerlash (to'liq
  //    maxLookbackDays) — kamdan-kam holat: ancha oldin yaratilgan buyurtma
  //    hozir bekor qilinsa, uni bir soatgacha kechikish bilan baribir ushlaydi.
  const deepSweepIntervalMs = cfg.uzum.deepSweepIntervalMs ?? 60 * 60 * 1000;
  const isDeepSweepDue =
    !state.lastDeepSweepAt || Date.now() - Date.parse(state.lastDeepSweepAt) > deepSweepIntervalMs;
  const sweepCfg = isDeepSweepDue
    ? cfg.uzum
    : { ...cfg.uzum, maxPagesPerSweep: cfg.uzum.shallowMaxPages ?? 3 };

  let allShopsCompleted = true;

  for (const cabinet of cabinets) {
    try {
      const { ids, exhausted } = await sweepCabinet(cabinet, budget, sweepCfg);
      if (exhausted) {
        allShopsCompleted = false;
        logger.error(`"${cabinet.name}": kunlik Uzum so'rov limiti (${dailyLimit}) tugadi — qolgan sahifalar keyingi tsiklda.`);
      }
      for (const id of ids) {
        if (!state.orders[id]) {
          state.orders[id] = { status: "pending", attempts: 0, firstSeenAt: new Date().toISOString() };
          stats.newOrders++;
        }
      }
    } catch (e) {
      allShopsCompleted = false;
      stats.sweepErrors++;
      logger.error(`"${cabinet.name}" kabinetini o'qishda xato: ${e.message}`);
    }
  }

  if (isDeepSweepDue && allShopsCompleted) {
    state.lastDeepSweepAt = new Date().toISOString();
    logger.info(`Chuqur skanerlash (${cfg.uzum.maxLookbackDays} kunlik) yakunlandi.`);
  }

  const pending = Object.entries(state.orders).filter(([, o]) => o.status === "pending");
  const runDeadline = Date.now() + cfg.run.maxDurationMs;
  let processedSinceSave = 0;

  for (const [orderId, order] of pending) {
    if (Date.now() > runDeadline) {
      logger.info("Bekor qilish tekshiruvi uchun vaqt byudjeti tugadi — qolgani keyingi tsiklda.");
      break;
    }

    try {
      const msOrder = await moysklad.findByExternalCode(orderId, moyskladToken);
      const currentStateHref = msOrder?.state?.meta?.href;

      if (!msOrder) {
        order.attempts++;
        if (order.attempts >= cfg.moysklad.maxAttemptsPerOrder) {
          order.status = "failed";
          order.doneAt = new Date().toISOString();
          stats.givenUp++;
          logger.error(`Buyurtma ${orderId}: MoySklad'da ${order.attempts} urinishda ham topilmadi — kuzatuvdan chiqarildi.`);
        } else {
          stats.waitingMoySklad++;
        }
      } else if (currentStateHref === config.moyskladStates.protectedHref || currentStateHref === config.moyskladStates.canceledHref) {
        // Allaqachon kerakli/himoyalangan holatda — hech narsa qilinmaydi.
        order.status = "done";
        order.doneAt = new Date().toISOString();
        order.moyskladId = msOrder.id;
        stats.alreadyDone++;
      } else if (isDryRun()) {
        logger.info(`[DRY_RUN] Buyurtma ${orderId}: MoySklad'da bekor qilinardi (${msOrder.id}) va Telegram xabari yuborilardi.`);
        // order holati o'zgartirilmaydi — DRY_RUN o'chirilgach real urinish qayta sinaladi.
      } else {
        await moysklad.setOrderState(moysklad.customerOrderHref(msOrder.id), config.moyskladStates.canceledHref, moyskladToken);
        order.status = "done";
        order.doneAt = new Date().toISOString();
        order.moyskladId = msOrder.id;
        stats.updated++;
        logger.info(`Buyurtma ${orderId}: MoySklad'da bekor qilindi (${msOrder.id}).`);
        await notifyCancellation(orderId);
      }
    } catch (e) {
      stats.msErrors++;
      logger.error(`Buyurtma ${orderId}: ${e.message}`);
    }

    processedSinceSave++;
    if (processedSinceSave >= cfg.run.saveStateEvery) {
      cancelState.save(state);
      processedSinceSave = 0;
    }

    await sleep(cfg.moysklad.requestDelayMs);
  }

  cancelState.prune(state, cfg.state.pruneDays);
  cancelState.save(state);

  const errorCount = stats.sweepErrors + stats.msErrors + stats.givenUp;
  logger.info(
    `Bekor qilish tekshiruvi: ${stats.newOrders} yangi, ${stats.updated} bekor qilindi, ` +
      `${stats.alreadyDone} allaqachon joyida, ${stats.waitingMoySklad} MoySklad'ni kutmoqda, ${errorCount} xato.`
  );

  return { errorCount };
}

module.exports = { run };
