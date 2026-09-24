import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** QR code as rows of "0"/"1" so the native window can draw it without dependencies. */
export function qrMatrix(text: string): string[] {
  const QRCode = require("qrcode-terminal/vendor/QRCode/index.js") as new (type: number, level: number) => {
    addData(s: string): void;
    make(): void;
    getModuleCount(): number;
    isDark(r: number, c: number): boolean;
  };
  const Level = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js") as { M: number };
  const qr = new QRCode(-1, Level.M);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const rows: string[] = [];
  for (let r = 0; r < n; r++) {
    let row = "";
    for (let c = 0; c < n; c++) row += qr.isDark(r, c) ? "1" : "0";
    rows.push(row);
  }
  return rows;
}
