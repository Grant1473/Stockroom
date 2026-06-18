const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");
const XLSX = require("xlsx");

const PORT = 5500;
const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css"
};

const CONFIG_PATH = path.join(__dirname, "excel-config.json");

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { return { excelPath: "", supabaseUrl: "", supabaseKey: "" }; }
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function excelSerialToDateStr(val) {
  if (val == null || val === "") return "";
  const num = Number(val);
  if (Number.isNaN(num)) return String(val);
  const d = new Date(Math.round((num - 25569) * 86400000));
  if (isNaN(d.getTime())) return String(val);
  return (d.getUTCMonth() + 1) + "/" + d.getUTCDate() + "/" + String(d.getUTCFullYear()).slice(-2);
}

function supabaseFetch(url, options) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: options.method || "POST",
      headers: options.headers || {}
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // ── Sync Excel endpoint ──────────────────────────────────────
  if (pathname === "/api/sync-excel" && req.method === "POST") {
    parseBody(req).then(async (body) => {
      const cfg = readConfig();
      const excelPath = body.excelPath || cfg.excelPath;
      const supabaseUrl = body.supabaseUrl || cfg.supabaseUrl;
      const supabaseKey = body.supabaseKey || cfg.supabaseKey;

      if (!excelPath) return sendJson(res, 400, { error: "Excel path not configured" });
      if (!supabaseUrl || !supabaseKey) return sendJson(res, 400, { error: "Supabase not configured" });

      if (!fs.existsSync(excelPath)) return sendJson(res, 400, { error: "Excel file not found at: " + excelPath });

      try {
        const wb = XLSX.readFile(excelPath, { cellDates: false, raw: true });
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
        if (!rows.length) return sendJson(res, 200, { count: 0, message: "Excel file is empty" });

        const seen = new Set();
        const payload = [];

        for (const row of rows) {
          const orderNumber = String(row["Order Number"] || "").trim();
          if (!orderNumber || seen.has(orderNumber)) continue;
          seen.add(orderNumber);

          payload.push({
            order_number: orderNumber,
            order_date: excelSerialToDateStr(row["Order Date"]),
            ship_date: excelSerialToDateStr(row["Ship Date"]),
            qty: String(row["QTY"] ?? ""),
            product: String(row["Product"] ?? ""),
            stain_color: String(row["Stain color"] ?? ""),
            cover: String(row["Cover"] ?? ""),
            plaque: String(row["Plaque"] ?? ""),
            customizations: String(row["Customizations"] ?? ""),
            po: String(row["P.O"] ?? ""),
            retailer: String(row["Retailer"] ?? ""),
            ship_to: String(row["Ship To"] ?? "")
          });
        }

        const apiUrl = supabaseUrl.replace(/\/$/, "") + "/rest/v1/orders?on_conflict=order_number";
        const result = await supabaseFetch(apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": supabaseKey,
            "Authorization": "Bearer " + supabaseKey,
            "Prefer": "resolution=merge-duplicates,return=representation"
          },
          body: JSON.stringify(payload)
        });

        if (result.status >= 400) {
          sendJson(res, 500, { error: "Supabase error: " + result.status + " " + result.body });
        } else {
          sendJson(res, 200, { count: payload.length, message: "Synced " + payload.length + " orders" });
        }
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
    }).catch(e => sendJson(res, 400, { error: e.message }));
    return;
  }

  // ── Supabase config endpoint ───────────────────────────────
  if (pathname === "/api/supabase-config" && req.method === "GET") {
    const cfg = readConfig();
    sendJson(res, 200, { url: cfg.supabaseUrl || "", key: cfg.supabaseKey || "" });
    return;
  }

  // ── Save Excel path ─────────────────────────────────────────
  if (pathname === "/api/excel-config" && req.method === "POST") {
    parseBody(req).then((body) => {
      const cfg = readConfig();
      if (body.excelPath !== undefined) cfg.excelPath = body.excelPath;
      if (body.supabaseUrl !== undefined) cfg.supabaseUrl = body.supabaseUrl;
      if (body.supabaseKey !== undefined) cfg.supabaseKey = body.supabaseKey;
      writeConfig(cfg);
      sendJson(res, 200, { ok: true });
    }).catch(e => sendJson(res, 400, { error: e.message }));
    return;
  }

  if (pathname === "/api/excel-config" && req.method === "GET") {
    const cfg = readConfig();
    sendJson(res, 200, { excelPath: cfg.excelPath || "" });
    return;
  }

  // ── Static file serving ─────────────────────────────────────
  let filePath = path.join(__dirname, pathname === "/" ? "index.html" : pathname);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`Stockroom running at http://localhost:${PORT}`);
});
