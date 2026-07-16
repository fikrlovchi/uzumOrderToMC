# uzumOrderToMC

Uzum jadvalidagi (Google Sheets) yangi buyurtmalarni MoySklad'ga `customerorder`
sifatida yaratadi. Google Apps Script kodining Node.js versiyasi.

## Ishlash mantig'i

Har 2 daqiqada, bitta ishga tushirishda ketma-ket:

1. **Uzum'dan yangi buyurtmalarni olish** (`src/orderFetch.js`) — har bir do'kon
   (`uzum_shop`) uchun `CREATED` holatidagi buyurtmalarni sahifalab so'raydi,
   yangilarini `uzum_order`/`uzum_order_detail`ga qo'shadi. **uzbuyo@gmail.com**
   OAuth akkaunti nomidan yozadi (pastga qarang), service account emas.
2. **MoySklad'da yaratish** — `Q` ustuni (status) `1` bo'lmagan qatorlarni
   `uzum_order_detail`dan yig'ib, MoySklad'ga `customerorder` sifatida POST
   qiladi; muvaffaqiyatli bo'lsa `Q`=1 va `S`=MoySklad ID yoziladi.
3. **Bekor qilishni sinxronlash** (`src/cancelSync.js`) — `Q`=1 va hali
   bekor-qilish-tekshiruvi o'tkazilmagan (`V` bo'sh) buyurtmalar uchun Uzum'dan
   `CANCELED` ro'yxatini so'raydi; topilsa MoySklad holatini bekor qilingan
   qilib qo'yadi (agar MoySklad allaqachon "himoyalangan" holatda bo'lmasa) va
   Telegram'ga xabar yuboradi.
4. **Kutish oynasidan chiqarish** (`src/orderStatusSync.js`) — Toshkent vaqti
   bilan `WINDOW_HOLD_END`dan o'tgan bo'lsa, hali "kutish" holatida (`U`=`hold`)
   turgan buyurtmalarni "tasdiqlangan" holatga o'tkazadi.
5. **Yangi buyurtmalarni Uzum'da tasdiqlash + MoySklad holatini o'rnatish** —
   `Q`=1 va hali tasdiqlanmagan (`T` bo'sh) buyurtmalarni Uzum'da tasdiqlaydi
   (CREATED→PACKING), so'ng joriy vaqtga qarab MoySklad holatini "kutish" yoki
   "tasdiqlangan" qilib qo'yadi.

MoySklad tokeni `.env`dagi `MOYSKLAD_TOKEN`dan olinadi — `fikrlovchi-panel`
"O'zgaruvchilar" sahifasidan markazlashtirilgan holda boshqariladi.

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

### `uzum_shop` varag'i

`A`=shopId, `B`=do'kon nomi, `C`=Uzum Seller API tokeni. Har bir do'kon uchun
shu yerda token bo'lishi kerak — bo'lmasa, shu do'kon uchun import/tasdiqlash/
bekor-qilish tekshiruvi jimgina o'tkazib yuboriladi (xato sifatida loglanadi).

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
