const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");
const XLSX = require("xlsx");
const sqlite3 = require("sqlite3").verbose();

const STORAGE_BUCKET = "order-files";
const PORT = 5500;

// Initialize SQLite database for file uploads tracking
let db;
try {
  db = new sqlite3.Database(path.join(__dirname, "file_uploads.db"), (err) => {
    if (err) {
      console.error("Error initializing database:", err.message);
    } else {
      console.log("Connected to SQLite database for file uploads tracking");
      initDatabase();
    }
  });
} catch (err) {
  console.error("Failed to initialize database:", err);
  process.exit(1);
}

function initDatabase() {
  const sql = `CREATE TABLE IF NOT EXISTS file_uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT NOT NULL,
    file_name TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    upload_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    file_type TEXT,
    file_size INTEGER,
    uploaded_by TEXT,
    UNIQUE(order_number, file_name)
  );
  CREATE INDEX IF NOT EXISTS idx_order_number ON file_uploads(order_number);
  CREATE INDEX IF NOT EXISTS idx_upload_date ON file_uploads(upload_date);
  CREATE TABLE IF NOT EXISTS order_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT NOT NULL,
    file_name TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    upload_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    file_type TEXT,
    file_size INTEGER,
    uploaded_by TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_order_attachments_order ON order_attachments(order_number);
  CREATE INDEX IF NOT EXISTS idx_order_attachments_date ON order_attachments(upload_date);`;

  db.exec(sql, (err) => {
    if (err) {
      console.error("Error creating tables:", err.message);
    } else {
      console.log("Database tables created successfully");
    }
  });
}

// ── Supabase Configuration ──────────────────────────────────────
// Set SUPABASE_URL and SUPABASE_KEY as environment variables,
// or they'll be read from excel-config.json
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css"
};

const CONFIG_PATH = path.join(__dirname, "excel-config.json");

function readConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return {
      supabaseUrl: SUPABASE_URL || cfg.supabaseUrl || "https://kfcdgafhzcdddwhknult.supabase.co",
      supabaseKey: SUPABASE_KEY || cfg.supabaseKey || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtmY2RnYWZoemNkZGR3aGtudWx0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5OTE2OTUsImV4cCI6MjA5NTU2NzY5NX0.KduXGxt-w9Wk6slJG5AIoM2seCZCRtDqvMXTAsCvAZM",
      excelPath: cfg.excelPath || ""
    };
  } catch {
    return { supabaseUrl: SUPABASE_URL || "https://kfcdgafhzcdddwhknult.supabase.co", supabaseKey: SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtmY2RnYWZoemNkZGR3aGtudWx0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5OTE2OTUsImV4cCI6MjA5NTU2NzY5NX0.KduXGxt-w9Wk6slJG5AIoM2seCZCRtDqvMXTAsCvAZM", excelPath: "" };
  }
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
      method: options.method || "POST"
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (options.headers) {
      Object.keys(options.headers).forEach(key => {
        req.setHeader(key, options.headers[key]);
      });
    }
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

  // ── File upload to Supabase Storage ─────────────────────────
  if (pathname === "/api/upload" && req.method === "POST") {
    parseBody(req).then(async (body) => {
      const cfg = readConfig();
      const orderNumber = body.orderNumber;
      const fileName = body.fileName;
      const data = body.data; // base64
      if (!orderNumber || !fileName || !data) {
        return sendJson(res, 400, { error: "Missing orderNumber, fileName, or data" });
      }
      const safe = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "_");
      const objectPath = `${String(orderNumber)}/${safe}`;
      const buffer = Buffer.from(data, "base64");
      const apiUrl = `${cfg.supabaseUrl}/storage/v1/object/${STORAGE_BUCKET}/${objectPath}`;
      const result = await supabaseFetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "apikey": cfg.supabaseKey,
          "Authorization": "Bearer " + cfg.supabaseKey
        },
        body: buffer
      });
      if (result.status >= 400) {
        sendJson(res, 500, { error: "Storage error: " + result.status + " " + result.body });
      } else {
        const fileType = fileName.split(".").pop() || "unknown";
        const fileSize = Buffer.byteLength(buffer);
        
        db.run(
          "INSERT INTO file_uploads (order_number, file_name, storage_path, file_type, file_size) VALUES (?, ?, ?, ?, ?)",
          [orderNumber, safe, objectPath, fileType, fileSize],
          function(err) {
            if (err) {
              sendJson(res, 500, { error: "Database error: " + err.message });
            } else {
              sendJson(res, 200, { fileName: safe });
            }
          }
        );
      }
    }).catch(e => sendJson(res, 400, { error: e.message }));
    return;
  }

  // ── List files from Supabase Storage ────────────────────────
  if (pathname === "/api/files" && req.method === "GET") {
    const orderNumber = parsed.query.orderNumber;
    if (!orderNumber) return sendJson(res, 400, { error: "Missing orderNumber" });
    const cfg = readConfig();
    const apiUrl = `${cfg.supabaseUrl}/storage/v1/object/list/${STORAGE_BUCKET}`;
    supabaseFetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": cfg.supabaseKey,
        "Authorization": "Bearer " + cfg.supabaseKey
      },
      body: JSON.stringify({ prefix: String(orderNumber) + "/", limit: 100, offset: 0 })
    }).then(result => {
      if (result.status >= 400) { sendJson(res, 200, []); return; }
      let items;
      try { items = JSON.parse(result.body); } catch { items = []; }
      const files = Array.isArray(items)
        ? items.map(i => i.name?.replace(String(orderNumber) + "/", "")).filter(Boolean)
        : [];
      sendJson(res, 200, files);
    }).catch(e => sendJson(res, 500, { error: e.message }));
    return;
  }

  // ── Get file upload history from SQLite ──────────────────────
  if (pathname === "/api/file-history" && req.method === "GET") {
    const orderNumber = parsed.query.orderNumber;
    if (!orderNumber) return sendJson(res, 400, { error: "Missing orderNumber" });
    
    db.all(
      "SELECT id, file_name, upload_date, file_type, file_size FROM file_uploads WHERE order_number = ? ORDER BY upload_date DESC",
      [orderNumber],
      (err, rows) => {
        if (err) {
          sendJson(res, 500, { error: "Database error: " + err.message });
        } else {
          sendJson(res, 200, rows || []);
        }
      }
    );
    return;
  }

  // ── Delete file from Supabase Storage ───────────────────────
  if (pathname === "/api/files" && req.method === "DELETE") {
    parseBody(req).then(async (body) => {
      const cfg = readConfig();
      const orderNumber = body.orderNumber;
      const fileName = body.fileName;
      if (!orderNumber || !fileName) return sendJson(res, 400, { error: "Missing orderNumber or fileName" });
      const objectPath = `${String(orderNumber)}/${path.basename(fileName)}`;
      const apiUrl = `${cfg.supabaseUrl}/storage/v1/object/${STORAGE_BUCKET}`;
      const result = await supabaseFetch(apiUrl, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "apikey": cfg.supabaseKey,
          "Authorization": "Bearer " + cfg.supabaseKey
        },
        body: JSON.stringify({ prefixes: [objectPath] })
      });
      sendJson(res, 200, { ok: true });
    }).catch(e => sendJson(res, 400, { error: e.message }));
    return;
  }

  // ── Redirect to Supabase Storage public URL ─────────────────
  if (pathname.startsWith("/uploads/")) {
    const cfg = readConfig();
    const relPath = pathname.slice("/uploads/".length);
    const publicUrl = `${cfg.supabaseUrl}/storage/v1/object/public/${STORAGE_BUCKET}/${relPath}`;
    res.writeHead(302, { Location: publicUrl });
    res.end();
    return;
  }

  if (pathname === "/api/attachments" && req.method === "POST") {
    parseBody(req).then(async (body) => {
      const cfg = readConfig();
      const orderNumber = body.orderNumber;
      const fileName = body.fileName;
      const data = body.data;
      if (!orderNumber || !fileName || !data) {
        return sendJson(res, 400, { error: "Missing orderNumber, fileName, or data" });
      }
      const safe = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, "_");
      const objectPath = `${String(orderNumber)}/${safe}`;
      const buffer = Buffer.from(data, "base64");
      const apiUrl = `${cfg.supabaseUrl}/storage/v1/object/${STORAGE_BUCKET}/${objectPath}`;
      const result = await supabaseFetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "apikey": cfg.supabaseKey,
          "Authorization": "Bearer " + cfg.supabaseKey
        },
        body: buffer
      });
      if (result.status >= 400) {
        sendJson(res, 500, { error: "Storage error: " + result.status + " " + result.body });
      } else {
        const fileType = fileName.split(".").pop() || "unknown";
        const fileSize = Buffer.byteLength(buffer);
        db.run(
          "INSERT INTO order_attachments (order_number, file_name, storage_path, file_type, file_size) VALUES (?, ?, ?, ?, ?)",
          [orderNumber, safe, objectPath, fileType, fileSize],
          function(err) {
            if (err) {
              sendJson(res, 500, { error: "Database error: " + err.message });
            } else {
              sendJson(res, 200, { fileName: safe });
            }
          }
        );
      }
    }).catch(e => sendJson(res, 400, { error: e.message }));
    return;
  }

  if (pathname === "/api/attachments" && req.method === "GET") {
    const orderNumber = parsed.query.orderNumber;
    if (!orderNumber) return sendJson(res, 400, { error: "Missing orderNumber" });
    db.all(
      "SELECT file_name, upload_date, file_type, file_size FROM order_attachments WHERE order_number = ? ORDER BY upload_date DESC",
      [orderNumber],
      (err, rows) => {
        if (err) {
          sendJson(res, 500, { error: "Database error: " + err.message });
        } else {
          sendJson(res, 200, rows || []);
        }
      }
    );
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
  console.log(`Inventory running at http://localhost:${PORT}`);
});
