# uzumOrderToMC

Uzum jadvalidagi (Google Sheets) yangi buyurtmalarni MoySklad'ga `customerorder`
sifatida yaratadi. Google Apps Script kodining Node.js versiyasi.

## Ishlash mantig'i

Har 2 daqiqada, bitta ishga tushirishda ketma-ket:

1. **Uzum'dan yangi buyurtmalarni olish** (`src/orderFetch.js`) — har bir
   do'kon (`.env`dagi `UZUM_TOKEN_*`/`UZUM_SHOP_*`) uchun `CREATED` holatidagi
   buyurtmalarni sahifalab so'raydi, yangilarini `uzum_order`/
   `uzum_order_detail`ga qo'shadi.
2. **MoySklad'da yaratish** — `Q` ustuni (status) `1` bo'lmagan qatorlarni
   `uzum_order_detail`dan yig'ib, MoySklad'ga `customerorder` sifatida POST
   qiladi; muvaffaqiyatli bo'lsa `Q`=1 va `S`=MoySklad ID yoziladi.
   `uzum_order_detail!L` (`priceIsTotal`) `TRUE` bo'lsa `E` ustunidagi narx
   qatorning umumiy summasi sifatida (miqdor=1) yuboriladi; `FALSE` bo'lsa —
   birlik narxi sifatida (haqiqiy miqdor bilan birga).
3. **Bekor qilishni tekshirish** (`src/cancelSync.js`, boshqa hamma
   bosqichdan OLDIN) — `Q`=1 va `V` (`cancelHandled`) hali bo'sh bo'lgan har
   bir buyurtma uchun: avval MoySklad holatini `S` orqali tekshiradi (arzon
   so'rov) — allaqachon "himoyalangan" holatda bo'lsa, `V`=1 qilib to'xtatadi.
   Aks holda, Uzum'dan **aynan shu bitta buyurtmaning** joriy holatini so'raydi
   (butun `CANCELED` ro'yxatini emas). Uzum statusi `CANCELED` bo'lsa — mas'ul
   odamlarni belgilab Telegram'ga xabar beradi va `V`=1 qilib qo'yadi (MoySklad
   holatini bu yerda o'zgartirmaydi — faqat ogohlantiradi va belgilaydi).
4. **Kutish oynasidan chiqarish** (`src/orderStatusSync.js`) — Toshkent vaqti
   bilan `WINDOW_HOLD_END`dan o'tgan bo'lsa, hali "kutish" holatida (`U`=`hold`)
   turgan buyurtmalarni Uzum'da tasdiqlaydi va MoySklad holatini
   "tasdiqlangan"ga o'tkazadi.
5. **Yangi buyurtmalarni tekshirish** — `Q`=1 va hali qayta ishlanmagan
   buyurtmalar uchun: agar joriy vaqt kutish oynasida (`WINDOW_HOLD_START`..
   `WINDOW_HOLD_END`) bo'lsa, **Uzum'da hali tasdiqlanmaydi** — faqat MoySklad
   holati "kutish"ga o'rnatiladi (Uzum tasdiqlash + MoySklad "tasdiqlangan"ga
   o'tkazish ikkalasi ham oyna tugagach, 4-qadamda, birga amalga oshadi).
   Oyna tashqarisida bo'lsa, ikkalasi darhol bir vaqtda bajariladi.

MoySklad tokeni `.env`dagi `MOYSKLAD_TOKEN`dan olinadi — `fikrlovchi-panel`
"O'zgaruvchilar" sahifasidan markazlashtirilgan holda boshqariladi.

## Kerakli fayllar

| Fayl | Izoh |
|------|------|
| `config.json` | Spreadsheet ID, varaq/ustun nomlari, MoySklad havolalari/holatlari. Git'da bor. |
| `oauth.json` | `uzbuyo@gmail.com` OAuth2 kalitlari — Google Sheets'ga **barcha** o'qish/yozish shu orqali (service account endi ishlatilmaydi). **Git'ga tushmaydi.** |
| `.env` | `MOYSKLAD_TOKEN` (majburiy), oyna/mas'ul-odam sozlamalari, `fikrlovchi-panel`/Telegram (ixtiyoriy). **Git'ga tushmaydi.** |

## Buyurtma status sinxronizatsiyasi — sozlash

### `oauth.json` (Google Sheets — yagona ulanish usuli)

Google Sheets'ga barcha o'qish/yozishlar `uzbuyo@gmail.com` nomidan amalga
oshadi (`credentials.json`/service account endi umuman kerak emas). Loyihada
bu maqsad uchun allaqachon ishlayotgan kalit bor — uni shunchaki nusxalash
kifoya:

```bash
cp ../uzumPDFs/oauth.json ./oauth.json
```

(Server yo'li boshqacha bo'lsa mos ravishda o'zgartiring — asosiysi fayl
`{"client_id", "client_secret", "refresh_token"}` shaklida bo'lishi kerak.)

### Yangi `.env` o'zgaruvchilari

```
WINDOW_HOLD_START=06:10
WINDOW_HOLD_END=11:00
CANCEL_NOTIFY_CONTACTS=Ismi:chatId,Ismi2:chatId2
```

`WINDOW_HOLD_START`/`END` — Toshkent vaqti bilan, shu oraliqda tasdiqlangan
buyurtmalar MoySklad'da vaqtincha "kutish" holatida turadi, oyna tugagach
avtomatik "tasdiqlangan"ga o'tadi. `CANCEL_NOTIFY_CONTACTS` — bekor qilingan
buyurtma haqida Telegram xabarida belgilanadigan (tag qilinadigan) mas'ul
odamlar; bir nechtasi vergul bilan ajratiladi. Har bir odam kamida bir marta
botga yozgan bo'lishi kerak, aks holda `tg://user?id=` belgilash haqiqiy
bildirishnoma bermaydi (Telegram'ning o'z cheklovi).

### Uzum kabinetlari/do'konlari (`.env`)

`uzum_shop` Google Sheet'i "manba" hisoblanadi (odamlar shu yerda tahrirlaydi),
lekin kod faqat `.env`ni o'qiydi — shu sheetdagi qiymatlar quyidagi naqsh
bo'yicha `.env`ga import qilinishi kerak (qo'lda yoki alohida sinxronizatsiya
orqali):
```
UZUM_TOKEN_<KABINET>=token
UZUM_SHOP_<KABINET>_<BELGI>=shopId
```
Bitta kabinetga istalgancha do'kon qo'shsa bo'ladi. Do'kon uchun token
topilmasa, shu do'kon uchun import/tasdiqlash/bekor-qilish tekshiruvi jimgina
o'tkazib yuboriladi (xato sifatida loglanadi).

### Nima uchun Uzum'ning bulk `CANCELED` ro'yxati emas

Dastlab bekor qilishni aniqlash Uzum'ning butun `CANCELED` ro'yxatini
sahifalab o'qish orqali qilingan edi (`cancelUzumOrder` alohida servisidan
ko'chirilgan). Amalda tekshirilganda bu ro'yxat buyurtmaning bekor qilingan
sanasi (`dateCancelled`) emas, balki **yaratilgan sanasi (`dateCreated`)
bo'yicha kamayish tartibida** qaytishi aniqlandi — bu degani sahifalar vaqt
o'tishi bilan "muhrlanmaydi" (ancha oldin yaratilgan buyurtma bugun bekor
qilinsa, u ro'yxatning chuqur qismida joylashaveradi), va bu ro'yxat vaqt
o'tishi bilan cheksiz kattalashib boradi.

Shuning uchun butunlay boshqa yondashuvga o'tildi: Uzum'ning bulk ro'yxatini
umuman o'qimasdan, **faqat bizning o'z buyurtmalarimiz** (`uzum_order!V` hali
bo'sh bo'lganlari) uchun, har biriga alohida (`GET /v1/fbs/order/{id}`) so'rov
yuboriladi — bu ham to'g'ri (o'tkazib yubormaydi), ham ancha kam so'rov talab
qiladi (faqat hali "yakunlanmagan" buyurtmalar soncha, butun tarix emas).

### Birinchi marta ishga tushirish — DRY_RUN

Yangi status-sinxronizatsiya funksiyasini xavfsiz tekshirib chiqish uchun
`.env`da vaqtincha:
```
DRY_RUN=true
```
Shu holatda skript Uzum'ga confirm yubormaydi, MoySklad holatini o'zgartirmaydi,
Telegram xabari yubormaydi va sheetga yozmaydi — faqat nima qilinishi
kerakligini `[DRY_RUN] ...` prefiksi bilan loglaydi (`journalctl`/`logs/`).
Loglarni ko'rib, hammasi to'g'ri ko'rinsa, `DRY_RUN=false` qilib qayta ishga
tushiring (yoki butunlay olib tashlang — standart qiymat `false`).

### Eski GAS triggerlarini o'chirish

Bu funksiyalar Apps Script'dagi ikkita eski avtomatikani (buyurtma import va
bekor qilishni aniqlash) to'liq almashtiradi. **Node skript ishga tushirilgach,
shu ikkala GAS trigger'ni o'chiring** — aks holda ikkalasi bir vaqtda bir xil
sheet'ga yozib, ziddiyatga olib kelishi mumkin.

## Admin panel (fikrlovchi-panel) bilan bog'lash

Har bir ishga tushirish natijasi (log qatorlari, muvaffaqiyat/xato soni) `fikrlovchi-panel`ga
yuboriladi — u orqali xatolarni ko'rish va trigger intervalni boshqarish mumkin.

```bash
cp .env.example .env
```
`.env` ichida `PANEL_API_KEY`ni to'ldiring — kalit `fikrlovchi-panel` serverida
`node scripts/seed-project.js uzum-order-to-mc "Uzum -> MoySklad"` orqali olinadi.

## Telegram SKU ogohlantirish

MoySklad'da mosi topilmagan SKU (XLOOKUP `#N/A`) tufayli buyurtma o'tkazib
yuborilsa, shu SKU haqida Telegram guruhning belgilangan mavzusiga (topic)
xabar boradi. Bir xil SKU 24 soat ichida qayta yuborilmaydi (`data/notified-skus.json`
orqali kuzatiladi, git'ga tushmaydi).

`.env` ga qo'shing:
```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
TELEGRAM_TOPIC_ID=...
```
Sozlanmagan bo'lsa (bo'sh qoldirilsa), bu funksiya jim o'tkazib yuboriladi.

Panel bilan bog'liq muammo (masalan, u vaqtincha ishlamasa) buyurtma
sinxronizatsiyasiga ta'sir qilmaydi — hisobot yuborish "fire-and-forget"
tarzida ishlaydi va barcha xatolarni yutadi.

## Lokal ishga tushirish (Windows)

```powershell
node src/index.js
```

> `npm start` PowerShell'da "running scripts is disabled" xatosi bersa,
> to'g'ridan-to'g'ri `node src/index.js` ishlating.

---

## Serverga yuklash (Ubuntu/Debian + Git + systemd timer)

### 1. Repozitoriyni yaratish (lokal kompyuterda, bir marta)

```bash
git remote add origin git@github.com:USERNAME/uzumOrderToMC.git
git push -u origin main
```

### 2. Serverda klonlash

```bash
sudo mkdir -p /opt/uzumOrderToMC
sudo chown $USER:$USER /opt/uzumOrderToMC
git clone git@github.com:USERNAME/uzumOrderToMC.git /opt/uzumOrderToMC
cd /opt/uzumOrderToMC
npm ci --omit=dev
```

### 3. Node.js o'rnatish (agar yo'q bo'lsa)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
which node   # ExecStart uchun yo'lni eslab qoling
```

### 4. `oauth.json` ni joylash

Yuqoridagi "Buyurtma status sinxronizatsiyasi — sozlash" bo'limiga qarang
(`uzumPDFs/oauth.json`dan nusxalash kifoya — alohida OAuth consent kerak
emas).

### 5. systemd service va timer o'rnatish

`deploy/uzum-order.service` faylidagi `User`, `WorkingDirectory`, `ExecStart`
(node yo'li) qiymatlarini o'z serveringizga moslang, so'ng:

```bash
sudo cp deploy/uzum-order.service /etc/systemd/system/
sudo cp deploy/uzum-order.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now uzum-order.timer
```

### 6. Tekshirish

```bash
systemctl list-timers uzum-order.timer   # keyingi ishga tushish vaqti
sudo systemctl start uzum-order.service  # darhol bir marta ishga tushirish
journalctl -u uzum-order.service -f      # loglarni jonli kuzatish
```

Loglar `journald`da hamda `logs/YYYY-MM-DD.log` faylida saqlanadi.

### Yangilash

```bash
cd /opt/uzumOrderToMC
git pull
npm ci --omit=dev   # dependency o'zgargan bo'lsa
# timer keyingi tsiklda yangi kodni avtomatik oladi
```
