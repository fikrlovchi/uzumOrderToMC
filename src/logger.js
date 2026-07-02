const fs = require("fs");
const path = require("path");

const logDir = path.join(__dirname, "..", "logs");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, `${new Date().toISOString().slice(0, 10)}.log`);

function write(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  console.log(line);
  fs.appendFileSync(logFile, line + "\n");
}

module.exports = {
  info: (msg) => write("INFO", msg),
  error: (msg) => write("ERROR", msg),
};
