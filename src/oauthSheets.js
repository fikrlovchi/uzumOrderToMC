const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

// OAuth2 — haqiqiy Google akkaunt (uzbuyo@gmail.com) nomidan ishlaydi.
// uzum_order/uzum_order_detail'ga yangi qatorlar shu akkaunt nomidan yoziladi
// (qolgan barcha o'qish/yozishlar hamon service account orqali, config.json'dagi
// credentialsPath). oauth.json (git'da yo'q, .gitignore'da) uzumPDFs loyihasidagi
// bilan bir xil formatda:
// { "client_id": "...", "client_secret": "...", "refresh_token": "1//..." }
const OAUTH_FILE = process.env.OAUTH_FILE || path.join(__dirname, "..", "oauth.json");

// oauth.json topilmasa xato faqat shu klientdan foydalanmoqchi bo'lganda
// (masalan Step A) chiqadi, index.js'ning qolgan qismini yiqitmaydi.
let cachedSheets = null;

function getSheetsClient() {
  if (cachedSheets) return cachedSheets;

  const creds = JSON.parse(fs.readFileSync(OAUTH_FILE, "utf8"));
  const oauth2Client = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    "https://developers.google.com/oauthplayground"
  );
  oauth2Client.setCredentials({ refresh_token: creds.refresh_token });

  cachedSheets = google.sheets({ version: "v4", auth: oauth2Client });
  return cachedSheets;
}

module.exports = { getSheetsClient };
