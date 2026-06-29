let products = [{ id: 1, name: "", qtyMade: "", selectedMaterials: [], buildSpecs: [] }];
let materials = [{ id: 1, woodName: "", thickness: "", type: "", qty: "", lowStockThreshold: "" }];
let jobs = [];
let orders = [];
let jobBuilds = [];
let supabaseConfig = { url: "", key: "" };
let autoSaveTimers = new Map();
let syncReady = false;
let _idCounter = 0;
let currentUser = null;
let openEditorIds = new Set();
let supabaseReconnectTimer = null;
let loginScreenCheckTimer = null;

const jobStages = ["New Order", "In Production", "In Hangout", "Ready To Ship"];
const materialTypes = ["", "Hardwood", "Plywood", "MDF", "Other"];
const allTabs = ["dashboard", "products", "materials", "workboard", "jobbuilds", "orders", "permissions", "activity"];
const titleMap = {
  dashboard: "Inventory Dashboard",
  products: "Products",
  materials: "Raw Materials",
  workboard: "Product Workboard",
  jobbuilds: "Job Builds",
  orders: "Orders",
  permissions: "Permissions",
  activity: "Activity Log"
};

const el = (selector) => document.querySelector(selector);
const els = (selector) => [...document.querySelectorAll(selector)];
const isConnected = () => supabaseConfig.url && supabaseConfig.key;

let isReady = false;

function loadSession() {
  try {
    const raw = localStorage.getItem("inventory_user");
    if (raw) currentUser = JSON.parse(raw);
  } catch { currentUser = null; }
}

function saveSession(user) {
  currentUser = user;
  localStorage.setItem("inventory_user", JSON.stringify(user));
}

function clearSession() {
  currentUser = null;
  localStorage.removeItem("inventory_user");
}

function applyPermissions() {
  if (!currentUser) return;
  els(".nav-item").forEach(btn => {
    const view = btn.dataset.view;
    btn.style.display = currentUser.tabs.includes(view) ? "" : "none";
  });
}

async function login(username, password) {
  if (!isConnected()) {
    const reconnected = await ensureSupabaseConnection();
    if (!reconnected) throw new Error("Configure Supabase URL and key in Settings first");
  }
  let rows;
  try {
    rows = await supabaseRequest("users", {
      params: `?username=ilike.${encodeURIComponent(username)}&password=eq.${encodeURIComponent(password)}&select=username,tabs`
    });
  } catch (e) {
    throw new Error("Supabase error: " + e.message);
  }
  if (!rows || !rows.length) throw new Error("Invalid username or password");
  saveSession(rows[0]);
  el("#login-overlay").classList.add("hidden");
  applyPermissions();
  if (!isReady) { isReady = true; initApp(); }
  startSupabaseReconnection();
  logGlobalActivity("login", `User logged in as "${username}"`);
}

function logout() {
  logGlobalActivity("logout", `User logged out`);
  clearSession();
  if (supabaseReconnectTimer) clearTimeout(supabaseReconnectTimer);
  supabaseReconnectTimer = null;
  el("#login-overlay").classList.remove("hidden");
  el("#login-username").value = "";
  el("#login-password").value = "";
  el("#login-error").textContent = "";
}

function uniqueId() {
  return Date.now() + (++_idCounter % 1000);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "No date";
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(year, month - 1, day));
}

function visibleProducts() {
  return products;
}

function setSyncStatus(message) {
  document.querySelectorAll(".sync-indicator").forEach(indicator => {
    indicator.textContent = message;
    indicator.className = "sync-indicator";
    if (message === "Auto-sync on" || message === "Connected") indicator.classList.add("synced");
    else if (message === "Saving..." || message === "Saving soon..." || message === "Loading...") indicator.classList.add("saving");
    else if (message?.includes("fail") || message?.includes("error") || message?.includes("Error")) indicator.classList.add("error");
  });
}

function cleanSupabaseUrl() {
  return supabaseConfig.url.replace(/\/$/, "");
}

async function supabaseRequest(table, options = {}) {
  if (!isConnected()) throw new Error("Add your Supabase URL and anon key first.");

  const params = options.params || "";
  const response = await fetch(`${cleanSupabaseUrl()}/rest/v1/${table}${params}`, {
    method: options.method || "GET",
    headers: {
      apikey: supabaseConfig.key,
      Authorization: `Bearer ${supabaseConfig.key}`,
      "Content-Type": "application/json",
      Prefer: options.prefer || "return=representation"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Supabase request failed: ${response.status}`);
  }

  if (response.status === 204) return [];

  const text = await response.text();
  if (!text) return [];
  return JSON.parse(text);
}

function productToDb(product) {
  return {
    id: product.id,
    name: product.name,
    materials_needed: JSON.stringify(product.selectedMaterials || []),
    qty_made: product.qtyMade || "",
    build_specs: JSON.stringify(product.buildSpecs || [])
  };
}

function materialToDb(material) {
  return {
    id: material.id,
    wood_name: material.woodName,
    thickness: material.thickness,
    type: material.type,
    qty: material.qty,
    low_stock_threshold: material.lowStockThreshold || ""
  };
}

function jobToDb(job) {
  return {
    id: job.id,
    product_id: job.productId,
    order_id: job.orderId || null,
    stage: job.stage
  };
}

function getLocalOrderMeta(orderNumber) {
  try { return JSON.parse(localStorage.getItem("order_meta") || "{}")[orderNumber]; } catch { return null; }
}
function setLocalOrderMeta(orderNumber, data) {
  try { const m = JSON.parse(localStorage.getItem("order_meta") || "{}"); m[orderNumber] = { ...m[orderNumber], ...data }; localStorage.setItem("order_meta", JSON.stringify(m)); } catch {}
}

function orderToDb(order) {
  return {
    order_number: order.orderNumber || "",
    order_date: order.orderDate || "",
    ship_date: order.shipDate || "",
    qty: order.qty || "1",
    product: order.productName || "",
    stain_color: order.stainType || "",
    cover: order.cover || "",
    plaque: order.plaque || "",
    customizations: order.customizations || "",
    po: order.po || "",
    retailer: order.retailer || "",
    ship_to: order.shipTo || "",
    build_specs: JSON.stringify(order.buildSpecs || [])
  };
}

function jobBuildToDb(build) {
  return {
    id: build.id,
    build_number: build.buildNumber,
    product_count: build.productCount || "",
    stage: build.stage || "New Order"
  };
}

function dbToProduct(row) {
  let selectedMaterials = [];
  try { selectedMaterials = JSON.parse(row.materials_needed || "[]"); } catch { selectedMaterials = []; }
  let buildSpecs = [];
  try { const p = JSON.parse(row.build_specs || "[]"); buildSpecs = Array.isArray(p) ? p : []; } catch { buildSpecs = []; }
  return {
    id: Number(row.id),
    name: row.name || "",
    qtyMade: row.qty_made || "",
    selectedMaterials: Array.isArray(selectedMaterials) ? selectedMaterials : [],
    buildSpecs
  };
}

function dbToMaterial(row) {
  return {
    id: Number(row.id),
    woodName: row.wood_name || "",
    thickness: row.thickness || "",
    type: row.type || "",
    qty: row.qty || "",
    lowStockThreshold: row.low_stock_threshold || ""
  };
}

function dbToJob(row) {
  return {
    id: Number(row.id),
    productId: Number(row.product_id),
    orderId: row.order_id ? Number(row.order_id) : null,
    stage: row.stage || "New Order"
  };
}

function excelSerialToDateStr(val) {
  if (!val) return "";
  const num = Number(val);
  if (Number.isNaN(num)) return val;
  const d = new Date(Math.round(num - 25569) * 86400000);
  if (isNaN(d.getTime())) return val;
  const mo = String(d.getUTCMonth() + 1);
  const da = String(d.getUTCDate());
  const yr = String(d.getUTCFullYear()).slice(-2);
  return mo + "/" + da + "/" + yr;
}

function dbToOrder(row) {
  let buildSpecs = [];
  try { const p = JSON.parse(row.build_specs || "[]"); buildSpecs = Array.isArray(p) ? p : []; } catch { buildSpecs = []; }
  return {
    id: uniqueId(),
    orderNumber: row.order_number || "",
    orderDate: excelSerialToDateStr(row.order_date),
    shipDate: excelSerialToDateStr(row.ship_date),
    qty: row.qty || "1",
    productName: row.product || "",
    stainType: row.stain_color || "",
    cover: row.cover || "",
    plaque: row.plaque || "",
    customizations: row.customizations || "",
    po: row.po || "",
    retailer: row.retailer || "",
    shipTo: row.ship_to || "",
    productId: null,
    materialId: null,
    materialName: "",
    jobBuildNumber: "",
    status: row.status || "New",
    stage: getLocalOrderMeta(row.order_number)?.stage || row.stage || "New Order",
    buildSpecs
  };
}

function dbToJobBuild(row) {
  return {
    id: Number(row.id),
    buildNumber: row.build_number || "",
    productCount: row.product_count || "",
    stage: row.stage || "New Order"
  };
}

async function replaceTable(table, rows) {
  await supabaseRequest(table, {
    method: "DELETE",
    params: "?id=not.is.null",
    prefer: "return=minimal"
  });

  if (!rows.length) return [];

  return supabaseRequest(table, {
    method: "POST",
    body: rows,
    prefer: "return=representation"
  });
}

async function loadFromSupabase() {
  setSyncStatus("Loading...");
  logGlobalActivity("save", "Loading data from Supabase...");
  const [productRows, materialRows, orderRows, jobRows, jobBuildRows] = await Promise.all([
    supabaseRequest("products", { params: "?select=*&order=id.asc" }).catch(() => []),
    supabaseRequest("materials", { params: "?select=*&order=id.asc" }).catch(() => []),
    supabaseRequest("orders", { params: "?select=*&order=order_number.asc" }).catch(() => []),
    supabaseRequest("jobs", { params: "?select=*&order=id.asc" }).catch(() => []),
    supabaseRequest("job_builds", { params: "?select=*&order=id.asc" }).catch(() => [])
  ]);

  products = productRows.map(dbToProduct);
  materials = materialRows.map(dbToMaterial);
  orders = orderRows.map(dbToOrder);
  jobs = jobRows.map(dbToJob).filter((job) => !job.orderId && products.some((product) => product.id === job.productId));
  jobBuilds = jobBuildRows.map(dbToJobBuild);

  orders.forEach(order => {
    if (!order.buildSpecs || order.buildSpecs.length === 0) {
      const match = products.find(p => p.name && order.productName.toLowerCase().includes(p.name.toLowerCase()));
      if (match && Array.isArray(match.buildSpecs)) {
        order.buildSpecs = match.buildSpecs.map(t => ({ ...t, done: false }));
      }
    }
  });

  if (!products.length) products = [{ id: uniqueId(), name: "", qtyMade: "", selectedMaterials: [], buildSpecs: [] }];
  if (!materials.length) materials = [{ id: uniqueId(), woodName: "", thickness: "", type: "", qty: "", lowStockThreshold: "" }];

  renderAll();
  syncReady = true;
  setSyncStatus("Auto-sync on");
}

async function saveToSupabase() {
  setSyncStatus("Saving...");
  const productRows = products
    .filter((product) => product.name || product.qtyMade || (product.selectedMaterials && product.selectedMaterials.length > 0))
    .map(productToDb);
  const materialRows = materials
    .filter((material) => material.woodName || material.thickness || material.type || material.qty)
    .map(materialToDb);
  const productIds = new Set(productRows.map((product) => product.id));
  const standaloneJobs = jobs.filter(j => !j.orderId);
  const jobRows = standaloneJobs
    .filter((job) => productIds.has(job.productId))
    .map(jobToDb);
  const orderRows = orders.map(orderToDb);
  const jobBuildRows = jobBuilds.map(jobBuildToDb);

  await Promise.all([
    ...productRows.map(r => upsertRow("products", r)),
    ...materialRows.map(r => upsertRow("materials", r)),
    ...jobRows.map(r => upsertRow("jobs", r)),
    ...orderRows.map(r => upsertRow("orders", r)),
    ...jobBuildRows.map(r => upsertRow("job_builds", r))
  ]);
  syncReady = true;
  setSyncStatus("Auto-sync on");
}

async function upsertRow(table, row) {
  const conflict = table === "orders" ? "order_number" : "id";
  await supabaseRequest(table, {
    method: "POST",
    params: "?on_conflict=" + conflict,
    body: row,
    prefer: "resolution=merge-duplicates,return=minimal"
  });
}

async function deleteRow(table, id) {
  await supabaseRequest(table, {
    method: "DELETE",
    params: `?id=eq.${encodeURIComponent(id)}`,
    prefer: "return=minimal"
  });
}

async function deleteJobsForProduct(productId) {
  await supabaseRequest("jobs", {
    method: "DELETE",
    params: `?product_id=eq.${encodeURIComponent(productId)}`,
    prefer: "return=minimal"
  });
}

function scheduleAutoSave(key, saveFn) {
  if (!isConnected() || !syncReady) return;
  window.clearTimeout(autoSaveTimers.get(key));
  setSyncStatus("Saving soon...");
  autoSaveTimers.set(key, window.setTimeout(async () => {
    try {
      await saveFn();
      setSyncStatus("Auto-sync on");
    } catch (error) {
      setSyncStatus("Auto-save failed");
      showToast(error.message);
    }
  }, 120));
}

function visibleMaterials() {
  return materials;
}

function getWorkItems(stage) {
  const items = [];

  orders.forEach(order => {
    if (order.stage !== stage) return;
    items.push({
      type: "order",
      id: order.id,
      productId: order.productId,
      productName: order.productName,
      orderNumber: order.orderNumber,
      materialNames: order.materialName || "No materials listed",
      stage: order.stage
    });
  });

  jobs.forEach(job => {
    if (job.orderId || job.stage !== stage) return;
    const product = products.find(p => p.id === job.productId);
    const materialNames = product?.selectedMaterials
      ?.map(sm => {
        const m = materials.find(mat => mat.id === sm.materialId);
        return m ? m.woodName : "";
      })
      .filter(n => n)
      .join(", ") || "No materials listed";
    items.push({
      type: "job",
      id: job.id,
      productId: job.productId,
      productName: product?.name || "Untitled product",
      materialNames,
      stage: job.stage
    });
  });

  jobBuilds.forEach(build => {
    const buildStage = jobStages.includes(build.stage) ? build.stage : "New Order";
    if (buildStage !== stage) return;
    const buildOrders = getOrdersForBuild(build.buildNumber);
    if (buildOrders.length === 0) return;
    const materialIds = new Set();
    let totalQty = 0;
    buildOrders.forEach(order => {
      totalQty += Number(order.qty || 1);
      const product = products.find(p => p.id === order.productId);
      product?.selectedMaterials?.forEach(sm => materialIds.add(sm.materialId));
    });
    items.push({
      type: "build",
      id: build.id,
      productId: buildOrders[0].productId,
      productName: build.buildNumber,
      materialNames: `${materialIds.size} materials, ${totalQty} total`,
      stage: buildStage
    });
  });

  return items;
}

function renderOrderFlow() {
  el("#order-flow").innerHTML = jobStages.map((stage) => {
    const stageItems = getWorkItems(stage);
    return `
      <div class="flow-column">
        <h3>${stage}<span>${stageItems.length}</span></h3>
        ${stageItems.slice(0, 4).map((item) => `
          <article class="mini-order">
            <strong>${escapeHtml(item.productName)}</strong>
            <span>${escapeHtml(item.materialNames)}</span>
            <small>${escapeHtml(stage)}</small>
          </article>
        `).join("") || "<p>No jobs</p>"}
      </div>
    `;
  }).join("");
}

function renderAlerts() {
  const rows = materials.filter((material) => {
    const qty = Number(material.qty);
    const threshold = Number(material.lowStockThreshold);
    return material.woodName && threshold > 0 && qty <= threshold;
  });
  el("#stock-alerts").innerHTML = rows.map((material) => `
    <article class="alert-item">
      <div>
        <strong>${escapeHtml(material.woodName || "Unnamed wood")}</strong>
        <div class="product-meta">${escapeHtml(material.thickness || "No thickness")} · ${escapeHtml(material.type || "No type")} · threshold ${escapeHtml(material.lowStockThreshold)}</div>
      </div>
      <strong>${escapeHtml(material.qty || "0")}</strong>
    </article>
  `).join("") || "<p>No low-stock materials.</p>";
}

function renderProducts() {
  el("#product-list-container").innerHTML = visibleProducts().map((product) => `
    <div class="product-card" data-product-row="${product.id}">
      <div class="product-header">
        <input data-product-field="name" class="product-name-input" value="${escapeHtml(product.name)}" placeholder="Product name">
        <label>
          Qty Made
          <input data-product-field="qtyMade" class="product-qty-input" value="${escapeHtml(product.qtyMade)}" inputmode="decimal" placeholder="0">
        </label>
      </div>
      <div class="materials-needed-cell" data-product-materials="${product.id}">
        <h4>Materials Needed</h4>
        ${product.selectedMaterials.length > 0 ? `
          <div class="chips-list">
            ${product.selectedMaterials.map((sm) => {
              const material = materials.find(m => m.id === sm.materialId);
              return material ? `<span class="chip">${escapeHtml(material.woodName)}</span>` : '';
            }).join("")}
          </div>
        ` : `<p class="empty-state">Click to add materials</p>`}
      </div>
      <div class="stage-tasks" data-product-id="${product.id}" style="margin-top:8px;">
        ${(() => { const specs = Array.isArray(product.buildSpecs) ? product.buildSpecs : []; return jobStages.map(stage => {
          const tasks = specs.filter(t => t && t.stage === stage);
          const done = tasks.length > 0 && tasks.every(t => t.done);
          return tasks.length ? `<div class="stage-group">
            <div class="stage-head ${done ? 'stage-done' : ''}">${stage} (${tasks.filter(t => t.done).length}/${tasks.length})</div>
            ${tasks.map((t, i) => `<div class="task-item">
              <span>${escapeHtml(t.task)}</span>
            </div>`).join("")}
          </div>` : '';
        }).join(""); })()}
        <div class="add-task-row">
          <input type="text" class="add-task-input" placeholder="Add task..." data-add-task="${product.id}">
          <select class="add-task-stage" data-add-stage="${product.id}">
            ${jobStages.map(s => `<option value="${s}">${s}</option>`).join("")}
          </select>
          <button class="text-button" data-add-task-btn="${product.id}" type="button">Add</button>
        </div>
      </div>
      <div class="product-materials-editor" style="display: ${openEditorIds.has(product.id) ? 'block' : 'none'};" data-product-editor="${product.id}">
        <h4>Select Materials</h4>
        <div class="materials-checklist">
          ${materials.filter(m => m.woodName.trim()).map((material) => {
            const selected = product.selectedMaterials.find(sm => sm.materialId === material.id);
            return `
              <div class="material-item">
                <label>
                  <input type="checkbox" data-material-checkbox="${material.id}" ${selected ? 'checked' : ''} class="material-checkbox">
                  <span>${escapeHtml(material.woodName)} - ${escapeHtml(material.thickness)} (${escapeHtml(material.type)})</span>
                </label>
                <input type="number" data-material-qty="${material.id}" class="material-qty-input" value="${selected ? escapeHtml(selected.qty) : ''}" placeholder="Qty" ${selected ? '' : 'disabled'}>
              </div>
            `;
          }).join("")}
        </div>
        <button class="text-button" data-close-editor="${product.id}" type="button">Done</button>
      </div>
    </div>
  `).join("");
}

function renderOrderProductSelect() {
  const productOptions = products.filter((product) => product.name.trim());
  el("#order-product-select").innerHTML = productOptions.map((product) => `
    <option value="${product.id}">${escapeHtml(product.name)} (${Number(product.qtyMade) || 0} made)</option>
  `).join("") || '<option value="">No products yet</option>';
}

function renderMaterials() {
  const body = el("#material-sheet-body");
  body.innerHTML = visibleMaterials().map((material) => `
    <tr data-material-row="${material.id}">
      <td><input data-material-field="woodName" value="${escapeHtml(material.woodName)}" placeholder="Walnut"></td>
      <td><input data-material-field="thickness" value="${escapeHtml(material.thickness)}" placeholder="3/4"></td>
      <td>
        <select data-material-field="type">
          ${materialTypes.map((type) => `<option value="${escapeHtml(type)}" ${material.type === type ? "selected" : ""}>${escapeHtml(type || "Choose type")}</option>`).join("")}
        </select>
      </td>
      <td><input data-material-field="qty" value="${escapeHtml(material.qty)}" inputmode="decimal" placeholder="0"></td>
      <td><input data-material-field="lowStockThreshold" value="${escapeHtml(material.lowStockThreshold)}" inputmode="decimal" placeholder="0"></td>
    </tr>
  `).join("");
}

function renderTasks() {
  el("#task-board").innerHTML = jobStages.map((stage) => {
    const stageItems = getWorkItems(stage);
    return `
      <div class="task-column">
        <h3>${stage}<span>${stageItems.length}</span></h3>
        ${stageItems.map((item) => {
          const stageIndex = jobStages.indexOf(item.stage);
          const order = item.type === "order" ? orders.find(o => o.id === item.id) : null;
          const product = products.find(p => p.id === item.productId);
          const specs = item.type === "order" && order
            ? (order.buildSpecs || [])
            : (product && Array.isArray(product.buildSpecs) ? product.buildSpecs : []);
          const stageTasks = specs.filter(t => t && t.task);
          return `
            <article class="task-card">
              <button class="task-title-button" ${item.type === "order" ? `data-order-summary="${item.id}"` : `data-task-summary="${item.productId}"`} type="button">${item.orderNumber ? escapeHtml(item.orderNumber) + " " : ""}${escapeHtml(item.productName)}</button>
              <div class="product-meta">${escapeHtml(item.materialNames)}</div>
              ${stageTasks.length ? `<div class="task-list">${item.type === "order"
                ? stageTasks.map((t, i) =>
                    `<label class="task-item" style="display:flex;align-items:center;gap:6px;font-size:12px;padding:2px 0;cursor:pointer;">
                      <input type="checkbox" data-wb-task-check="${item.id}" data-wb-task-idx="${i}" ${t.done ? 'checked' : ''}>
                      <span class="${t.done ? 'task-done' : ''}">${escapeHtml(t.task)}</span>
                    </label>`).join("")
                : stageTasks.map(t => `<span class="${t.done ? 'task-done' : ''}" style="display:block;font-size:12px;">${escapeHtml(t.task)}</span>`).join("")
              }</div>` : ""}
              <div class="detail-strip">
                <span class="detail-chip">${escapeHtml(stage)}</span>
              </div>
              <footer>
                <span class="product-meta">${escapeHtml(stage)}</span>
                <span class="task-actions">
                  <button data-item-move="${item.id}" data-item-type="${item.type}" data-direction="-1" type="button" title="Move back" ${stageIndex === 0 ? "disabled" : ""}>‹</button>
                  <button data-item-move="${item.id}" data-item-type="${item.type}" data-direction="1" type="button" title="Move forward" ${stageIndex === jobStages.length - 1 ? "disabled" : ""}>›</button>
                </span>
              </footer>
            </article>
          `;
        }).join("") || "<p>No jobs here.</p>"}
      </div>
    `;
  }).join("");
}

function renderOrders() {
  const sorted = sortOrdersByNumber(orders);

  el("#orders-table").innerHTML = sorted.map((order) => `
    <tr>
      <td class="col-orderNo"><strong>${escapeHtml(order.orderNumber || "-")}</strong></td>
      <td class="col-product">${escapeHtml(order.productName)}</td>
      <td class="col-qty">${escapeHtml(order.qty || "1")}</td>
      <td class="col-stain">${escapeHtml(order.stainType || "-")}</td>
      <td class="col-orderDate">${escapeHtml(order.orderDate || "-")}</td>
      <td class="col-shipDate">${escapeHtml(order.shipDate || "-")}</td>
      <td class="col-cover">${escapeHtml(order.cover || "-")}</td>
      <td class="col-plaque">${escapeHtml(order.plaque || "-")}</td>
      <td class="col-po">${escapeHtml(order.po || "-")}</td>
      <td class="col-retailer">${escapeHtml(order.retailer || "-")}</td>
      <td class="col-shipTo">${escapeHtml(order.shipTo || "-")}</td>
      <td class="col-customizations">${escapeHtml(order.customizations || "-")}</td>
    </tr>
  `).join("") || '<tr><td colspan="12" class="empty-table">No orders yet.</td></tr>';

  el("#order-count").textContent = `${orders.length} order${orders.length !== 1 ? "s" : ""}`;
}

function sortOrdersByNumber(orderList) {
  return [...orderList].sort((a, b) => {
    const aNum = Number(a.orderNumber);
    const bNum = Number(b.orderNumber);
    if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) return aNum - bNum;
    return String(a.orderNumber || "").localeCompare(String(b.orderNumber || ""));
  });
}

function getOrdersForBuild(buildNumber) {
  return sortOrdersByNumber(orders.filter((order) => order.jobBuildNumber === buildNumber));
}

function findOrCreateJobBuild(buildNumber, productCount) {
  const cleanNumber = buildNumber.trim();
  if (!cleanNumber) return null;

  let build = jobBuilds.find((item) => item.buildNumber === cleanNumber);
  if (!build) {
    build = {
      id: uniqueId(),
      buildNumber: cleanNumber,
      productCount: productCount || "",
      stage: "New Order"
    };
    jobBuilds.unshift(build);
  } else if (productCount) {
    build.productCount = productCount;
  }

  return build;
}

function getMaterialCountForBuild(buildNumber) {
  const buildOrders = getOrdersForBuild(buildNumber);
  const materialIds = new Set();
  buildOrders.forEach(order => {
    const product = products.find(p => p.id === order.productId);
    product?.selectedMaterials?.forEach(sm => materialIds.add(sm.materialId));
  });
  return materialIds.size;
}

function renderJobBuilds() {
  el("#job-build-list").innerHTML = jobBuilds.map((build) => {
    const buildOrders = getOrdersForBuild(build.buildNumber);
    const materialCount = getMaterialCountForBuild(build.buildNumber);
    const totalQty = buildOrders.reduce((sum, o) => sum + Number(o.qty || 1), 0);
    return `
      <article class="job-build-card">
        <button class="job-build-title" data-job-build-summary="${build.id}" type="button">Job Build ${escapeHtml(build.buildNumber)}</button>
        <div class="detail-strip">
          <span class="detail-chip">${buildOrders.length} orders</span>
          <span class="detail-chip">${materialCount} materials</span>
          <span class="detail-chip">${totalQty} total qty</span>
        </div>
        <p>${buildOrders.map((order) => `<span class="chip">${escapeHtml(order.orderNumber || "No order #")}</span>`).join(" ") || "No orders assigned"}</p>
      </article>
    `;
  }).join("") || "<p>No job builds yet.</p>";
}

function renderAll() {
  renderOrderFlow();
  renderAlerts();
  const readyCount = getWorkItems("Ready To Ship").length;
  el("#today-sales").textContent = readyCount;
  renderProducts();
  renderMaterials();
  renderTasks();
  renderOrderProductSelect();
  renderOrders();
  renderJobBuilds();
  renderGlobalActivityLog();
}

function showToast(message) {
  const toast = el("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 2200);
}

function showProductDetailPanel(productId) {
  const product = products.find(p => p.id === productId);
  if (!product) return;

  el("#detail-product-name").textContent = product.name || "Untitled Product";
  el("#detail-name").textContent = product.name || "-";
  el("#detail-qty").textContent = product.qtyMade || "0";

  const materialChips = product.selectedMaterials.map(sm => {
    const material = materials.find(m => m.id === sm.materialId);
    return material ? `<span class="chip">${escapeHtml(material.woodName)}</span>` : '';
  }).join("");
  el("#detail-materials-chips").innerHTML = materialChips || "<p class=\"empty-state\">No materials selected</p>";

  el("#detail-specs").innerHTML = Array.isArray(product.buildSpecs) && product.buildSpecs.length
    ? product.buildSpecs.map(t => `<span style="display:block;font-size:12px;${t.done ? 'text-decoration:line-through;color:var(--muted)' : ''}">${escapeHtml(t.task)} <span style="color:var(--text-muted);font-size:11px">(${t.stage})</span></span>`).join("")
    : "No specs set";

  el("#detail-orders-section").style.display = "";
  el("#detail-activity-section").style.display = "none";
  el("#detail-orders-list").innerHTML = "";

  el("#product-detail-panel").classList.add("open");
  el("#side-panel-backdrop").classList.add("open");
}

function showOrderDetailPanel(orderId) {
  const order = orders.find(o => o.id === orderId);
  if (!order) return;

  el("#detail-product-name").textContent = `Order #${escapeHtml(order.orderNumber || "—")}`;
  el("#detail-name").textContent = `${escapeHtml(order.productName)}`;
  el("#detail-qty").textContent = order.qty || "1";
  el("#detail-materials-chips").innerHTML = `
    <span class="chip">${escapeHtml(order.stainType || "No stain")}</span>
    <span class="chip">${escapeHtml(order.stage)}</span>
  `;
  el("#detail-specs").innerHTML = Array.isArray(order.buildSpecs) && order.buildSpecs.length
    ? order.buildSpecs.map((t, i) =>
        `<label class="task-item" style="display:flex;align-items:center;gap:6px;font-size:13px;padding:2px 0;cursor:pointer;">
          <input type="checkbox" data-order-task-check="${order.id}" data-order-task-idx="${i}" ${t.done ? 'checked' : ''}>
          <span class="${t.done ? 'task-done' : ''}">${escapeHtml(t.task)}</span>
          <span style="color:var(--text-muted);font-size:11px">(${t.stage})</span>
        </label>`).join("")
    : (order.customizations || "No specs set");

  el("#detail-orders-section").style.display = "none";
  el("#detail-activity-section").style.display = "";
  el("#detail-order-notes").value = getLocalOrderMeta(order.orderNumber)?.notes || "";
  el("#detail-file-input").value = "";
  window._detailOrderNumber = order.orderNumber;
  loadOrderFiles(order.orderNumber);
  renderActivityLog(order.orderNumber);

  el("#product-detail-panel").classList.add("open");
  el("#side-panel-backdrop").classList.add("open");
}

async function loadOrderFiles(orderNumber) {
  try {
    const resp = await fetch(`/api/files?orderNumber=${encodeURIComponent(orderNumber)}`);
    const files = await resp.json();
    const list = el("#detail-files-list");
    list.innerHTML = files.length
      ? files.map(f => {
          const isImage = /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(f);
          const url = `/uploads/${encodeURIComponent(orderNumber)}/${encodeURIComponent(f)}`;
          return `<div class="file-item" data-file-name="${escapeHtml(f)}" data-file-url="${url}" data-file-isimage="${isImage}">
            <span class="file-label-link">${escapeHtml(f)}</span>
          </div>`;
        }).join("")
      : '<p class="empty-state" style="font-size:13px;">No files uploaded.</p>';
  } catch (e) { console.error("loadOrderFiles error:", e); }
}

// ── Activity log ──────────────────────────────────────────
function getOrderActivity(orderNumber) {
  const meta = getLocalOrderMeta(orderNumber);
  return meta?.activity || [];
}

function addActivityEntry(orderNumber, type, detail, dataUrl) {
  const meta = getLocalOrderMeta(orderNumber) || {};
  const activity = meta.activity || [];
  const entry = {
    user: currentUser?.username || "unknown",
    type,
    detail,
    timestamp: Date.now()
  };
  if (dataUrl) entry.dataUrl = dataUrl;
  activity.unshift(entry);
  if (activity.length > 50) activity.length = 50;
  setLocalOrderMeta(orderNumber, { ...meta, activity });
  if (window._detailOrderNumber === orderNumber) {
    renderActivityLog(orderNumber);
  }
}

function renderActivityLog(orderNumber) {
  const container = el("#order-activity-log");
  if (!container) return;
  const activity = getOrderActivity(orderNumber);
  if (!activity.length) {
    container.innerHTML = '<p style="font-size:12px;color:var(--muted);text-align:center;padding:8px 0;">No activity yet</p>';
    return;
  }
  container.innerHTML = activity.map(entry => {
    const time = new Date(entry.timestamp);
    const timeStr = time.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const icon = entry.type === "note" ? "\u{1F4DD}" : "\u{1F4F7}";
    let body = "";
    if (entry.type === "note") {
      body = `<div style="margin-top:2px;color:var(--ink);white-space:pre-wrap;word-break:break-word;">${escapeHtml(entry.detail)}</div>`;
    } else if (entry.type === "upload") {
      const url = entry.dataUrl || `/uploads/${encodeURIComponent(orderNumber)}/${encodeURIComponent(entry.detail)}`;
      const isImage = /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(entry.detail);
      body = `<div style="margin-top:2px;"><span style="color:var(--teal);cursor:pointer;text-decoration:underline;" class="file-preview-trigger" data-url="${url}" data-isimage="${isImage}">${escapeHtml(entry.detail)}</span></div>`;
    }
    return `<div style="display:flex;gap:8px;padding:4px 0;font-size:12px;align-items:flex-start;">
      <span style="flex-shrink:0;">${icon}</span>
      <div style="flex:1;min-width:0;">
        <strong style="color:var(--ink);display:block;margin-bottom:4px;">${escapeHtml(entry.user)}</strong>
        ${body}
      </div>
      <span style="flex-shrink:0;color:var(--muted);font-size:11px;white-space:nowrap;">${timeStr}</span>
    </div>`;
  }).join("");
}

// ── Global activity log ──────────────────────
let activityLog = [];

function loadActivityLog() {
  try {
    const raw = localStorage.getItem("app_activity_log");
    if (raw) activityLog = JSON.parse(raw);
  } catch { activityLog = []; }
}

function saveActivityLog() {
  try {
    if (activityLog.length > 500) activityLog = activityLog.slice(0, 500);
    localStorage.setItem("app_activity_log", JSON.stringify(activityLog));
  } catch {}
}

function logGlobalActivity(action, detail, meta = {}) {
  const entry = {
    timestamp: Date.now(),
    user: currentUser?.username || "unknown",
    action,
    detail,
    ...meta
  };
  activityLog.unshift(entry);
  saveActivityLog();
  renderGlobalActivityLog();
}

function renderGlobalActivityLog() {
  const container = el("#global-activity-log");
  if (!container) return;
  const showAll = el("#activity-view")?.classList.contains("active");
  const recent = showAll ? activityLog : activityLog.slice(0, 20);
  if (!recent.length) {
    container.innerHTML = '<p style="font-size:12px;color:var(--muted);text-align:center;padding:8px 0;">No activity yet</p>';
    return;
  }
  container.innerHTML = recent.map(entry => {
    const time = new Date(entry.timestamp);
    const timeStr = time.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const iconMap = { edit: "\u270F\uFE0F", add: "\u2795", delete: "\u274C", move: "\u27A1\uFE0F", create: "\u2795", login: "\uD83D\uDD11", logout: "\uD83D\uDEAA", upload: "\uD83D\uDCE4", save: "\uD83D\uDCBE" };
    const icon = iconMap[entry.action] || "\uD83D\uDD35";
    return `<div style="display:flex;gap:8px;padding:4px 0;font-size:12px;align-items:flex-start;">
      <span style="flex-shrink:0;">${icon}</span>
      <div style="flex:1;min-width:0;">
        <strong style="color:var(--ink);display:block;margin-bottom:2px;">${escapeHtml(entry.user)}</strong>
        <span style="color:var(--text-muted);word-break:break-word;">${escapeHtml(entry.detail)}</span>
      </div>
      <span style="flex-shrink:0;color:var(--muted);font-size:11px;white-space:nowrap;">${timeStr}</span>
    </div>`;
  }).join("");
}

// ── File preview ──────────────────────────
document.addEventListener("click", (event) => {
  const fileItem = event.target.closest(".file-item");
  const trigger = event.target.closest(".file-preview-trigger");
  if (fileItem) {
    const url = fileItem.dataset.fileUrl;
    const isImage = fileItem.dataset.fileIsimage === "true";
    if (url && isImage) {
      openFilePreview(url);
    }
    return;
  }
  if (trigger) {
    const url = trigger.dataset.url;
    const isImage = trigger.dataset.isimage === "true";
    if (url && isImage) {
      openFilePreview(url);
    }
    return;
  }
  if (event.target.closest("#file-preview-overlay") && !event.target.closest("#file-preview-content")) {
    closeFilePreview();
  }
});

function openFilePreview(url) {
  const overlay = el("#file-preview-overlay");
  const content = el("#file-preview-content");
  if (!overlay || !content) return;
  content.innerHTML = `<img src="${url}" style="max-width:90vw;max-height:85vh;border-radius:8px;object-fit:contain;box-shadow:0 8px 40px rgba(0,0,0,0.3);">`;
  overlay.classList.add("open");
}

function closeFilePreview() {
  const overlay = el("#file-preview-overlay");
  if (overlay) overlay.classList.remove("open");
}

// ── File upload ──────────────────────────
(function() {
  const input = el("#detail-file-input");
  if (!input) { console.error("Upload input not found"); return; }
  input.addEventListener("change", async (event) => {
    try {
      const file = event.target.files[0];
      if (!file) { showToast("No file selected"); return; }
      const orderNumber = window._detailOrderNumber;
      if (!orderNumber) { showToast("No order selected"); return; }
      showToast("Uploading " + file.name + "...");
      const reader = new FileReader();
      const dataUrl = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsDataURL(file);
      });
      const base64 = dataUrl.split(",")[1];
      const resp = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderNumber, fileName: file.name, data: base64 })
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        showToast("Upload failed: " + (errText || resp.status));
        return;
      }
      event.target.value = "";
      addActivityEntry(orderNumber, "upload", file.name, dataUrl);
      logGlobalActivity("upload", `Uploaded file "${file.name}" for order #${orderNumber}`);
      await loadOrderFiles(orderNumber);
      showToast("File uploaded");
    } catch (err) {
      showToast("Error: " + (err.message || "unknown"));
    }
  });
})();

let _contextFile = null;

el("#detail-files-list").addEventListener("contextmenu", (event) => {
  const filePreview = event.target.closest("[data-file-name]");
  if (!filePreview) return;
  event.preventDefault();
  _contextFile = filePreview.dataset.fileName;
  const menu = el("#context-menu");
  menu.style.display = "block";
  menu.style.left = event.clientX + "px";
  menu.style.top = event.clientY + "px";
});

document.addEventListener("click", () => {
  el("#context-menu").style.display = "none";
  _contextFile = null;
});

el("#context-delete-file").addEventListener("click", async () => {
  const fileName = _contextFile;
  const orderNumber = window._detailOrderNumber;
  el("#context-menu").style.display = "none";
  _contextFile = null;
  if (!orderNumber || !fileName) return;
  try {
    await fetch("/api/files", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderNumber, fileName })
    });
    loadOrderFiles(orderNumber);
    showToast("File deleted");
  } catch { showToast("Delete failed"); }
});

function showJobBuildDetailPanel(buildId) {
  const build = jobBuilds.find((item) => item.id === buildId);
  if (!build) return;

  const buildOrders = getOrdersForBuild(build.buildNumber);
  el("#detail-product-name").textContent = `Job Build ${build.buildNumber}`;
  el("#detail-name").textContent = `Job Build ${build.buildNumber}`;
  el("#detail-qty").textContent = build.productCount || "0";
  el("#detail-orders-section").style.display = "";
  el("#detail-activity-section").style.display = "none";
  el("#detail-materials-chips").innerHTML = `<span class="chip">${buildOrders.length} orders</span><span class="chip">${escapeHtml(build.stage || "New Task")}</span>`;
  el("#detail-orders-list").innerHTML = buildOrders.length > 0 ? buildOrders.map((order) => `
    <div class="order-detail-item" data-build-order="${order.id}" style="cursor:pointer;">
      <div class="order-detail-header">
        <strong>${escapeHtml(order.orderNumber || "No order #")}</strong>
        <span class="status-pill status-quote">${escapeHtml(order.status)}</span>
      </div>
      <div class="order-detail-info">
        <p><strong>Product:</strong> ${escapeHtml(order.productName || "-")}</p>
        <p><strong>Qty:</strong> ${escapeHtml(order.qty || "1")}</p>
        <p><strong>Stain:</strong> ${escapeHtml(order.stainType || "-")}</p>
      </div>
    </div>
  `).join("") : "<p class=\"empty-state\">No orders in this job build</p>";

  el("#product-detail-panel").classList.add("open");
  el("#side-panel-backdrop").classList.add("open");
}

function closeProductDetailPanel() {
  el("#product-detail-panel").classList.remove("open");
  el("#side-panel-backdrop").classList.remove("open");
}

function closeNewBuildPanel() {
  el("#new-build-panel").classList.remove("open");
  el("#new-build-backdrop").classList.remove("open");
}

function showNewBuildPanel() {
  const available = orders.filter(o => !o.jobBuildNumber);
  el("#new-build-order-list").innerHTML = available.length > 0 ? available.map(order => `
    <label class="build-order-row">
      <input type="checkbox" data-build-order-check="${order.id}">
      <span class="build-order-num">${escapeHtml(order.orderNumber || "—")}</span>
      <span class="build-order-name">${escapeHtml(order.productName)}</span>
      <span class="build-order-qty">x${escapeHtml(order.qty || "1")}</span>
    </label>
  `).join("") : "<p class=\"empty-state\">All orders are already in a build.</p>";
  el("#new-build-panel").classList.add("open");
  el("#new-build-backdrop").classList.add("open");
}

function switchView(view) {
  els(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  els(".view").forEach((panel) => panel.classList.toggle("active", panel.id === `${view}-view`));
  el("#page-title").textContent = titleMap[view];
}

document.addEventListener("click", (event) => {
  const nav = event.target.closest("[data-view]");
  const shortcut = event.target.closest("[data-view-shortcut]");
  const itemMove = event.target.closest("[data-item-move]");
  const closePanel = event.target.closest("#close-detail-panel");
  const backdrop = event.target.closest("#side-panel-backdrop");
  const orderSummary = event.target.closest("[data-order-summary]");
  const taskSummary = event.target.closest("[data-task-summary]");
  const jobBuildSummary = event.target.closest("[data-job-build-summary]");

  const buildOrder = event.target.closest("[data-build-order]");
  const closeNewBuild = event.target.closest("#close-new-build");
  const newBuildBackdrop = event.target.closest("#new-build-backdrop");

  if (closeNewBuild || newBuildBackdrop) {
    closeNewBuildPanel();
    return;
  }

  if (buildOrder) {
    const orderId = Number(buildOrder.dataset.buildOrder);
    const order = orders.find(o => o.id === orderId);
    if (order) showProductDetailPanel(order.productId);
    return;
  }

  if (closePanel || backdrop) {
    closeProductDetailPanel();
    closeNewBuildPanel();
    return;
  }

  if (orderSummary) {
    const orderId = Number(orderSummary.dataset.orderSummary);
    showOrderDetailPanel(orderId);
    return;
  }

  if (taskSummary) {
    const productId = Number(taskSummary.dataset.taskSummary);
    showProductDetailPanel(productId);
    return;
  }

  if (jobBuildSummary) {
    showJobBuildDetailPanel(Number(jobBuildSummary.dataset.jobBuildSummary));
    return;
  }

  if (nav) switchView(nav.dataset.view);
  if (shortcut) switchView(shortcut.dataset.viewShortcut);

  if (itemMove) {
    const direction = Number(itemMove.dataset.direction);
    const id = Number(itemMove.dataset.itemMove);
    const type = itemMove.dataset.itemType;
    if (type === "order") {
      const order = orders.find(o => o.id === id);
      if (!order) return;
      const prevStage = order.stage;
      const nextIndex = jobStages.indexOf(order.stage) + direction;
      if (jobStages[nextIndex]) {
        order.stage = jobStages[nextIndex];
        setLocalOrderMeta(order.orderNumber, { stage: order.stage });
        renderAll();
        scheduleAutoSave(`order:${order.id}`, () => upsertRow("orders", orderToDb(order)));
        logGlobalActivity("move", `Moved order #${order.orderNumber} from "${prevStage}" to "${order.stage}"`);
      }
    } else if (type === "build") {
      const build = jobBuilds.find(b => b.id === id);
      if (!build || !jobStages.includes(build.stage)) return;
      const currentIndex = jobStages.indexOf(build.stage);
      const nextIndex = currentIndex + direction;
      if (jobStages[nextIndex]) {
        const prevStage = build.stage;
        const targetStage = jobStages[nextIndex];
        build.stage = targetStage;
        const buildOrders = getOrdersForBuild(build.buildNumber);
        buildOrders.forEach(order => { order.stage = targetStage; setLocalOrderMeta(order.orderNumber, { stage: order.stage }); });
        renderAll();
        scheduleAutoSave(`build:${build.id}`, async () => {
          await upsertRow("job_builds", jobBuildToDb(build));
          for (const order of buildOrders) {
            await upsertRow("orders", orderToDb(order));
          }
        });
        logGlobalActivity("move", `Moved build "${build.buildNumber}" from "${prevStage}" to "${targetStage}"`);
      }
    } else {
      const job = jobs.find(j => j.id === id);
      if (!job) return;
      const prevStage = job.stage;
      const nextIndex = jobStages.indexOf(job.stage) + direction;
      if (jobStages[nextIndex]) {
        job.stage = jobStages[nextIndex];
        renderAll();
        scheduleAutoSave(`job:${job.id}`, () => upsertRow("jobs", jobToDb(job)));
        logGlobalActivity("move", `Moved job for product to "${job.stage}"`);
      }
    }
  }
});


el("#create-build-btn").addEventListener("click", () => {
  switchView("jobbuilds");
  showNewBuildPanel();
});

el("#confirm-create-build").addEventListener("click", () => {
  const checked = els("[data-build-order-check]:checked");
  if (!checked.length) return showToast("Select at least one order.");

  const checkedIds = checked.map(c => Number(c.dataset.buildOrderCheck));
  const ordersInBuild = checkedIds.map(id => orders.find(o => o.id === id)).filter(Boolean);

  const productQtyMap = {};
  ordersInBuild.forEach(order => {
    const key = order.productName;
    productQtyMap[key] = (productQtyMap[key] || 0) + Number(order.qty || 1);
  });
  const nameParts = Object.entries(productQtyMap).map(([name, qty]) => `${name} x${qty}`);
  const buildName = nameParts.join(", ");

  let build = jobBuilds.find(b => b.buildNumber === buildName);
  if (!build) {
    build = {
      id: uniqueId(),
      buildNumber: buildName,
      productCount: String(checkedIds.length),
      stage: "New Order"
    };
    jobBuilds.unshift(build);
  }

  checkedIds.forEach(orderId => {
    const order = orders.find(o => o.id === orderId);
    if (order) order.jobBuildNumber = buildName;
  });

  closeNewBuildPanel();
  renderAll();
  scheduleAutoSave(`build:${build.id}`, async () => {
    await upsertRow("job_builds", jobBuildToDb(build));
    for (const orderId of checkedIds) {
      const order = orders.find(o => o.id === orderId);
      if (order) await upsertRow("orders", orderToDb(order));
    }
  });
  logGlobalActivity("create", `Created job build "${buildName}" with ${checkedIds.length} orders`);
  showToast(`Job Build created: ${buildName}`);
});

el("#toggle-order-form-btn").addEventListener("click", () => {
  const panel = el("#order-form-panel");
  panel.style.display = panel.style.display === "none" ? "block" : "none";
});

setSyncStatus(isConnected() ? "Connected" : "Not connected");

el("#add-product-row-btn").addEventListener("click", () => {
  const product = { id: uniqueId(), name: "", qtyMade: "", selectedMaterials: [], buildSpecs: [] };
  products.push(product);
  renderAll();
  logGlobalActivity("add", `Added new product row`);
});

el("#add-material-row-btn").addEventListener("click", () => {
  const material = { id: uniqueId(), woodName: "", thickness: "", type: "", qty: "", lowStockThreshold: "" };
  materials.push(material);
  renderAll();
  logGlobalActivity("add", `Added new material row`);
});

el("#material-sheet-body").addEventListener("input", (event) => {
  const input = event.target.closest("[data-material-field]");
  if (!input) return;
  const row = input.closest("[data-material-row]");
  const material = materials.find((item) => item.id === Number(row.dataset.materialRow));
  const field = input.dataset.materialField;
  const fieldLabels = { woodName: "Name", thickness: "Thickness", type: "Type", qty: "Qty", lowStockThreshold: "Low Stock Threshold" };
  material[field] = input.value;
  renderAlerts();
  scheduleAutoSave(`material:${material.id}`, () => {
    const hasContent = material.woodName || material.thickness || material.type || material.qty || material.lowStockThreshold;
    return hasContent ? upsertRow("materials", materialToDb(material)) : deleteRow("materials", material.id);
  });
  logGlobalActivity("edit", `Edited material ${fieldLabels[field] || field}`, { materialId: material.id });
});

el("#product-list-container").addEventListener("input", (event) => {
  const input = event.target.closest("[data-product-field]");
  if (input) {
    const row = input.closest("[data-product-row]");
    const product = products.find((item) => item.id === Number(row.dataset.productRow));
    const field = input.dataset.productField;
    const fieldLabels = { name: "Name", qtyMade: "Qty Made" };
    product[field] = input.value;

    const hasJob = jobs.some((job) => job.productId === product.id);
    if (product.name.trim() && !hasJob) {
      jobs.unshift({ id: uniqueId(), productId: product.id, stage: "New Order" });
    }

    if (!product.name.trim()) {
      jobs = jobs.filter((job) => job.productId !== product.id);
    }

    renderOrderFlow();
    renderTasks();
    scheduleAutoSave(`product:${product.id}`, async () => {
      const hasContent = product.name || product.qtyMade || (product.selectedMaterials && product.selectedMaterials.length > 0) || (product.buildSpecs && product.buildSpecs.length > 0);
      if (hasContent) {
        await upsertRow("products", productToDb(product));
        const job = jobs.find((item) => item.productId === product.id);
        if (job) await upsertRow("jobs", jobToDb(job));
        return;
      }

      await deleteJobsForProduct(product.id);
      await deleteRow("products", product.id);
    });
    logGlobalActivity("edit", `Edited product ${fieldLabels[field] || field}`, { productId: product.id });
    return;
  }

  const checkbox = event.target.closest("[data-material-checkbox]");
  if (checkbox) {
    const row = checkbox.closest("[data-product-row]");
    const product = products.find((item) => item.id === Number(row.dataset.productRow));
    const materialId = Number(checkbox.dataset.materialCheckbox);
    const qtyInput = row.querySelector(`[data-material-qty="${materialId}"]`);
    const material = materials.find(m => m.id === materialId);

    if (checkbox.checked) {
      if (!product.selectedMaterials.find(sm => sm.materialId === materialId)) {
        product.selectedMaterials.push({ materialId, qty: "" });
      }
      qtyInput.disabled = false;
      logGlobalActivity("edit", `Added material "${material?.woodName || materialId}" to product "${product.name || "Untitled"}"`);
    } else {
      product.selectedMaterials = product.selectedMaterials.filter(sm => sm.materialId !== materialId);
      qtyInput.disabled = true;
      qtyInput.value = "";
      logGlobalActivity("edit", `Removed material "${material?.woodName || materialId}" from product "${product.name || "Untitled"}"`);
    }

    renderProducts();
    scheduleAutoSave(`product:${product.id}`, () => upsertRow("products", productToDb(product)));
    return;
  }

  const qtyInput = event.target.closest("[data-material-qty]");
  if (qtyInput) {
    const row = qtyInput.closest("[data-product-row]");
    const product = products.find((item) => item.id === Number(row.dataset.productRow));
    const materialId = Number(qtyInput.dataset.materialQty);
    const selected = product.selectedMaterials.find(sm => sm.materialId === materialId);

    if (selected) {
      selected.qty = qtyInput.value;
    }

    scheduleAutoSave(`product:${product.id}`, () => upsertRow("products", productToDb(product)));
  }
});

el("#product-list-container").addEventListener("click", (event) => {
  const materialsCell = event.target.closest("[data-product-materials]");
  if (materialsCell) {
    const productId = Number(materialsCell.dataset.productMaterials);
    const card = materialsCell.closest("[data-product-row]");
    const editor = card.querySelector(`[data-product-editor="${productId}"]`);
    const cellDisplay = card.querySelector(`[data-product-materials="${productId}"]`);
    
    openEditorIds.add(productId);
    editor.style.display = "block";
    cellDisplay.style.display = "none";
    return;
  }

  const closeBtn = event.target.closest("[data-close-editor]");
  if (closeBtn) {
    const productId = Number(closeBtn.dataset.closeEditor);
    const card = event.target.closest("[data-product-row]");
    const editor = card.querySelector(`[data-product-editor="${productId}"]`);
    const cellDisplay = card.querySelector(`[data-product-materials="${productId}"]`);
    
    openEditorIds.delete(productId);
    editor.style.display = "none";
    cellDisplay.style.display = "block";
    renderProducts();
    return;
  }

  const addBtn = event.target.closest("[data-add-task-btn]");
  if (addBtn) {
    const productId = Number(addBtn.dataset.addTaskBtn);
    const card = addBtn.closest("[data-product-row]");
    const product = products.find(p => p.id === productId);
    const input = card.querySelector(`[data-add-task="${productId}"]`);
    const stage = card.querySelector(`[data-add-stage="${productId}"]`).value;
    const task = input.value.trim();
    if (task && product) {
      if (!Array.isArray(product.buildSpecs)) product.buildSpecs = [];
      product.buildSpecs.push({ task, stage, done: false });
      input.value = "";
      renderProducts();
      scheduleAutoSave(`product:${product.id}`, () => upsertRow("products", productToDb(product)));
      logGlobalActivity("add", `Added task "${task}" to product "${product.name || "Untitled"}" in stage "${stage}"`);
    }
    return;
  }
});

el("#product-list-container").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const input = event.target.closest("[data-add-task]");
  if (!input) return;
  const productId = Number(input.dataset.addTask);
  const card = input.closest("[data-product-row]");
  const product = products.find(p => p.id === productId);
  const stage = card.querySelector(`[data-add-stage="${productId}"]`).value;
  const task = input.value.trim();
  if (task && product) {
    if (!Array.isArray(product.buildSpecs)) product.buildSpecs = [];
    product.buildSpecs.push({ task, stage, done: false });
    input.value = "";
    renderProducts();
    scheduleAutoSave(`product:${product.id}`, () => upsertRow("products", productToDb(product)));
    logGlobalActivity("add", `Added task "${task}" to product "${product.name || "Untitled"}" in stage "${stage}"`);
  }
});

el("#create-order-btn").addEventListener("click", () => {
  const orderNumber = el("#order-number").value.trim();
  const productId = Number(el("#order-product-select").value);
  const qty = el("#order-qty").value.trim();
  const stainType = el("#order-stain-type").value.trim();
  const orderDate = el("#order-date").value;
  const shipDate = el("#order-ship-date").value;
  const cover = el("#order-cover").value.trim();
  const plaque = el("#order-plaque").value.trim();
  const po = el("#order-po").value.trim();
  const retailer = el("#order-retailer").value.trim();
  const shipTo = el("#order-ship-to").value.trim();
  const customizations = el("#order-customizations").value.trim();

  const product = products.find((item) => item.id === productId);
  if (!product) return showToast("Select a product.");

  const order = {
    id: uniqueId(),
    orderNumber,
    orderDate,
    shipDate,
    qty: qty || "1",
    productName: product.name,
    stainType,
    cover,
    plaque,
    po,
    retailer,
    shipTo,
    customizations,
    status: "New",
    stage: "New Order",
    buildSpecs: (product.buildSpecs || []).map(t => ({ ...t, done: false }))
  };

  orders.unshift(order);

  el("#order-number").value = "";
  el("#order-product-select").value = "";
  el("#order-qty").value = "1";
  el("#order-stain-type").value = "";
  el("#order-date").value = "";
  el("#order-ship-date").value = "";
  el("#order-cover").value = "";
  el("#order-plaque").value = "";
  el("#order-po").value = "";
  el("#order-retailer").value = "";
  el("#order-ship-to").value = "";
  el("#order-customizations").value = "";
  renderAll();
  scheduleAutoSave(`order:${order.id}`, async () => {
    await upsertRow("orders", orderToDb(order));
  });
  logGlobalActivity("create", `Created order #${orderNumber} for "${product.name}" (qty: ${qty || "1"})`);
  showToast("Order created.");
});



el("#orders-table").addEventListener("click", (event) => {
  const deleteBtn = event.target.closest("[data-delete-order]");
  if (!deleteBtn) return;
  const orderId = Number(deleteBtn.dataset.deleteOrder);
  const order = orders.find((o) => o.id === orderId);
  if (!order) return;
  const orderNum = order.orderNumber;
  orders = orders.filter((o) => o.id !== orderId);
  renderAll();
  scheduleAutoSave(`delete:order:${orderId}`, async () => {
    await supabaseRequest("orders", {
      method: "DELETE",
      params: `?order_number=eq.${encodeURIComponent(orderNum)}`,
      prefer: "return=minimal"
    });
  });
  logGlobalActivity("delete", `Deleted order #${orderNum}`);
  showToast("Order deleted.");
});

function onOrderTaskToggle(orderId, idx, done) {
  const order = orders.find(o => o.id === orderId);
  if (!order) return;
  const taskName = order.buildSpecs?.[idx]?.task || "";
  if (order.buildSpecs && order.buildSpecs[idx]) {
    order.buildSpecs[idx].done = done;
  }

  const currentTasks = (order.buildSpecs || []).filter(t => t && t.stage && t.stage.toLowerCase() === (order.stage || "").toLowerCase());
  if (currentTasks.length > 0 && currentTasks.every(t => t.done)) {
    const nextIdx = jobStages.findIndex(s => s.toLowerCase() === (order.stage || "").toLowerCase()) + 1;
    if (jobStages[nextIdx]) {
      order.stage = jobStages[nextIdx];
      setLocalOrderMeta(order.orderNumber, { stage: order.stage });
    }
  }

  renderAll();
  scheduleAutoSave(`order:${order.id}`, () => upsertRow("orders", orderToDb(order)));
  logGlobalActivity("edit", `${done ? "Completed" : "Uncompleted"} task "${taskName}" on order #${order.orderNumber}`);
}

el("#product-detail-panel").addEventListener("change", (event) => {
  const cb = event.target.closest("[data-order-task-check]");
  if (!cb) return;
  onOrderTaskToggle(Number(cb.dataset.orderTaskCheck), Number(cb.dataset.orderTaskIdx), cb.checked);
});

el("#task-board").addEventListener("change", (event) => {
  const cb = event.target.closest("[data-wb-task-check]");
  if (!cb) return;
  onOrderTaskToggle(Number(cb.dataset.wbTaskCheck), Number(cb.dataset.wbTaskIdx), cb.checked);
});

// Settings panel
el("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = el("#login-btn");
  btn.disabled = true;
  btn.textContent = "Signing in...";
  el("#login-error").textContent = "";
  try {
    await login(el("#login-username").value, el("#login-password").value);
  } catch (err) {
    el("#login-error").textContent = err.message;
  }
  btn.disabled = false;
  btn.textContent = "Sign In";
});

function startLoginScreenConnectionCheck() {
  if (loginScreenCheckTimer) clearTimeout(loginScreenCheckTimer);
  loginScreenCheckTimer = setTimeout(async () => {
    await checkLoginScreenConnection();
    startLoginScreenConnectionCheck();
  }, 10000);
}

function checkAndReconnect() {
  if (!currentUser) return;
  ensureSupabaseConnection().then(reconnected => {
    if (reconnected) {
      loadFromSupabase().catch(() => {
        setSyncStatus("Auto-load failed");
      });
    }
  });
}

el("#logout-btn").addEventListener("click", logout);

el("#settings-btn").addEventListener("click", () => {
  el("#settings-panel").classList.add("open");
  el("#settings-backdrop").classList.add("open");
  el("#settings-user-name").textContent = currentUser ? currentUser.username : "";
  // Load current Supabase config into settings fields
  const urlInput = el("#settings-supabase-url");
  const keyInput = el("#settings-supabase-key");
  if (urlInput && keyInput) {
    urlInput.value = supabaseConfig.url || "";
    keyInput.value = supabaseConfig.key || "";
  }
});

el("#save-supabase-config")?.addEventListener("click", async () => {
  const urlInput = el("#settings-supabase-url");
  const keyInput = el("#settings-supabase-key");
  const statusEl = el("#supabase-config-status");
  const url = urlInput.value.trim();
  const key = keyInput.value.trim();
  if (!url || !key) { statusEl.textContent = "Both fields required"; return; }
  try {
    const resp = await fetch("/api/excel-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ supabaseUrl: url, supabaseKey: key })
    });
    if (!resp.ok) throw new Error("Save failed");
    supabaseConfig.url = url.replace(/\/$/, "");
    supabaseConfig.key = key;
    statusEl.textContent = "Saved — reconnecting...";
    setTimeout(() => {
      ensureSupabaseConnection().then(() => {
        statusEl.textContent = "";
        setSyncStatus("Connected");
        loadFromSupabase().catch(() => setSyncStatus("Load failed"));
      });
    }, 300);
    logGlobalActivity("save", "Updated Supabase configuration");
  } catch { statusEl.textContent = "Save failed"; }
});

el("#settings-signout-btn").addEventListener("click", () => {
  closeSettings();
  logout();
});

function closeSettings() {
  el("#settings-panel").classList.remove("open");
  el("#settings-backdrop").classList.remove("open");
}

el("#close-settings").addEventListener("click", closeSettings);
el("#settings-backdrop").addEventListener("click", closeSettings);

el("#save-order-notes").addEventListener("click", () => {
  const panel = el("#product-detail-panel");
  const orderNumber = panel.querySelector("#detail-product-name")?.textContent?.replace("Order #", "");
  if (!orderNumber) return;
  const order = orders.find(o => o.orderNumber === orderNumber);
  if (!order) return;
  const notes = el("#detail-order-notes").value.trim();
  order.notes = notes;
  setLocalOrderMeta(order.orderNumber, { notes });
  addActivityEntry(order.orderNumber, "note", notes);
  logGlobalActivity("save", `Saved notes on order #${orderNumber}`);
  showToast("Notes saved");
});

async function getAllUsers() {
  const rows = await supabaseRequest("users", { params: "?select=username,tabs&order=username.asc" });
  return rows || [];
}

async function upsertUser(username, password, tabs) {
  const existing = await supabaseRequest("users", { params: `?username=eq.${encodeURIComponent(username)}&select=username` });
  if (existing && existing.length) {
    const body = {};
    if (password) body.password = password;
    if (tabs) body.tabs = tabs;
    if (Object.keys(body).length) await supabaseRequest("users", { method: "PATCH", params: `?username=eq.${encodeURIComponent(username)}`, body, prefer: "return=minimal" });
  } else {
    await supabaseRequest("users", { method: "POST", body: { username, password: password || "changeme", tabs: tabs || allTabs }, prefer: "return=minimal" });
  }
}

async function removeUser(username) {
  await supabaseRequest("users", { method: "DELETE", params: `?username=eq.${encodeURIComponent(username)}`, prefer: "return=minimal" });
}

async function renderPermissions() {
  const users = await getAllUsers();
  const tbody = el("#permissions-table-body");
  if (!tbody) return;
  tbody.innerHTML = users.map(u => {
    const passwordPlaceholder = u.username === currentUser?.username ? "" : "";
    return `<tr>
      <td><strong>${escapeHtml(u.username)}</strong></td>
      <td><input type="text" class="user-pw-input" data-username="${escapeHtml(u.username)}" placeholder="${passwordPlaceholder}" value=""></td>
      ${allTabs.map(tab => `<td><input type="checkbox" class="user-tab-cb" data-username="${escapeHtml(u.username)}" data-tab="${tab}" ${(u.tabs || []).includes(tab) ? "checked" : ""}></td>`).join("")}
      <td>${u.username === "admin" || u.username === "user" ? "" : `<button class="text-button" data-delete-user="${escapeHtml(u.username)}" type="button" style="color:var(--coral);">Delete</button>`}</td>
    </tr>`;
  }).join("");
}

el("#permissions-table-body")?.addEventListener("change", async (e) => {
  const cb = e.target.closest(".user-tab-cb");
  if (!cb) return;
  const username = cb.dataset.username;
  const checkboxes = document.querySelectorAll(`.user-tab-cb[data-username="${username}"]`);
  const tabs = [...checkboxes].filter(c => c.checked).map(c => c.dataset.tab);
  try {
    await upsertUser(username, "", tabs);
    if (username === currentUser?.username) {
      currentUser.tabs = tabs;
      saveSession(currentUser);
      applyPermissions();
    }
    logGlobalActivity("edit", `Updated permissions for user "${username}"`);
  } catch { showToast("Failed to update permissions"); }
});

el("#permissions-table-body")?.addEventListener("change", async (e) => {
  const pw = e.target.closest(".user-pw-input");
  if (!pw || !pw.value.trim()) return;
  try {
    await upsertUser(pw.dataset.username, pw.value.trim());
    pw.value = "";
    showToast("Password updated");
  } catch { showToast("Failed to update password"); }
});

el("#permissions-table-body")?.addEventListener("click", async (e) => {
  const delBtn = e.target.closest("[data-delete-user]");
  if (!delBtn) return;
  const username = delBtn.dataset.deleteUser;
  if (!confirm(`Delete user "${username}"?`)) return;
  try {
    await removeUser(username);
    await renderPermissions();
    logGlobalActivity("delete", `Deleted user "${username}"`);
    showToast("User deleted");
  } catch { showToast("Failed to delete user"); }
});

el("#add-user-btn")?.addEventListener("click", () => {
  el("#add-user-form").style.display = el("#add-user-form").style.display === "none" ? "" : "none";
});

el("#cancel-new-user-btn")?.addEventListener("click", () => {
  el("#add-user-form").style.display = "none";
  el("#new-user-username").value = "";
  el("#new-user-password").value = "";
});

el("#save-new-user-btn")?.addEventListener("click", async () => {
  const username = el("#new-user-username").value.trim();
  const password = el("#new-user-password").value.trim();
  if (!username) { showToast("Username required"); return; }
  const tabCbs = el("#new-user-tabs").querySelectorAll("input[type=checkbox]:checked");
  const tabs = [...tabCbs].map(c => c.value);
  try {
    await upsertUser(username, password || "changeme", tabs);
    el("#add-user-form").style.display = "none";
    el("#new-user-username").value = "";
    el("#new-user-password").value = "";
    await renderPermissions();
    logGlobalActivity("create", `Created user "${username}"`);
    showToast("User created");
  } catch { showToast("Failed to create user"); }
});

el("#clear-activity-log-btn")?.addEventListener("click", () => {
  if (!confirm("Clear all activity log entries?")) return;
  activityLog = [];
  saveActivityLog();
  renderGlobalActivityLog();
  showToast("Activity log cleared");
});

// Trigger renders when switching views
const origSwitchView = switchView;
switchView = function(view) {
  origSwitchView(view);
  if (view === "permissions") renderPermissions();
  if (view === "activity") renderGlobalActivityLog();
};

function initColumnResize() {
  const table = document.getElementById("orders-data-table");
  if (!table) return;
  const handles = table.querySelectorAll(".resize-handle");
  let startX, startWidth, th;

  handles.forEach(handle => {
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      th = handle.parentElement;
      startX = e.clientX;
      startWidth = th.offsetWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  });

  function onMouseMove(e) {
    if (!th) return;
    const diff = e.clientX - startX;
    const newWidth = Math.max(40, startWidth + diff);
    th.style.width = newWidth + "px";
    const colClass = th.className.split(" ").find(c => c.startsWith("col-"));
    if (colClass) {
      table.querySelectorAll("td." + colClass).forEach(td => td.style.width = newWidth + "px");
    }
  }

  function onMouseUp() {
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    th = null;
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  }
}

// Escape key closes panels
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (el("#file-preview-overlay")?.classList.contains("open")) { closeFilePreview(); return; }
    if (el("#settings-panel").classList.contains("open")) { closeSettings(); return; }
    if (el("#product-detail-panel").classList.contains("open")) { closeProductDetailPanel(); return; }
  }
});

const DEFAULT_SUPABASE_URL = "https://kfcdgafhzcdddwhknult.supabase.co";
const DEFAULT_SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtmY2RnYWZoemNkZGR3aGtudWx0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk5OTE2OTUsImV4cCI6MjA5NTU2NzY5NX0.KduXGxt-w9Wk6slJG5AIoM2seCZCRtDqvMXTAsCvAZM";

async function loadSupabaseConfig() {
  try {
    const res = await fetch("/api/supabase-config");
    const data = await res.json();
    if (data.url && data.key) {
      supabaseConfig.url = data.url.replace(/\/$/, "");
      supabaseConfig.key = data.key;
      return true;
    }
  } catch {}
  supabaseConfig.url = DEFAULT_SUPABASE_URL;
  supabaseConfig.key = DEFAULT_SUPABASE_KEY;
  return true;
}

async function ensureSupabaseConnection() {
  if (!isConnected()) {
    const success = await loadSupabaseConfig();
    if (success) {
      setSyncStatus("Reconnected");
    }
    return success;
  }
  return true;
}

function startSupabaseReconnection() {
  if (supabaseReconnectTimer) clearTimeout(supabaseReconnectTimer);
  supabaseReconnectTimer = setTimeout(async () => {
    await checkAndReconnect();
    startSupabaseReconnection();
  }, 30000);
}

async function checkLoginScreenConnection() {
  const connected = await ensureSupabaseConnection();
  const syncIndicator = el("#login-sync-indicator");
  if (syncIndicator) {
    syncIndicator.textContent = connected ? "● Online" : "○ Offline";
    syncIndicator.title = connected ? "Connected to Supabase" : "Not connected to Supabase";
  }
  return connected;
}

function initApp() {
  renderAll();
  initColumnResize();

  if (isConnected()) {
    loadFromSupabase().catch((error) => {
      syncReady = false;
      setSyncStatus("Auto-load failed");
      showToast(error.message);
    });
  }
}

async function initializeApp() {
  const connected = await loadSupabaseConfig();
  loadSession();
  loadActivityLog();
  setSyncStatus(isConnected() ? "Connected" : "Not connected");
  if (currentUser) {
    el("#login-overlay").classList.add("hidden");
    applyPermissions();
    isReady = true;
    initApp();
    startSupabaseReconnection();
  } else {
    el("#login-overlay").classList.remove("hidden");
    await checkLoginScreenConnection();
    startLoginScreenConnectionCheck();
  }
}

initializeApp();