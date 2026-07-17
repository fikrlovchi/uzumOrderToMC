# uzumOrderToMC — Holat va davom etish qo'llanmasi

_Oxirgi yangilanish: 2026-07-17. Bu fayl suhbat davomiyligini saqlash uchun
yozilgan — boshqa chat/oynada ishni davom ettirishda shu faylni o'qitib
boshlang._

## Loyiha nima qiladi

Uzum marketpleysidagi buyurtmalarni Google Sheets orqali MoySklad'ga
sinxronlaydi va ularning butun hayot siklini (import → yaratish → Uzum'da
tasdiqlash → MoySklad holatini boshqarish → bekor qilishni aniqlash)
avtomatlashtiradi. Serverda `uzum-order.timer` (systemd) har 2 daqiqada
`node src/index.js`ni ishga tushiradi.

**Server**: `root@64.226.69.129` (DigitalOcean), loyiha `/root/uzumOrderToMC`.
**GitHub**: `github.com/fikrlovchi/uzumOrderToMC` (branch: `main`).
**Bog'liq loyihalar serverda**: `~/uzumpdfs` (OAuth kaliti manbasi),
`~/fikrlovchi-panel` (monitoring/boshqaruv paneli, ALOHIDA suhbatda davom
etilmoqda), `~/cancelUzumOrder` (ESKI, endi ishlatilmaydi — bu loyihaga
birlashtirildi, lekin server unitini o'chirish hali tasdiqlanmagan bo'lishi
mumkin).

## Arxitektura (har 2 daqiqalik tsikl, `src/index.js` tartibida)

1. **`src/orderFetch.js`** — Uzum'dan `CREATED` holatidagi yangi buyurtmalarni
   har do'kon (`.env`dagi `UZUM_TOKEN_*`/`UZUM_SHOP_*`) uchun sahifalab olib,
   `uzum_order`/`uzum_order_detail`ga qo'shadi.
2. **`index.js`ning o'zi** — `Q`≠1 qatorlarni MoySklad'ga POST qiladi
   (`buildPositions()`: `uzum_order_detail!L` `TRUE` bo'lsa narx umumiy summa
   sifatida/miqdor=1, `FALSE` bo'lsa birlik narxi/haqiqiy miqdor). Muvaffaqiyatli
   bo'lsa `Q`=1, `S`=MoySklad ID. Kod 3006 (externalCode takrori) — o'zi
   tuzaluvchi: `findByExternalCode` orqali mavjudini topib sheetni to'ldiradi.
3. **`src/cancelSync.js`** (BOSHQA HAMMA BOSQICHDAN OLDIN) — `Q`=1, `V` bo'sh
   qatorlar uchun: avval MoySklad holatini `S` orqali tekshiradi (himoyalangan
   bo'lsa `V`=1). Aks holda Uzum'dan **aynan shu buyurtmaning** holatini
   so'raydi (`GET /v1/fbs/order/{id}` — bulk ro'yxat EMAS). `CANCELED` bo'lsa:
   `CANCEL_NOTIFY_CONTACTS`dagi odamlarni belgilab Telegram'ga xabar beradi,
   `V`=1. MoySklad holatini bu yerda O'ZGARTIRMAYDI.
4. **`src/orderStatusSync.js` — `promoteHeldOrders`** — oyna (`WINDOW_HOLD_*`)
   tashqarisida bo'lsa, `U`=`hold` qatorlarni Uzum'da tasdiqlaydi + MoySklad
   holatini `confirmed`ga o'tkazadi.
5. **`src/orderStatusSync.js` — `confirmAndSetInitialState`** — yangi (`T`
   bo'sh) qatorlar uchun: oyna ICHIDA bo'lsa faqat MoySklad `hold`ga (Uzum
   HALI tasdiqlanmaydi); oyna TASHQARISIDA bo'lsa Uzum tasdiqlash + MoySklad
   `confirmed` bir vaqtda.

### `uzum_order` ustunlari (T/U/V — yangi)
- `G` = shopId, `L` (detail sheet) = priceIsTotal
- `T` (`uzumConfirmed`): bo'sh/`1` — Uzum'da tasdiqlangan
- `U` (`mcState`): bo'sh/`hold`/`done` — MoySklad holati bosqichi
- `V` (`cancelHandled`): bo'sh/`1` — bekor qilish tekshiruvi yakunlangan

### Google Sheets ulanishi
**Butunlay OAuth (`uzbuyo@gmail.com`, `oauth.json`) orqali** — service account
(`credentials.json`) endi UMUMAN ishlatilmaydi (foydalanuvchi talabi bilan
shunday qilindi). `oauth.json` manbasi: `~/uzumpdfs/oauth.json` (nusxalab
ko'chirilgan).

### MoySklad holat hreflari (`config.json` → `moyskladStates`)
- `holdHref`, `confirmedHref`, `canceledHref` — biz o'rnatadigan holatlar
- `protectedHref` — boshqa avtomatika tomonidan qo'yiladigan yakuniy holat,
  BIZ HECH QACHON o'zgartirmaymiz (faqat tekshiramiz)

### Uzum API haqiqiy tezlik-limiti (aniqlangan, javob sarlavhalaridan)
Token-bucket: `burst-capacity=2`, `replenish-rate=2` (soniyasiga), kunlik
limit **100,000** (bizning eski 500 chegara juda past edi, olib tashlandi).
Barcha Uzum so'rovlari orasida `config.cancelSync.requestDelayMs` (600ms,
~1.67 so'rov/soniya) tanaffus bor.

## Muhim topilmalar (kelajakda qaytarilmasin)

1. **Uzum CANCELED ro'yxati `dateCreated` bo'yicha kamayish tartibida**
   (`dateCancelled` emas) — shuning uchun bulk-ro'yxat + sahifa-kursori
   yondashuvi TASHLAB YUBORILDI (buyurtma o'tkazib yuborilishi mumkin edi).
   Hozir har bir buyurtma alohida-alohida (`GET /v1/fbs/order/{id}`) tekshiriladi.
2. **Hold oynasi (06:10-11:00) davomida Uzum'da HAM tasdiqlanmaydi** — faqat
   MoySklad "hold"ga qo'yiladi. Ikkalasi (Uzum confirm + MoySklad confirmed)
   oyna tugagach BIRGA bajariladi.
3. **Bekor qilingan buyurtmada MoySklad holati O'ZGARTIRILMAYDI** — faqat
   Telegram xabari + `V`=1. (Foydalanuvchining aniq ko'rsatmasi bo'yicha —
   avvalgi versiyada MoySklad'ni ham "canceled"ga o'tkazar edik, endi yo'q.)
4. **Yangi (T/U/V) ustunlar uchun backfill kerak edi** — `scripts/backfillStatusFlags.js`
   bir marta ishga tushirilgan (eski Q=1 qatorlarni "allaqachon bajarilgan"
   deb belgilash uchun). Agar kelajakda yana shunga o'xshash yangi ustun
   qo'shilsa, xuddi shunday backfill kerak bo'ladi.
5. **`cancelUzumOrder` va eski GAS triggerlari** — bu loyihaning o'rnini
   bosadi. Foydalanuvchi GAS trigger'ni o'chirganini aytdi; `cancelUzumOrder`
   systemd xizmatini o'chirish hali tasdiqlanmagan bo'lishi mumkin — buni
   tekshirib, kerak bo'lsa eslatish kerak.

## `.env` da bo'lishi kerak bo'lgan o'zgaruvchilar

```
MOYSKLAD_TOKEN=...
PANEL_INGEST_URL=http://127.0.0.1:3000/api/ingest/runs
PANEL_PROJECT_SLUG=uzum-order-to-mc
PANEL_API_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
TELEGRAM_TOPIC_ID=...
WINDOW_HOLD_START=06:10
WINDOW_HOLD_END=11:00
CANCEL_NOTIFY_CONTACTS=Ismi:chatId,Ismi2:chatId2
UZUM_TOKEN_<KABINET>=...
UZUM_SHOP_<KABINET>_<BELGI>=...
DRY_RUN=false   # true = xavfsiz sinov rejimi, hech narsa real yozilmaydi
```

**Diqqat**: server `.env`da hali eski `UZUM_DAILY_REQUEST_LIMIT` qatori
qolgan bo'lishi mumkin — endi o'qilmaydi (kodda ishlatilmaydi), zarar
qilmaydi, lekin xohlasa o'chirish mumkin. Eski `CANCEL_NOTIFY_NAME`/
`CANCEL_NOTIFY_CHAT_ID` o'rniga endi `CANCEL_NOTIFY_CONTACTS` kerak.

## Hozirgi holat / keyingi qadam

Oxirgi katta o'zgarish (bekor qilishni butunlay qayta qurish, commit
`03e4059`) hali **serverda sinalmagan**. Keyingi qadam:

1. Serverda `.env`ga `CANCEL_NOTIFY_CONTACTS=Ismi:chatId` qo'shish (eski
   `CANCEL_NOTIFY_NAME`/`CANCEL_NOTIFY_CHAT_ID` o'rniga).
2. `DRY_RUN=true` bilan `git pull && npm start`, loglarni ko'rib chiqish
   (endi "Bekor qilish tekshiruvi: N tekshirildi, ..." formatidagi log
   kutilmoqda, avvalgi "kunlik limit"/sahifa-kursori xabarlari YO'Q bo'lishi
   kerak).
3. Hammasi to'g'ri ko'rinsa `DRY_RUN=false`.
4. `cancelUzumOrder` systemd xizmati hali o'chirilmagan bo'lsa — o'chirish.

## Fayllar xaritasi

```
src/
  index.js              — asosiy orkestratsiya, buildPositions (narx/miqdor)
  orderFetch.js          — Uzum CREATED -> sheet (OAuth)
  cancelSync.js           — bekor qilishni tekshirish (yangi, sodda dizayn)
  orderStatusSync.js       — Uzum confirm + MoySklad hold/confirmed
  oauthSheets.js           — OAuth2 Sheets klienti (uzbuyo@gmail.com)
  uzumCabinets.js          — .env'dan UZUM_TOKEN_*/UZUM_SHOP_* o'qish
  uzumApi.js               — Uzum API: fetchOrdersPage, confirmOrder, getOrderStatus
  moysklad.js              — MoySklad: setOrderState, getOrderStateHref,
                              findByExternalCode, msFetch (429 retry)
  timeWindow.js            — Toshkent vaqti, hold-oyna hisoblash
  telegram.js              — umumiy Telegram yuboruvchi
  skuAlerts.js             — SKU topilmasa ogohlantirish (eski funksiya)
  dryRun.js                — DRY_RUN tekshiruvi
  reporter.js, logger.js   — fikrlovchi-panel bilan integratsiya
scripts/
  backfillStatusFlags.js   — bir martalik T/U/V migratsiyasi (ishlatilgan)
config.json                — barcha sozlamalar (Sheets ustunlari, MoySklad
                              hreflari, cancelSync.requestDelayMs va h.k.)
```

## Boshqa suhbatda davom etish

Yangi chat/oynada shunday deb boshlang:

> `C:\Users\User\Desktop\Buyo\Server\Stocker\uzumOrderToMC\HANDOFF.md` faylini
> o'qib chiq, shu loyiha ustida davom etamiz.

Bu fayl loyihaning o'zida (git'da) saqlanadi, shuning uchun har doim
`git pull` qilingandan keyin ham mavjud bo'ladi.
