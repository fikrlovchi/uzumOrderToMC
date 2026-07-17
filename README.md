# uzumOrderToMC

Uzum jadvalidagi (Google Sheets) yangi buyurtmalarni MoySklad'ga `customerorder`
sifatida yaratadi. Google Apps Script kodining Node.js versiyasi.

## Ishlash mantig'i

Har 2 daqiqada, bitta ishga tushirishda ketma-ket:

1. **Uzum'dan yangi buyurtmalarni olish** (`src/orderFetch.js`) — har bir
   do'kon (`.env`dagi `UZUM_TOKEN_*`/`UZUM_SHOP_*`) uchun `CREATED` holatidagi
   buyurtmalarni sahifalab so'raydi, yangilarini `uzum_order`/
   `uzum_order_detail`ga qo'shadi. **uzbuyo@gmail.com** OAuth akkaunti
   nomidan yozadi (pastga qarang), service account emas.
2. **MoySklad'da yaratish** — `Q` ustuni (status) `1` bo'lmagan qatorlarni
   `uzum_order_detail`dan yig'ib, MoySklad'ga `customerorder` sifatida POST
   qiladi; muvaffaqiyatli bo'lsa `Q`=1 va `S`=MoySklad ID yoziladi.
3. **Bekor qilishni sinxronlash** (`src/cancelSync.js`) — o'zining mustaqil
   lokal holati (`data/cancel-state.json`, sheetga bog'liq emas) orqali
   Uzum'dan `CANCELED` ro'yxatini har do'konning saqlangan sahifa kursoridan
   sahifalab o'qiydi, har bir buyurtmani MoySklad'da `externalCode` orqali
   topadi; agar allaqachon "himoyalangan" holatda bo'lmasa — bekor qilingan
   holatga o'tkazadi va mas'ul odamni belgilab Telegram'ga xabar beradi.
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

> `uzum_order!V` (`cancelHandled`) ustuni endi ishlatilmaydi — bekor qilishni
> kuzatish butunlay `data/cancel-state.json`ga ko'chirilgan (pastga qarang).

## Kerakli fayllar

| Fayl | Izoh |
|------|------|
| `config.json` | Spreadsheet ID, varaq/ustun nomlari, MoySklad havolalari/holatlari. Git'da bor. |
| `credentials.json` | Google service account kaliti (o'qish/asosiy yozishlar uchun). **Git'ga tushmaydi.** |
| `oauth.json` | `uzbuyo@gmail.com` OAuth2 kalitlari (faqat yangi buyurtma import qilishda yozish uchun). **Git'ga tushmaydi.** |
| `.env` | `MOYSKLAD_TOKEN` (majburiy), oyna/mas'ul-odam sozlamalari, `fikrlovchi-panel`/Telegram (ixtiyoriy). **Git'ga tushmaydi.** |

## Buyurtma status sinxronizatsiyasi — sozlash

### `oauth.json` (yangi buyurtmalarni import qilish uchun)

Bu qism `uzbuyo@gmail.com` nomidan yozishi kerak (service account'da emas), chunki
sheet'ning asl egasi shu akkaunt. Loyihada bu maqsad uchun allaqachon ishlayotgan
kalit bor — uni shunchaki nusxalash kifoya:

```bash
cp ../uzumPDFs/oauth.json ./oauth.json
```

(Server yo'li boshqacha bo'lsa mos ravishda o'zgartiring — asosiysi fayl
`{"client_id", "client_secret", "refresh_token"}` shaklida bo'lishi kerak.)

### Yangi `.env` o'zgaruvchilari

```
WINDOW_HOLD_START=06:10
WINDOW_HOLD_END=11:00
CANCEL_NOTIFY_NAME=...
CANCEL_NOTIFY_CHAT_ID=...
```

`WINDOW_HOLD_START`/`END` — Toshkent vaqti bilan, shu oraliqda tasdiqlangan
buyurtmalar MoySklad'da vaqtincha "kutish" holatida turadi, oyna tugagach
avtomatik "tasdiqlangan"ga o'tadi. `CANCEL_NOTIFY_NAME`/`CHAT_ID` — bekor
qilingan buyurtma haqida Telegram xabarida belgilanadigan (tag qilinadigan)
mas'ul odam.

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

### `cancelUzumOrder` loyihasini birlashtirish

Bekor qilishni aniqlash mantig'i ilgari alohida `cancelUzumOrder` servisi
sifatida ishlar edi (o'zining kunlik so'rov limiti, sahifa-kursori va
`externalCode` orqali MoySklad qidiruvi bilan). Bu mantiq endi to'liq shu
loyihaga ko'chirilgan (`src/cancelState.js`, `src/uzumCabinets.js`,
`src/uzumCancelSweep.js`, `src/cancelSync.js`). **Shu funksiya serverda
ishga tushirilgach, eski `cancelUzumOrder` xizmatini (va agar Apps
Script'da alohida trigger sifatida ham qolgan bo'lsa — uni ham) o'chiring**
— aks holda bir nechta jarayon bir vaqtda Uzum/MoySklad'ga so'rov yuborib,
tezlik-limitiga (429) tez uchraydi.

**Muhim topilma:** Uzum'ning CANCELED ro'yxati buyurtmaning bekor qilingan
sanasi (`dateCancelled`) emas, balki **yaratilgan sanasi (`dateCreated`)
bo'yicha kamayish tartibida** qaytadi (tekshirilgan). Bu degani — sahifalar
vaqt o'tishi bilan "muhrlanmaydi": ancha oldin yaratilgan buyurtma bugun
bekor qilinsa, u ro'yxatning chuqur qismida joylashaveradi. Shuning uchun
saqlangan sahifa kursori ishlatilmaydi (buyurtmalarni o'tkazib yuborishi
mumkin edi). O'rniga ikki qatlamli skanerlash:
- **Har tsiklda (2 daqiqa) yengil skanerlash** — `shallowMaxPages` (standart 3)
  sahifagacha, yaqinda yaratilgan buyurtmaning bekor qilinishini tez ushlaydi.
- **`deepSweepIntervalMs`da (standart 1 soat) bir marta chuqur skanerlash** —
  `maxLookbackDays` (standart 30 kun) gacha to'liq, ancha oldin yaratilgan
  buyurtma hozir bekor qilingan kamdan-kam holatni ushlaydi.

Ikkalasi ham sahifadagi eng eski yozuvning `dateCreated`i `maxLookbackDays`dan
eskirganda to'xtaydi — ro'yxat shu tartibda ekan, undan naryog'i ham albatta
eskiroq bo'ladi.

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

### 4. `credentials.json` ni joylash

Lokal kompyuterdan serverga xavfsiz nusxalang (git'ga qo'ymang):

```bash
scp credentials.json USER@SERVER:/opt/uzumOrderToMC/credentials.json
```

Service account email'iga (`credentials.json` -> `client_email`) Google Sheet'da
**Editor** huquqi berilganiga ishonch hosil qiling.

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
