let products = [{ id: 1, name: "", qtyMade: "", selectedMaterials: [] }];
let materials = [{ id: 1, woodName: "", thickness: "", type: "", qty: "", lowStockThreshold: "" }];
let jobs = [];
let orders = [];
let jobBuilds = [];
let supabaseConfig = {
  url: localStorage.getItem("stockroom_supabase_url") || "",
  key: localStorage.getItem("stockroom_supabase_key") || ""
};
let autoSaveTimers = new Map();
let syncReady = false;
let _idCounter = 0;
const jobStages = ["New Order", "In Production", "In Hangout", "Ready To Ship"];
const materialTypes = ["", "Hardwood", "Plywood", "MDF"];
const titleMap = {
  dashboard: "Inventory Dashboard",
  products: "Products",
  materials: "Raw Materials",
  workboard: "Product Workboard",
  jobbuilds: "Job Builds",
  orders: "Orders"
};

const el = (selector) => document.querySelector(selector);
const els = (selector) => [...document.querySelectorAll(selector)];
const isConnected = () => supabaseConfig.url && supabaseConfig.key;

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
  const query = el("#global-search").value.trim().toLowerCase();
  if (!query) return products;
  return products.filter((product) => {
    const materialNames = product.selectedMaterials
      .map(sm => {
        const material = materials.find(m => m.id === sm.materialId);
        return material ? material.woodName : "";
      })
      .join(" ");
    return `${product.name} ${product.qtyMade} ${materialNames}`.toLowerCase().includes(query);
  });
}

function setSyncStatus(message) {
  const indicator = el("#sync-indicator");
  if (!indicator) return;
  indicator.textContent = message;
  indicator.className = "sync-indicator";
  if (message === "Auto-sync on" || message === "Connected") indicator.classList.add("synced");
  else if (message === "Saving..." || message === "Saving soon..." || message === "Loading...") indicator.classList.add("saving");
  else if (message?.includes("fail") || message?.includes("error") || message?.includes("Error")) indicator.classList.add("error");
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
    build_specs: product.buildSpecs || ""
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

function orderToDb(order) {
  return {
    id: order.id,
    order_number: order.orderNumber || "",
    product_id: order.productId,
    product_name: order.productName,
    material_id: order.materialId || null,
    material_name: order.materialName || "",
    qty: order.qty || "1",
    job_build_number: order.jobBuildNumber || "",
    stain_type: order.stainType || "",
    customizations: order.customizations || "",
    status: order.status,
    stage: order.stage || "New Order"
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
  try {
    selectedMaterials = JSON.parse(row.materials_needed || "[]");
  } catch (e) {
    selectedMaterials = [];
  }
  return {
    id: Number(row.id),
    name: row.name || "",
    qtyMade: row.qty_made || "",
    selectedMaterials: Array.isArray(selectedMaterials) ? selectedMaterials : [],
    buildSpecs: row.build_specs || ""
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

function dbToOrder(row) {
  return {
    id: Number(row.id),
    orderNumber: row.order_number || "",
    productId: Number(row.product_id),
    productName: row.product_name || "",
    materialId: row.material_id ? Number(row.material_id) : null,
    materialName: row.material_name || "",
    qty: row.qty || "1",
    jobBuildNumber: row.job_build_number || "",
    stainType: row.stain_type || "",
    customizations: row.customizations || "",
    status: row.status || "New",
    stage: row.stage || "New Order"
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
  const [productRows, materialRows] = await Promise.all([
    supabaseRequest("products", { params: "?select=*&order=id.asc" }),
    supabaseRequest("materials", { params: "?select=*&order=id.asc" })
  ]);
  const orderRows = await supabaseRequest("orders", { params: "?select=*&order=id.asc" }).catch(() => []);
  const jobRows = await supabaseRequest("jobs", { params: "?select=*&order=id.asc" }).catch(() => []);
  const jobBuildRows = await supabaseRequest("job_builds", { params: "?select=*&order=id.asc" }).catch(() => []);

  products = productRows.map(dbToProduct);
  materials = materialRows.map(dbToMaterial);
  orders = orderRows.map(dbToOrder);
  jobs = jobRows.map(dbToJob).filter((job) => !job.orderId && products.some((product) => product.id === job.productId));
  jobBuilds = jobBuildRows.map(dbToJobBuild);

  if (!products.length) products = [{ id: uniqueId(), name: "", qtyMade: "", selectedMaterials: [] }];
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
  await supabaseRequest(table, {
    method: "POST",
    params: "?on_conflict=id",
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
  const query = el("#global-search").value.trim().toLowerCase();
  if (!query) return materials;
  return materials.filter((material) => `${material.woodName} ${material.thickness} ${material.type} ${material.qty} ${material.lowStockThreshold}`.toLowerCase().includes(query));
}

function getWorkItems(stage) {
  const query = el("#global-search").value.trim().toLowerCase();
  const items = [];

  orders.forEach(order => {
    if (order.stage !== stage) return;
    const product = products.find(p => p.id === order.productId);
    const searchable = `${order.productName} ${order.materialName || ""}`.toLowerCase();
    if (!searchable.includes(query)) return;
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
    const searchable = `${product?.name || ""} ${materialNames}`.toLowerCase();
    if (!searchable.includes(query)) return;
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
    const searchable = `${build.buildNumber} ${materialIds.size} materials`.toLowerCase();
    if (!searchable.includes(query)) return;
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

function renderStats() {
  const productCount = products.filter(p => p.name.trim()).length;
  const materialCount = materials.filter(m => m.woodName.trim()).length;
  const readyItems = getWorkItems("Ready To Ship");
  const totalItems = jobStages.reduce((sum, s) => sum + getWorkItems(s).length, 0);
  el("#stats-bar").innerHTML = `
    <div class="stat-item"><span class="stat-number">${productCount}</span><span class="stat-label">Products</span></div>
    <div class="stat-item"><span class="stat-number">${materialCount}</span><span class="stat-label">Materials</span></div>
    <div class="stat-item"><span class="stat-number">${totalItems}</span><span class="stat-label">Jobs</span></div>
    <div class="stat-item"><span class="stat-number">${orders.length}</span><span class="stat-label">Orders</span></div>
    <div class="stat-item"><span class="stat-number">${readyItems.length}</span><span class="stat-label">Ready</span></div>
  `;
}

function renderMetrics() {}

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
      <details class="product-specs-details" style="margin-top:8px;">
        <summary style="cursor:pointer;font-size:13px;color:var(--text-muted);">Build Specs</summary>
        <textarea data-product-field="buildSpecs" class="product-specs-input" placeholder="Panel size for gluing up panels, edge profile, joinery details..." style="width:100%;min-height:60px;margin-top:4px;padding:6px;border:1px solid var(--border);border-radius:6px;font-size:13px;">${escapeHtml(product.buildSpecs)}</textarea>
      </details>
      <div class="product-materials-editor" style="display: none;" data-product-editor="${product.id}">
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
          return `
            <article class="task-card">
              <button class="task-title-button" ${item.type === "order" ? `data-order-summary="${item.id}"` : `data-task-summary="${item.productId}"`} type="button">${item.orderNumber ? escapeHtml(item.orderNumber) + " " : ""}${escapeHtml(item.productName)}</button>
              <div class="product-meta">${escapeHtml(item.materialNames)}</div>
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
      <td><strong>${escapeHtml(order.orderNumber || "-")}</strong></td>
      <td>${escapeHtml(order.productName)}</td>
      <td>${escapeHtml(order.qty || "1")}</td>
      <td>${escapeHtml(order.stainType || "-")}</td>
      <td class="order-customizations-cell">${escapeHtml(order.customizations || "-")}</td>
      <td><button class="delete-order-btn" data-delete-order="${order.id}" type="button" title="Delete order">&times;</button></td>
    </tr>
  `).join("") || '<tr><td colspan="6" class="empty-table">No orders yet.</td></tr>';

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
  renderStats();
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

  el("#detail-specs").textContent = product.buildSpecs || "No specs set";

  const relatedOrders = orders.filter(o => o.productId === productId);
  el("#detail-orders-list").innerHTML = relatedOrders.length > 0 ? relatedOrders.map(order => `
    <div class="order-detail-item">
      <div class="order-detail-header">
        <strong>${escapeHtml(order.orderNumber || "Unnamed Order")}</strong>
        <span class="status-pill status-quote">${escapeHtml(order.status)}</span>
      </div>
      <div class="order-detail-info">
        <p><strong>Qty:</strong> ${escapeHtml(order.qty || "1")}</p>
        <p><strong>Stain:</strong> ${escapeHtml(order.stainType || "-")}</p>
        <p><strong>Customizations:</strong> ${escapeHtml(order.customizations || "-")}</p>
      </div>
    </div>
  `).join("") : "<p class=\"empty-state\">No orders for this product</p>";

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
  el("#detail-specs").textContent = order.customizations || "No customizations";
  el("#detail-orders-list").innerHTML = `
    <div class="order-detail-item">
      <div class="order-detail-header">
        <strong>Order ${escapeHtml(order.orderNumber || "—")}</strong>
        <span class="status-pill status-quote">${escapeHtml(order.status)}</span>
      </div>
      <div class="order-detail-info">
        <p><strong>Product:</strong> ${escapeHtml(order.productName)}</p>
        <p><strong>Qty:</strong> ${escapeHtml(order.qty || "1")}</p>
        <p><strong>Stain:</strong> ${escapeHtml(order.stainType || "-")}</p>
        <p><strong>Stage:</strong> ${escapeHtml(order.stage)}</p>
      </div>
    </div>
  `;

  el("#product-detail-panel").classList.add("open");
  el("#side-panel-backdrop").classList.add("open");
}

function showJobBuildDetailPanel(buildId) {
  const build = jobBuilds.find((item) => item.id === buildId);
  if (!build) return;

  const buildOrders = getOrdersForBuild(build.buildNumber);
  el("#detail-product-name").textContent = `Job Build ${build.buildNumber}`;
  el("#detail-name").textContent = `Job Build ${build.buildNumber}`;
  el("#detail-qty").textContent = build.productCount || "0";
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
      const nextIndex = jobStages.indexOf(order.stage) + direction;
      if (jobStages[nextIndex]) {
        order.stage = jobStages[nextIndex];
        renderAll();
        scheduleAutoSave(`order:${order.id}`, () => upsertRow("orders", orderToDb(order)));
      }
    } else if (type === "build") {
      const build = jobBuilds.find(b => b.id === id);
      if (!build || !jobStages.includes(build.stage)) return;
      const currentIndex = jobStages.indexOf(build.stage);
      const nextIndex = currentIndex + direction;
      if (jobStages[nextIndex]) {
        const targetStage = jobStages[nextIndex];
        build.stage = targetStage;
        const buildOrders = getOrdersForBuild(build.buildNumber);
        buildOrders.forEach(order => { order.stage = targetStage; });
        renderAll();
        scheduleAutoSave(`build:${build.id}`, async () => {
          await upsertRow("job_builds", jobBuildToDb(build));
          for (const order of buildOrders) {
            await upsertRow("orders", orderToDb(order));
          }
        });
      }
    } else {
      const job = jobs.find(j => j.id === id);
      if (!job) return;
      const nextIndex = jobStages.indexOf(job.stage) + direction;
      if (jobStages[nextIndex]) {
        job.stage = jobStages[nextIndex];
        renderAll();
        scheduleAutoSave(`job:${job.id}`, () => upsertRow("jobs", jobToDb(job)));
      }
    }
  }
});

el("#global-search").addEventListener("input", renderAll);

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
  showToast(`Job Build created: ${buildName}`);
});

el("#toggle-order-form-btn").addEventListener("click", () => {
  const panel = el("#order-form-panel");
  panel.style.display = panel.style.display === "none" ? "block" : "none";
});

setSyncStatus(isConnected() ? "Connected" : "Not connected");

el("#add-product-row-btn").addEventListener("click", () => {
  const product = { id: uniqueId(), name: "", qtyMade: "", selectedMaterials: [] };
  products.push(product);
  renderAll();
});

el("#add-material-row-btn").addEventListener("click", () => {
  const material = { id: uniqueId(), woodName: "", thickness: "", type: "", qty: "", lowStockThreshold: "" };
  materials.push(material);
  renderAll();
});

el("#material-sheet-body").addEventListener("input", (event) => {
  const input = event.target.closest("[data-material-field]");
  if (!input) return;
  const row = input.closest("[data-material-row]");
  const material = materials.find((item) => item.id === Number(row.dataset.materialRow));
  material[input.dataset.materialField] = input.value;
  renderAlerts();
  scheduleAutoSave(`material:${material.id}`, () => {
    const hasContent = material.woodName || material.thickness || material.type || material.qty || material.lowStockThreshold;
    return hasContent ? upsertRow("materials", materialToDb(material)) : deleteRow("materials", material.id);
  });
});

el("#product-list-container").addEventListener("input", (event) => {
  const input = event.target.closest("[data-product-field]");
  if (input) {
    const row = input.closest("[data-product-row]");
    const product = products.find((item) => item.id === Number(row.dataset.productRow));
    product[input.dataset.productField] = input.value;

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
      const hasContent = product.name || product.qtyMade || (product.selectedMaterials && product.selectedMaterials.length > 0);
      if (hasContent) {
        await upsertRow("products", productToDb(product));
        const job = jobs.find((item) => item.productId === product.id);
        if (job) await upsertRow("jobs", jobToDb(job));
        return;
      }

      await deleteJobsForProduct(product.id);
      await deleteRow("products", product.id);
    });
    return;
  }

  const checkbox = event.target.closest("[data-material-checkbox]");
  if (checkbox) {
    const row = checkbox.closest("[data-product-row]");
    const product = products.find((item) => item.id === Number(row.dataset.productRow));
    const materialId = Number(checkbox.dataset.materialCheckbox);
    const qtyInput = row.querySelector(`[data-material-qty="${materialId}"]`);

    if (checkbox.checked) {
      if (!product.selectedMaterials.find(sm => sm.materialId === materialId)) {
        product.selectedMaterials.push({ materialId, qty: "" });
      }
      qtyInput.disabled = false;
    } else {
      product.selectedMaterials = product.selectedMaterials.filter(sm => sm.materialId !== materialId);
      qtyInput.disabled = true;
      qtyInput.value = "";
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
    
    if (editor.style.display === "none") {
      editor.style.display = "block";
      cellDisplay.style.display = "none";
    }
    return;
  }

  const closeBtn = event.target.closest("[data-close-editor]");
  if (closeBtn) {
    const productId = Number(closeBtn.dataset.closeEditor);
    const card = event.target.closest("[data-product-row]");
    const editor = card.querySelector(`[data-product-editor="${productId}"]`);
    const cellDisplay = card.querySelector(`[data-product-materials="${productId}"]`);
    
    editor.style.display = "none";
    cellDisplay.style.display = "block";
    renderProducts();
    return;
  }

});

el("#create-order-btn").addEventListener("click", () => {
  const orderNumber = el("#order-number").value.trim();
  const productId = Number(el("#order-product-select").value);
  const qty = el("#order-qty").value.trim();
  const stainType = el("#order-stain-type").value.trim();
  const customizations = el("#order-customizations").value.trim();

  const product = products.find((item) => item.id === productId);
  if (!product) return showToast("Select a product.");

  const order = {
    id: uniqueId(),
    orderNumber,
    productId: product.id,
    productName: product.name,
    qty: qty || "1",
    stainType,
    customizations,
    status: "New",
    stage: "New Order"
  };

  orders.unshift(order);

  el("#order-number").value = "";
  el("#order-product-select").value = "";
  el("#order-qty").value = "1";
  el("#order-stain-type").value = "";
  el("#order-customizations").value = "";
  renderAll();
  scheduleAutoSave(`order:${order.id}`, async () => {
    await upsertRow("orders", orderToDb(order));
  });
  showToast("Order created.");
});

el("#orders-table").addEventListener("click", (event) => {
  const deleteBtn = event.target.closest("[data-delete-order]");
  if (!deleteBtn) return;
  const orderId = Number(deleteBtn.dataset.deleteOrder);
  const order = orders.find((o) => o.id === orderId);
  if (!order) return;
  orders = orders.filter((o) => o.id !== orderId);
  renderAll();
  scheduleAutoSave(`delete:order:${orderId}`, async () => {
    await deleteRow("orders", orderId);
  });
  showToast("Order deleted.");
});

// Settings panel
el("#settings-btn").addEventListener("click", () => {
  el("#supabase-url").value = supabaseConfig.url;
  el("#supabase-key").value = supabaseConfig.key;
  el("#settings-panel").classList.add("open");
  el("#settings-backdrop").classList.add("open");
  el("#settings-hint").textContent = supabaseConfig.url ? "Credentials loaded. Click Save to reconnect." : "Enter your Supabase project URL and anon key, then click Save.";
});

function closeSettings() {
  el("#settings-panel").classList.remove("open");
  el("#settings-backdrop").classList.remove("open");
}

el("#close-settings").addEventListener("click", closeSettings);
el("#settings-backdrop").addEventListener("click", closeSettings);

el("#save-supabase-btn").addEventListener("click", () => {
  const url = el("#supabase-url").value.trim();
  const key = el("#supabase-key").value.trim();
  if (!url || !key) return showToast("Enter both URL and anon key.");
  supabaseConfig.url = url.replace(/\/$/, "");
  supabaseConfig.key = key;
  localStorage.setItem("stockroom_supabase_url", supabaseConfig.url);
  localStorage.setItem("stockroom_supabase_key", supabaseConfig.key);
  closeSettings();
  showToast("Credentials saved. Reloading data...");
  syncReady = false;
  loadFromSupabase().catch((error) => {
    syncReady = false;
    setSyncStatus("Connection failed");
    showToast(error.message);
  });
});

el("#clear-supabase-btn").addEventListener("click", () => {
  localStorage.removeItem("stockroom_supabase_url");
  localStorage.removeItem("stockroom_supabase_key");
  supabaseConfig.url = "";
  supabaseConfig.key = "";
  closeSettings();
  showToast("Disconnected from Supabase.");
  syncReady = false;
  setSyncStatus("Offline");
});

// Escape key closes panels
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (el("#settings-panel").classList.contains("open")) { closeSettings(); return; }
    if (el("#product-detail-panel").classList.contains("open")) { closeProductDetailPanel(); return; }
  }
});

function excelDateStr(serial) {
  if (!serial || typeof serial !== "number") return "";
  const d = new Date(Math.floor(serial - 25569) * 86400000);
  return isNaN(d.getTime()) ? "" : d.toISOString().split("T")[0];
}

function processExcelRows(rows, extraExisting) {
  const existingOrderNumbers = new Set(orders.map(o => String(o.orderNumber).trim()).filter(Boolean));
  if (extraExisting) extraExisting.forEach(n => existingOrderNumbers.add(n));
  let count = 0;

  rows.forEach(row => {
    const name = String(row["Product"] || "").trim();
    if (!name) return;

    const orderNum = String(row["Order Number"] || "").trim();

    let product = products.find(p => p.name === name);
    if (!product) {
      product = { id: uniqueId(), name, qtyMade: "", selectedMaterials: [], buildSpecs: "" };
      products.push(product);
      jobs.unshift({ id: uniqueId(), productId: product.id, stage: "New Order" });
    }

    const extras = [];
    if (row["Cover"]) extras.push("Cover: " + row["Cover"]);
    if (row["Plaque"]) extras.push("Plaque: " + row["Plaque"]);
    if (row["P.O"]) extras.push("P.O: " + row["P.O"]);
    if (row["Retailer"]) extras.push("Retailer: " + row["Retailer"]);
    if (row["Ship To"]) extras.push("Ship To: " + row["Ship To"]);
    if (row["Order Date"]) { const d = excelDateStr(row["Order Date"]); if (d) extras.push("Order Date: " + d); }
    if (row["Ship Date"]) { const d = excelDateStr(row["Ship Date"]); if (d) extras.push("Ship Date: " + d); }

    const existingCustom = String(row["Customizations"] || "").trim();
    let customizations = extras.join("\n");
    if (existingCustom) customizations = customizations ? customizations + "\n" + existingCustom : existingCustom;

    if (orderNum && existingOrderNumbers.has(orderNum)) {
      const order = orders.find(o => String(o.orderNumber).trim() === orderNum);
      if (order) {
        order.qty = String(row["QTY"] || "1");
        order.stainType = String(row["Stain color"] || "");
        order.customizations = customizations;
      }
      count++;
      return;
    }

    if (orderNum) existingOrderNumbers.add(orderNum);

    orders.unshift({
      id: uniqueId(),
      orderNumber: orderNum,
      productId: product.id,
      productName: product.name,
      qty: String(row["QTY"] || "1"),
      stainType: String(row["Stain color"] || ""),
      customizations,
      status: "New",
      stage: "New Order"
    });

    count++;
  });

  return count;
}

function finishImport(count, from) {
  if (count > 0) {
    renderAll();
    if (isConnected()) saveToSupabase().catch(() => {});
  }
  console.log("Excel import (" + from + "): " + count + " new orders");
}

async function importFromExcel() {
  try {
    const res = await fetch("Stockroom.xlsx");
    if (!res.ok) return;
    const buf = await res.arrayBuffer();
    const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });

    let remoteNumbers;
    if (isConnected()) {
      try {
        const existing = await supabaseRequest("orders", { params: "?select=order_number" });
        remoteNumbers = new Set(existing.map(r => String(r.order_number).trim()).filter(Boolean));
      } catch (_) {}
    }

    finishImport(processExcelRows(rows, remoteNumbers), "auto");
  } catch (e) {
    console.log("Excel auto-import skipped: " + e.message);
  }
}

function importFromExcelFile(file) {
  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
      finishImport(processExcelRows(rows), "manual");
    } catch (err) {
      showToast("Error importing Excel: " + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

el("#import-excel-btn").addEventListener("click", () => importFromExcel());

importFromExcel();
setInterval(importFromExcel, 60000);

renderAll();

if (isConnected()) {
  loadFromSupabase().catch((error) => {
    syncReady = false;
    setSyncStatus("Auto-load failed");
    showToast(error.message);
  });
}


