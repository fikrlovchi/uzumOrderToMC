# uzumOrderToMC

Uzum jadvalidagi (Google Sheets) yangi buyurtmalarni MoySklad'ga `customerorder`
sifatida yaratadi. Google Apps Script kodining Node.js versiyasi.

## Ishlash mantig'i

- `uzum_order` varag'idagi har bir qatorni ko'rib chiqadi.
- `Q` ustuni (status) `1` bo'lsa yoki `A` (order id) bo'sh bo'lsa — o'tkazib yuboradi.
- `uzum_order_detail` dan shu buyurtmaning pozitsiyalarini yig'adi.
- MoySklad'ga POST qiladi; muvaffaqiyatli bo'lsa `Q`=1 va `S`=MoySklad ID yoziladi.
- MoySklad tokeni `mc_token!A2` katakdan olinadi (kodda saqlanmaydi).

## Kerakli fayllar

| Fayl | Izoh |
|------|------|
| `config.json` | Spreadsheet ID, varaq/ustun nomlari, MoySklad havolalari. Git'da bor. |
| `credentials.json` | Google service account kaliti. **Git'ga tushmaydi** — qo'lda joylash kerak. |
| `.env` | `fikrlovchi-panel` bilan bog'lanish uchun (ixtiyoriy). **Git'ga tushmaydi.** |

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
