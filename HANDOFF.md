# uzumOrderToMC — Holat va davom etish qo'llanmasi

_Oxirgi yangilanish: 2026-07-17. Bu fayl suhbat davomiyligini saqlash uchun
yozilgan — boshqa chat/oynada ishni davom ettirishda shu faylni o'qitib
boshlang._

## Loyiha nima qiladi

Uzum marketpleysidagi buyurtmalarni Google Sheets orqali MoySklad'ga
sinxronlaydi va ularning butun hayot siklini (import → yaratish → Uzum'da
tasdiqlash → MoySklad holatini boshqarish → bekor qilishni aniqlash)
avtomatlashtiradi. Serverda `uzum-order.timer` (systemd) har 2 daqiqada
`node src/index.js`ni ishga tushiradi. Bundan tashqari **doimiy ishlaydigan
alohida servis** (`src/mcCancelServer.js`) MoySklad'dan kelgan bekor qilish
signalini Uzum'ga o'tkazadi.

**Server**: `root@64.226.69.129` (DigitalOcean), loyiha `/root/uzumOrderToMC`.
**GitHub**: `github.com/fikrlovchi/uzumOrderToMC` (branch: `main`).
**Bog'liq loyihalar serverda**: `~/uzumpdfs` (OAuth kaliti manbasi),
`~/fikrlovchi-panel` (monitoring/boshqaruv paneli, ALOHIDA suhbatda),
`~/receiveMCPost` (MoySklad customerorder webhook → `ImportedIDs` sheet;
5-band servisining namunasi/qardoshi), `~/cancelUzumOrder` (ESKI, endi
ishlatilmaydi).

## Arxitektura (har 2 daqiqalik tsikl, `src/index.js` tartibida)

1. **`src/orderFetch.js`** — Uzum'dan `CREATED` buyurtmalarni har do'kon uchun
   olib `uzum_order`/`uzum_order_detail`ga qo'shadi. Yangi qatorlar qo'shilgach,
   **`W` ustuniga** (buyurtma tushgan vaqt) Toshkent vaqt-belgisini alohida
   `values.update` bilan yozadi (A:M `append`iga qo'shilmaydi — chunki M..W
   orasidagi O/P/R kabi formulali ustunlarni bo'sh qiymat bilan bosib
   yubormaslik kerak).
2. **`index.js`ning o'zi** — `Q`≠1 qatorlarni MoySklad'ga POST qiladi
   (`buildPositions()`: detail `L` `TRUE` → narx=`E` umumiy summa/miqdor=1,
   `FALSE` → narx=`E` birlik/miqdor=`K`). Muvaffaqiyatda `Q`=1, `S`=MoySklad ID.
   Kod 3006 (externalCode takrori) o'zi tuzaladi.
3. **`src/cancelSync.js`** (4-band, 24 soatlik monitoring) — `Q`=1, `V` bo'sh
   qatorlar uchun. `mcState`=`hold` qatorlarni **o'tkazib yuboradi** (ularni
   11:01 promotion hal qiladi). `W` (yo'q bo'lsa `C`=dateCreated) 24 soatdan
   oshgan bo'lsa → Uzum'ga so'ramasdan `V`=1 (avtomatik yopish). 24 soat ichida
   bo'lsa → Uzum'dan `GET /v1/fbs/order/{id}`; `CANCELED` bo'lsa →
   **teglangan** Telegram xabari (`CANCEL_NOTIFY_CONTACTS`) + `V`=1. MoySklad
   holati bu yerda o'zgartirilmaydi.
4. **`src/orderStatusSync.js` — `promoteHeldOrders`** (3-band) — oyna
   tashqarisida `mcState`=`hold` qatorlar uchun: avval Uzum holatini so'raydi.
   `CANCELED` bo'lsa → Uzum'da tasdiqlamaydi, MoySklad holatini
   **`canceledHref`**ga o'tkazadi, `V`=1, ID'ni ro'yxatga yig'adi. Aks holda →
   Uzum'da tasdiqlaydi + MoySklad `confirmedHref`. Tsikl oxirida bekor
   qilinganlar bitta **teglanmagan** xabarda: `"{id}, {id} raqamli buyurtmalar
   avtomatik bekor qilindi"`.
5. **`src/orderStatusSync.js` — `confirmAndSetInitialState`** (1/2-band) — yangi
   (`T` bo'sh) qatorlar uchun: oyna ICHIDA → faqat MoySklad `holdHref`; oyna
   TASHQARISIDA → Uzum tasdiqlash + MoySklad `confirmedHref`.

## Doimiy servis: `src/mcCancelServer.js` (5-band)

MoySklad'da operator buyurtmani bekor qilganda, MoySklad script bu servisga
customerorder id/href'ni **POST** qiladi (`?id=..&type=customerorder` yoki JSON
`{events:[{meta:{href,type}}]}` — `receiveMCPost` bilan bir xil format). Servis:
1. `uzum_order!S` (moySkladId) dan mos qatorni topadi,
2. qatordagi Uzum orderId (`A`) va shopId (`G`) orqali buyurtmani Uzum'da
   bekor qiladi (`POST /v1/fbs/order/{id}/cancel`, `{reason:"OTHER",comment:""}`;
   `seller-order-13` "already canceled" → muvaffaqiyat),
3. **Telegram'ga hech narsa yubormaydi**,
4. `uzum_order!V` bo'sh bo'lsa `1` qilib qo'yadi (shunda cancelSync qayta
   xabar bermaydi).

Ichki Node `http` bilan yozilgan (express bog'liqligi yo'q). Port:
`MC_CANCEL_PORT` yoki `config.mcCancelServer.port` (default **4042**),
endpoint `config.mcCancelServer.path` (default `/mc-cancel`).
Ishga tushirish: `npm run mc-cancel-server` (yoki pm2/systemd).

## Ustunlar

### `uzum_order`
- `A`=orderId, `C`=dateCreated (fallback yosh), `E`=date, `G`=shopId,
  `I`=shipmentAddress, `O`=organization, `P`=salesChannel (O/P/R = formula),
  `Q`=status(1=yuborilgan), `R`=trackingNumber, `S`=moySkladId
- `T` (`uzumConfirmed`): bo'sh/`1`
- `U` (`mcState`): bo'sh/`hold`/`done`
- `V` (`cancelHandled`): bo'sh/`1`
- **`W` (`arrivedAt`)**: buyurtma tushgan vaqt, `yyyy-MM-dd HH:mm:ss` (Toshkent).
  24 soatlik monitoring shu ustundan hisoblanadi. Import'da avtomatik yoziladi.

### `uzum_order_detail`
- `E`=price (L=FALSE → birlik narxi; L=TRUE → umumiy summa),
  `H`=orderId, `I`=product, `J`=entityType, `K`=quantity, `L`=priceIsTotal

### MoySklad holat hreflari (`config.json` → `moyskladStates`)
- `holdHref` = `a479862e-…c3` (2-band, oyna ichida)
- `confirmedHref` = `a4798772-…c5` (1/3-band, tasdiqlangan)
- `canceledHref` = `a47989ee-…c9` ("Atmenen", 3-band bekor qilingan held)
- `protectedHref` — endi **ishlatilmaydi** (cancelSync'dan olib tashlandi).

## Muhim topilmalar / qarorlar

1. **Pul hisobi (6/7-band) o'zgarishsiz tasdiqlangan**: `price=E×100` doim;
   `L=FALSE` → `quantity=K` (E birlik), `L=TRUE` → `quantity=1` (E umumiy summa).
   Bu yagona izchil talqin (L=TRUE'da qty=K bo'lsa MoySklad K×E ko'paytirar edi).
2. **Bekor qilish endi 24 soatlik oyna bilan**: har buyurtma faqat tushganidan
   keyingi 24 soat davomida Uzum'da tekshiriladi; keyin avtomatik `V`=1. `W`
   ustuni shu uchun qo'shildi. **Eski (W-siz) qatorlar** uchun `C` (dateCreated)
   fallback ishlatiladi; foydalanuvchi eski qatorlarga qo'lda ">24 soat oldingi"
   vaqt yozib qo'yishi ham mumkin (shunda ular avtomatik yopiladi).
3. **Ikki xil bekor-xabar formati**: 3-band (11:01 promotion) — bitta xabarda
   ID ro'yxati, **teglanmagan**. 4-band (24h monitoring) — har biri alohida,
   `CANCEL_NOTIFY_CONTACTS` **teglangan** (`msg exmp.js` uslubida).
4. **`hold` qatorlar cancelSync'da tegilmaydi** — 3-band va 4-band xabarlari
   aralashmasligi uchun. Hold-buyurtmani faqat promotion (3-band) hal qiladi.
5. **5-band (MoySklad→Uzum) va 4-band (Uzum→bildirish) teskari yo'nalishlar**:
   ikkalasi ham oxirida `V`=1 qo'yadi. 5-band cancel qilib `V`=1 qo'ygach,
   4-band uni qayta ko'rib xabar bermaydi.
6. **`cancelUzumOrder` va eski GAS triggerlari** — bu loyiha o'rnini bosadi.

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
MC_CANCEL_PORT=4042    # ixtiyoriy, mcCancelServer porti (default 4042)
DRY_RUN=false          # true = xavfsiz sinov rejimi
```

## Hozirgi holat / keyingi qadam

Katta o'zgarishlar to'plami (W ustuni + 24h monitoring, held CANCELED
tekshiruvi, mcCancelServer) yozildi va lokalda sintaksis + vaqt-mantiqi +
servis HTTP qatlami sinaldi. **Serverda hali sinalmagan.** Keyingi qadam:

1. **Sheet tayyorlash**: `uzum_order`ga `W` sarlavhasini qo'shish. Eski (Q=1,
   V bo'sh) qatorlarga qo'lda ">24 soat oldingi" sana yozib chiqish (yoki C
   ustuni fallback ishlaydi — lekin qo'lda yozish aniqroq).
2. `git pull`, `DRY_RUN=true` bilan `npm start` — cron tsiklini tekshirish.
   Kutilgan loglar: "Uzum import: … W …", "Bekor qilish tekshiruvi: N
   tekshirildi, … 24 soatdan o'tgani avtomatik yopildi …".
3. **mcCancelServer**ni ishga tushirish: `pm2 start src/mcCancelServer.js
   --name mc-cancel` (yoki systemd unit). `ufw allow 4042`. Tekshirish:
   `curl http://127.0.0.1:4042/`. MoySklad script'ni shu endpointga
   yo'naltirish.
4. Hammasi to'g'ri bo'lsa `DRY_RUN=false`.
5. `cancelUzumOrder` systemd xizmati hali o'chirilmagan bo'lsa — o'chirish.

## Fayllar xaritasi

```
src/
  index.js              — asosiy orkestratsiya, buildPositions (narx/miqdor)
  orderFetch.js          — Uzum CREATED -> sheet + W ustuni (OAuth)
  cancelSync.js           — 24h bekor qilish monitoringi (W asosida, teglangan)
  orderStatusSync.js       — confirmAndSetInitialState + promoteHeldOrders (3-band)
  mcCancelServer.js        — YANGI: MoySklad->Uzum bekor qilish HTTP servisi (5-band)
  oauthSheets.js           — OAuth2 Sheets klienti (uzbuyo@gmail.com)
  uzumCabinets.js          — .env'dan UZUM_TOKEN_*/UZUM_SHOP_* o'qish
  uzumApi.js               — fetchOrdersPage, confirmOrder, getOrderStatus, cancelOrder
  moysklad.js              — MoySklad: setOrderState, getOrderStateHref, findByExternalCode
  timeWindow.js            — Toshkent vaqti, hold-oyna hisoblash
  sheetsUtil.js            — colLetterToIndex, formatDateTimeGMT5,
                              tashkentNowString, parseSheetTimeToEpochMs (W uchun)
  telegram.js              — umumiy Telegram yuboruvchi
  dryRun.js, reporter.js, logger.js, skuAlerts.js
scripts/
  backfillStatusFlags.js   — bir martalik T/U/V migratsiyasi (ishlatilgan)
config.json                — sozlamalar (ustunlar, MoySklad hreflari, cancelSync,
                              mcCancelServer)
```

## Boshqa suhbatda davom etish

Yangi chat/oynada shunday deb boshlang:

> `C:\Users\User\Desktop\Buyo\Server\Stocker\uzumOrderToMC\HANDOFF.md` faylini
> o'qib chiq, shu loyiha ustida davom etamiz.
