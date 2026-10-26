// ============================================================
// app.js — 畫面與互動（計算邏輯都在 engine.js）
// ============================================================
import {
  lumpSumVsDca, rollingComparison, assetAllocation, volatilityStats,
  toDay,
} from "./engine.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const today = new Date().toISOString().slice(0, 10);

// 歷史重大事件（高點 = 崩盤前、低點 = 谷底）
const EVENTS = [
  ["", "— 自訂開始日期 —"],
  ["2022-01-03", "📉 2022 升息前高點 (2022-01-03)"],
  ["2022-10-12", "📈 2022 熊市低點 (2022-10-12)"],
  ["2020-02-19", "📉 2020 新冠疫情高點 (2020-02-19)"],
  ["2020-03-23", "📈 2020 新冠疫情低點 (2020-03-23)"],
  ["2007-10-09", "📉 2007 金融海嘯高點 (2007-10-09)"],
  ["2009-03-09", "📈 2009 金融海嘯低點 (2009-03-09)"],
  ["2000-03-24", "📉 2000 網路泡沫高點 (2000-03-24)"],
  ["2002-10-09", "📈 2002 網路泡沫低點 (2002-10-09)"],
  ["1929-09-03", "📉 1929 大蕭條高點 (1929-09-03，僅 ^GSPC 有資料)"],
  ["1932-06-01", "📈 1932 大蕭條低點 (1932-06-01，僅 ^GSPC 有資料)"],
];

// ---------- 狀態 ----------
const state = {
  manifest: null,
  meta: new Map(),      // symbol -> { symbol, name, file, currency, start, end, note }
  cache: new Map(),     // symbol -> Promise<series>
  pickers: {},          // pickerName -> [symbols]
};

// ---------- 格式化 ----------
const curPrefix = (cur) => (cur === "TWD" ? "NT$" : cur === "USD" ? "$" : "");
const fmtMoney = (v, cur) => `${curPrefix(cur)}${Math.round(v).toLocaleString("en-US")}`;
const fmtPct = (x, signed = true) =>
  x == null || !isFinite(x) ? "—" : `${signed && x > 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
const fmtNum = (x, d = 2) => (x == null || !isFinite(x) ? "—" : x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
const cls = (x) => (x > 0 ? "pos" : x < 0 ? "neg" : "");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const label = (sym) => {
  const m = state.meta.get(sym);
  return m && m.name ? `${sym}（${m.name}）` : sym;
};
const currencyOf = (sym) => state.meta.get(sym)?.currency || "";

// ---------- 資料載入 ----------
async function loadManifest() {
  const status = $("#data-status");
  try {
    const res = await fetch("data/manifest.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(res.status);
    state.manifest = await res.json();
    for (const g of state.manifest.groups) for (const t of g.tickers) state.meta.set(t.symbol, { ...t, group: g.name });
    status.textContent = `資料更新：${state.manifest.updated}（${state.meta.size} 檔）`;
    status.title = state.manifest.source;
  } catch {
    status.innerHTML = "⚠️ 找不到價格資料，請確認 GitHub Actions 已執行，或先上傳 CSV";
  }
  refreshDatalist();
}

function loadSeries(sym) {
  if (!state.cache.has(sym)) {
    const m = state.meta.get(sym);
    if (!m || !m.file) return Promise.reject(new Error(`清單中沒有「${sym}」。可用右上角「上傳 CSV」，或在 scripts/tickers.json 新增後重新部署。`));
    state.cache.set(sym, fetch(`data/${m.file}`).then((r) => {
      if (!r.ok) throw new Error(`${sym} 資料下載失敗 (${r.status})`);
      return r.json();
    }).catch((e) => { state.cache.delete(sym); throw e; }));
  }
  return state.cache.get(sym);
}

function refreshDatalist() {
  let dl = $("#ticker-list");
  if (!dl) { dl = document.createElement("datalist"); dl.id = "ticker-list"; document.body.appendChild(dl); }
  dl.innerHTML = [...state.meta.values()]
    .map((m) => `<option value="${esc(m.symbol)}">${esc(m.name || "")}${m.start ? `｜${m.start.slice(0, 4)} 起` : ""}</option>`)
    .join("");
  Object.keys(state.pickers).forEach(renderChips);
}

/** 使用者輸入 → 代號（可輸入代號或名稱） */
function resolveSymbol(text) {
  const q = text.trim();
  if (!q) return null;
  const up = q.toUpperCase();
  for (const sym of state.meta.keys()) if (sym.toUpperCase() === up) return sym;
  for (const m of state.meta.values()) if ((m.name || "").toLowerCase().includes(q.toLowerCase())) return m.symbol;
  return state.meta.size ? null : up; // 清單還沒載入時先接受
}

// ---------- 自訂 CSV ----------
function parseCsv(text, fileName) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, "").toLowerCase());
  const hasHeader = head.some((h) => /[a-z一-鿿]/.test(h) && !/^\d/.test(h));
  let di = 0, pi = 1;
  if (hasHeader) {
    di = Math.max(0, head.findIndex((h) => h === "date" || h.includes("日期")));
    const prefer = ["adj close", "adj_close", "adjclose", "close", "收盤價", "price", "價格"];
    const found = prefer.map((p) => head.indexOf(p)).find((i) => i >= 0);
    pi = found ?? (di === 0 ? 1 : 0);
  }
  const rows = [];
  for (const line of lines.slice(hasHeader ? 1 : 0)) {
    const c = line.split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
    const d = normDate(c[di]);
    const p = parseFloat((c[pi] || "").replace(/[^0-9.\-]/g, ""));
    if (d && p > 0) rows.push([d, p]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const dedup = rows.filter((r, i) => i === rows.length - 1 || rows[i + 1][0] !== r[0]);
  if (dedup.length < 10) throw new Error("CSV 內有效資料少於 10 筆。需要「日期」和「收盤價」兩個欄位。");
  const symbol = "CSV:" + fileName.replace(/\.[^.]+$/, "");
  return { symbol, dates: dedup.map((r) => r[0]), close: dedup.map((r) => r[1]) };
}

function normDate(s) {
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // 美式 M/D/YYYY
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

$("#csv-upload").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const s = parseCsv(await f.text(), f.name);
    state.meta.set(s.symbol, { symbol: s.symbol, name: "自己上傳的資料", currency: "", start: s.dates[0], end: s.dates.at(-1), group: "我上傳的資料" });
    state.cache.set(s.symbol, Promise.resolve(s));
    refreshDatalist();
    alert(`✅ 已載入 ${s.symbol}：${s.dates[0]} ~ ${s.dates.at(-1)}，共 ${s.dates.length} 筆。\n在任何「投資標的」欄位輸入「${s.symbol}」即可使用（重新整理頁面後會消失）。`);
  } catch (err) {
    alert("❌ " + err.message);
  }
  e.target.value = "";
});

// ---------- 標的選擇器 ----------
function initPickers() {
  $$(".picker").forEach((el) => {
    const name = el.dataset.picker;
    state.pickers[name] = el.dataset.default.split(",").filter(Boolean);
    el.innerHTML = `
      <div class="picker-row">
        <input type="text" list="ticker-list" placeholder="例如 SPY、0050.TW、台積電" aria-label="新增標的">
        <button type="button" class="secondary small">加入</button>
      </div>
      <div class="chips"></div>`;
    const input = $("input", el);
    const add = () => {
      const sym = resolveSymbol(input.value);
      if (!sym) { alert(`找不到「${input.value}」。可從下拉清單選擇，或用右上角「上傳 CSV」。`); return; }
      const max = +el.dataset.max;
      const list = state.pickers[name];
      if (!list.includes(sym)) {
        if (max === 1) list.splice(0, list.length, sym);
        else if (list.length >= max) { alert(`最多 ${max} 檔`); return; }
        else list.push(sym);
      }
      input.value = "";
      renderChips(name);
    };
    $("button", el).addEventListener("click", add);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
    input.addEventListener("change", () => { if (state.meta.has(input.value)) add(); });
    renderChips(name);
  });
}

function renderChips(name) {
  const el = $(`.picker[data-picker="${name}"] .chips`);
  if (!el) return;
  el.innerHTML = state.pickers[name].map((s) => {
    const m = state.meta.get(s);
    const title = m ? `${m.name || ""}${m.start ? `｜資料 ${m.start} 起` : ""}${m.note ? `｜${m.note}` : ""}` : "";
    return `<span class="chip" title="${esc(title)}">${esc(s)}<button type="button" aria-label="移除 ${esc(s)}" data-sym="${esc(s)}">×</button></span>`;
  }).join("");
  $$("button", el).forEach((b) => b.addEventListener("click", () => {
    state.pickers[name] = state.pickers[name].filter((x) => x !== b.dataset.sym);
    renderChips(name);
  }));
}

// ---------- 圖表 ----------
function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return { text: v("--text"), muted: v("--muted"), border: v("--border"), panel: v("--panel"), ls: v("--ls"), dca: v("--dca"), good: v("--good"), bad: v("--bad"), accent: v("--accent") };
}
const PALETTE = ["#2563eb", "#e8590c", "#12805c", "#9c36b5", "#c2255c", "#0c8599"];

function plot(el, traces, layout = {}) {
  if (!window.Plotly) { el.innerHTML = `<div class="notice error">圖表元件載入失敗（可能是網路阻擋 CDN），請重新整理。</div>`; return; }
  const c = themeColors();
  Plotly.react(el, traces, {
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: c.text, family: getComputedStyle(document.body).fontFamily, size: 12 },
    margin: { l: 60, r: 16, t: 30, b: 40 },
    legend: { orientation: "h", y: 1.1, x: 0 },
    hovermode: "x unified",
    ...layout,
    // 座標軸設定合併（而不是整個覆蓋），automargin 避免刻度數字被切掉
    xaxis: { gridcolor: c.border, linecolor: c.border, zerolinecolor: c.border, automargin: true, ...layout.xaxis },
    yaxis: { gridcolor: c.border, linecolor: c.border, zerolinecolor: c.border, automargin: true, ...layout.yaxis },
  }, { responsive: true, displaylogo: false, modeBarButtonsToRemove: ["lasso2d", "select2d"] });
}

function busy(out, msg = "計算中…") {
  out.innerHTML = `<div class="panel placeholder"><span class="spinner"></span> ${msg}</div>`;
}
function errorBox(out, msg) {
  out.innerHTML = `<div class="notice error">❌ ${esc(msg)}</div>`;
}
const notices = (list) => list.map((n) => `<div class="notice">${n}</div>`).join("");

function readNum(id, { min = -Infinity, max = Infinity, name } = {}) {
  const v = parseFloat($(id).value);
  if (!isFinite(v) || v < min || v > max) throw new Error(`「${name}」需介於 ${min} ~ ${max}`);
  return v;
}

// ---------- 分頁 ----------
function showTab(name) {
  $$("nav.tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === name));
  $$("section.tab").forEach((s) => s.classList.toggle("active", s.id === `tab-${name}`));
  if (name === "wall") Wall.activate(); else Wall.deactivate();
  // 隱藏時畫的圖寬度會錯，切回來時重算
  setTimeout(() => $$(`#tab-${name} .js-plotly-plot`).forEach((p) => window.Plotly && Plotly.Plots.resize(p)), 30);
}
$$("nav.tabs button").forEach((b) => b.addEventListener("click", () => {
  showTab(b.dataset.tab);
  history.replaceState(null, "", `#${b.dataset.tab}`);
}));

// ============================================================
// 1. 單筆 vs 定期定額
// ============================================================
function updatePlanHint() {
  const m = +$("#dca-months").value, n = +$("#dca-count").value, a = +$("#dca-amount").value;
  if (!(m > 0 && n > 0 && a > 0)) return;
  const gap = m / n;
  const gapTxt = gap >= 1 ? `約每 ${fmtNum(gap, gap % 1 ? 1 : 0)} 個月` : `約每 ${Math.round(gap * 30.4)} 天`;
  $("#dca-plan-hint").textContent = `→ ${gapTxt}扣款一次，每次投入 ${Math.round(a / n).toLocaleString("en-US")}，共 ${n} 次。`;
}
["#dca-months", "#dca-count", "#dca-amount"].forEach((id) => $(id).addEventListener("input", updatePlanHint));

$("#form-dca").addEventListener("submit", async (e) => {
  e.preventDefault();
  const out = $("#out-dca");
  try {
    const tickers = state.pickers.dca;
    if (!tickers.length) throw new Error("請至少選一個投資標的");
    const opts = {
      amount: readNum("#dca-amount", { min: 1, name: "總投資金額" }),
      start: $("#dca-start").value,
      end: $("#dca-end").value || today,
      dcaMonths: Math.round(readNum("#dca-months", { min: 1, max: 240, name: "分幾個月買完" })),
      dcaCount: Math.round(readNum("#dca-count", { min: 1, max: 520, name: "分幾次扣款" })),
      cashYield: readNum("#dca-yield", { min: 0, max: 20, name: "現金年利率" }) / 100,
    };
    if (!opts.start) throw new Error("請選擇開始日期");
    if (opts.start >= opts.end) throw new Error("開始日期必須早於結束日期");
    busy(out, "下載資料並計算中…");
    saveHash("dca", { t: tickers.join(","), a: opts.amount, s: opts.start, e: $("#dca-end").value, m: opts.dcaMonths, n: opts.dcaCount, y: $("#dca-yield").value });

    const results = [], warns = [];
    for (const sym of tickers) {
      try {
        const series = await loadSeries(sym);
        const r = lumpSumVsDca(series, opts);
        if (r.error) { warns.push(`${esc(sym)}：${esc(r.error)}`); continue; }
        results.push(r);
      } catch (err) { warns.push(esc(err.message)); }
    }
    if (!results.length) { out.innerHTML = notices(warns) || ""; return; }
    renderDca(out, results, opts, warns);
  } catch (err) { errorBox(out, err.message); }
});

function renderDca(out, results, opts, warns) {
  const c = themeColors();
  // 提醒事項
  for (const r of results) {
    const gap = toDay(r.actualStart) - toDay(opts.start);
    if (gap > 7) warns.push(`<b>${esc(r.symbol)}</b> 的資料從 ${state.meta.get(r.symbol)?.start || r.actualStart} 開始，實際回測起點為 <b>${r.actualStart}</b>（不是你選的 ${opts.start}）。不同起點的標的不能直接比較。`);
    if (r.skipped) warns.push(`<b>${esc(r.symbol)}</b>：結束日期太早，${opts.dcaCount} 次扣款中有 <b>${r.skipped} 次還沒執行</b>，那部分以現金計算。`);
    if (r.years < 1) warns.push(`<b>${esc(r.symbol)}</b>：回測期間不到 1 年，年化報酬率會被放大，請以總報酬率為主。`);
  }
  const curs = new Set(results.map((r) => currencyOf(r.symbol)).filter(Boolean));
  if (curs.size > 1) warns.push("同時包含新台幣與美元計價的標的，金額未換匯，請比較「報酬率」而不是金額。");
  const notesUniq = [...new Set(results.map((r) => state.meta.get(r.symbol)?.note).filter((n) => n && n.includes("不含股息")))];
  if (notesUniq.length) warns.push("指數（^GSPC、^TWII）是價格指數，<b>不含股息</b>，長期報酬會被低估。");

  // 結論
  const verdicts = results.map((r) => {
    const lsWin = r.ls.final >= r.dca.final;
    const diff = lsWin ? r.ls.final / r.dca.final - 1 : r.dca.final / r.ls.final - 1;
    const lastBuy = r.buys.at(-1);
    const buyMove = lastBuy ? lastBuy.price / r.price[0] - 1 : 0;
    const why = !lastBuy ? "" : buyMove >= 0
      ? `買進期間（${r.actualStart} ~ ${lastBuy.date}）價格<b class="pos">上漲 ${fmtPct(buyMove, false)}</b>，DCA 後面幾筆越買越貴，所以單筆投入佔優勢。`
      : `買進期間（${r.actualStart} ~ ${lastBuy.date}）價格<b class="neg">下跌 ${fmtPct(-buyMove, false)}</b>，DCA 後面幾筆買在比較低的價格，所以定期定額佔優勢。`;
    return `<p>🏆 <b>${esc(label(r.symbol))}</b>：<b style="color:${lsWin ? c.ls : c.dca}">${lsWin ? "單筆投入" : "定期定額"}</b> 的期末資產多了 <b>${fmtPct(diff, false)}</b>。${why}</p>`;
  }).join("");

  const cards = results.map((r) => {
    const cur = currencyOf(r.symbol);
    return `
      <div class="card ls"><div class="k">${esc(r.symbol)}・單筆投入</div><div class="v">${fmtMoney(r.ls.final, cur)}</div><div class="s"><span class="${cls(r.ls.totalReturn)}">${fmtPct(r.ls.totalReturn)}</span>｜年化 ${fmtPct(r.ls.cagr)}</div></div>
      <div class="card dca"><div class="k">${esc(r.symbol)}・定期定額</div><div class="v">${fmtMoney(r.dca.final, cur)}</div><div class="s"><span class="${cls(r.dca.totalReturn)}">${fmtPct(r.dca.totalReturn)}</span>｜年化 ${fmtPct(r.dca.cagr)}</div></div>`;
  }).join("");

  const sel = results.length > 1
    ? `<select id="dca-detail-sel" style="width:auto">${results.map((r, i) => `<option value="${i}">${esc(label(r.symbol))}</option>`).join("")}</select>` : "";

  out.innerHTML = `
    ${notices(warns)}
    <div class="verdict"><h3>📌 結論</h3>${verdicts}
      <p class="hint">記得：這只是「一個起點」的結果。想知道一般情況下誰比較常贏，請看「🎲 勝率分析」。</p></div>
    <div class="cards">${cards}</div>

    <div class="panel">
      <h3>資產價值變化</h3>
      <div class="chart" id="chart-dca-value"></div>
      <p class="how-to-read"><b>這張圖怎麼看：</b>實線是單筆投入、虛線是定期定額，灰色虛線是投入本金。DCA 在買進期間只有部分資金在市場內，所以起伏比較小；買完之後兩條線會「平行」移動，差距就固定在買進期間造成的那一段。</p>
    </div>

    <div class="panel">
      <h3>扣款紀錄與平均成本 ${sel}</h3>
      <div class="chart short" id="chart-dca-buys"></div>
      <p class="how-to-read" id="dca-buys-text"></p>
      <details class="explain"><summary>查看每一筆扣款明細</summary><div class="table-wrap" id="dca-buys-table"></div></details>
    </div>

    <div class="panel">
      <h3>績效指標</h3>
      <div class="table-wrap">${metricsTable(results)}</div>
      <details class="explain"><summary>這些指標是什麼意思？</summary>
        <ul>
          <li><b>總報酬率</b> = 期末資產 ÷ 總投資金額 − 1。兩種策略用同一個分母，才能公平比較。</li>
          <li><b>年化報酬率 (CAGR)</b> = (期末 ÷ 期初)^(1/年數) − 1，把總報酬換算成「平均每年」。</li>
          <li><b>最大回撤</b>：資產從最高點跌到最低點的最大幅度。DCA 在買進期間資金沒有全部進場，回撤通常比較小，這就是它「心理上比較舒服」的原因。</li>
          <li><b>平均持股比例</b>：整段期間平均有多少比例的錢在市場內。單筆是 100%。</li>
          <li><b>平均成本 vs 平均價格</b>：見「📚 觀念教室 → 平均成本迷思」。</li>
        </ul>
      </details>
    </div>

    <div class="panel">
      <h3>逐年報酬率</h3>
      <p class="hint" style="margin-top:0">以每年最後一個交易日的「總資產（含未投入現金）」計算；第一年從開始日起算，最後一年到結束日為止（可能不滿一年）。</p>
      <div class="table-wrap">${annualTable(results)}</div>
    </div>`;

  // 圖 1：資產價值
  const traces = [];
  results.forEach((r, i) => {
    const color = results.length === 1 ? c.ls : PALETTE[i % PALETTE.length];
    const color2 = results.length === 1 ? c.dca : PALETTE[i % PALETTE.length];
    traces.push({ x: r.dates, y: r.lsValue, name: `${r.symbol} 單筆`, mode: "lines", line: { color, width: 2 }, hovertemplate: "%{y:,.0f}" });
    traces.push({ x: r.dates, y: r.dcaValue, name: `${r.symbol} 定期定額`, mode: "lines", line: { color: color2, width: 2, dash: "dash" }, hovertemplate: "%{y:,.0f}" });
  });
  plot($("#chart-dca-value"), traces, {
    yaxis: { gridcolor: c.border, tickformat: ",.0f", title: { text: "資產價值" } },
    shapes: [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: opts.amount, y1: opts.amount, line: { color: c.muted, dash: "dot", width: 1 } }],
  });

  const drawBuys = (r) => {
    const end = r.buys.length ? r.buys.at(-1).date : r.dates.at(-1);
    const iEnd = Math.min(r.dates.length - 1, r.dates.indexOf(end) + 40);
    const xs = r.dates.slice(0, iEnd + 1), ys = r.price.slice(0, iEnd + 1);
    const tr = [
      { x: xs, y: ys, name: "價格（還原權息）", mode: "lines", line: { color: c.muted, width: 1.5 }, hovertemplate: "%{y:,.2f}" },
      { x: r.buys.map((b) => b.date), y: r.buys.map((b) => b.price), name: "DCA 扣款", mode: "markers", marker: { color: c.dca, size: 9, symbol: "triangle-up" }, hovertemplate: "扣款 %{y:,.2f}" },
      { x: [r.dates[0]], y: [r.price[0]], name: "單筆買進", mode: "markers", marker: { color: c.ls, size: 13, symbol: "star" }, hovertemplate: "單筆 %{y:,.2f}" },
    ];
    const shapes = [];
    if (r.dca.avgCost) shapes.push({ type: "line", x0: xs[0], x1: xs.at(-1), y0: r.dca.avgCost, y1: r.dca.avgCost, line: { color: c.dca, dash: "dash", width: 1.5 } });
    shapes.push({ type: "line", x0: xs[0], x1: xs.at(-1), y0: r.price[0], y1: r.price[0], line: { color: c.ls, dash: "dot", width: 1.5 } });
    plot($("#chart-dca-buys"), tr, { shapes, yaxis: { gridcolor: c.border, title: { text: "價格" } } });
    const lower = r.dca.avgCost < r.price[0];
    $("#dca-buys-text").innerHTML = r.dca.avgCost
      ? `<b>這張圖怎麼看：</b>藍色星星是單筆買進價 <b>${fmtNum(r.price[0])}</b>（藍色點線），橘色三角形是每次扣款，橘色虛線是 DCA 的平均成本 <b>${fmtNum(r.dca.avgCost)}</b>。`
        + `平均成本${lower ? "<b class='pos'>低於</b>" : "<b class='neg'>高於</b>"}單筆買進價，所以${lower ? "定期定額" : "單筆投入"}買到比較多股數。`
        + `（扣款日平均價格是 ${fmtNum(r.dca.avgPrice)}，平均成本一定 ≤ 它，但這不代表會贏過單筆。）`
      : "";
    $("#dca-buys-table").innerHTML = `<table class="data"><thead><tr><th>扣款日</th><th>價格</th><th>投入金額</th><th>買到股數</th></tr></thead><tbody>${
      r.buys.map((b) => `<tr><td>${b.date}${b.times > 1 ? `（${b.times} 筆合併）` : ""}</td><td>${fmtNum(b.price)}</td><td>${Math.round(b.amount).toLocaleString("en-US")}</td><td>${fmtNum(b.shares, 4)}</td></tr>`).join("")
    }</tbody></table>`;
  };
  drawBuys(results[0]);
  $("#dca-detail-sel")?.addEventListener("change", (e) => drawBuys(results[+e.target.value]));
}

function metricsTable(results) {
  const rows = results.flatMap((r) => {
    const cur = currencyOf(r.symbol);
    const win = r.ls.final >= r.dca.final;
    return [
      `<tr class="${win ? "win" : ""}"><td>${esc(r.symbol)} 單筆投入</td><td>${fmtMoney(r.ls.final, cur)}</td><td class="${cls(r.ls.totalReturn)}">${fmtPct(r.ls.totalReturn)}</td><td class="${cls(r.ls.cagr)}">${fmtPct(r.ls.cagr)}</td><td class="neg" title="${r.ls.mddPeak} → ${r.ls.mddTrough}">${fmtPct(r.ls.mdd)}</td><td>100%</td><td>${fmtNum(r.price[0])}</td><td>—</td></tr>`,
      `<tr class="${win ? "" : "win"}"><td>${esc(r.symbol)} 定期定額</td><td>${fmtMoney(r.dca.final, cur)}</td><td class="${cls(r.dca.totalReturn)}">${fmtPct(r.dca.totalReturn)}</td><td class="${cls(r.dca.cagr)}">${fmtPct(r.dca.cagr)}</td><td class="neg" title="${r.dca.mddPeak} → ${r.dca.mddTrough}">${fmtPct(r.dca.mdd)}</td><td>${fmtPct(r.dca.avgExposure, false)}</td><td>${fmtNum(r.dca.avgCost)}</td><td>${fmtNum(r.dca.avgPrice)}</td></tr>`,
    ];
  }).join("");
  return `<table class="data"><thead><tr><th>策略</th><th>期末資產</th><th>總報酬率</th><th>年化報酬率</th><th>最大回撤</th><th>平均持股比例</th><th>平均成本</th><th>扣款日平均價格</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function annualTable(results) {
  const years = [...new Set(results.flatMap((r) => r.annual.map((a) => a.year)))].sort();
  const head = results.map((r) => `<th>${esc(r.symbol)} 單筆</th><th>${esc(r.symbol)} 定期定額</th>`).join("");
  const body = years.map((y) => `<tr><td>${y}</td>${results.map((r) => {
    const a = r.annual.find((x) => x.year === y);
    return a ? `<td class="${cls(a.ls)}">${fmtPct(a.ls)}</td><td class="${cls(a.dca)}">${fmtPct(a.dca)}</td>` : "<td>—</td><td>—</td>";
  }).join("")}</tr>`).join("");
  return `<table class="data"><thead><tr><th>年度</th>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// ============================================================
// 2. 勝率分析（滾動起點）
// ============================================================
$("#form-rolling").addEventListener("submit", async (e) => {
  e.preventDefault();
  const out = $("#out-rolling");
  try {
    const sym = state.pickers.rolling[0];
    if (!sym) throw new Error("請選擇一個投資標的");
    const opts = {
      amount: 1,
      from: $("#roll-from").value || null,
      horizonMonths: +$("#roll-horizon").value,
      dcaMonths: Math.round(readNum("#roll-months", { min: 1, max: 120, name: "分幾個月買完" })),
      dcaCount: Math.round(readNum("#roll-count", { min: 1, max: 520, name: "分幾次扣款" })),
      cashYield: readNum("#roll-yield", { min: 0, max: 20, name: "現金年利率" }) / 100,
    };
    if (opts.dcaMonths > opts.horizonMonths) throw new Error("「分幾個月買完」不能超過「每次持有幾年」");
    busy(out, "逐月計算中…");
    saveHash("rolling", { t: sym, f: opts.from || "", h: opts.horizonMonths, m: opts.dcaMonths, n: opts.dcaCount, y: $("#roll-yield").value });
    const series = await loadSeries(sym);
    // 讓「計算中」先畫出來
    await new Promise((r) => setTimeout(r, 10));
    const res = rollingComparison(series, opts);
    if (res.error) throw new Error(res.error);
    renderRolling(out, sym, res, opts);
  } catch (err) { errorBox(out, err.message); }
});

function renderRolling(out, sym, res, opts) {
  const c = themeColors();
  const hY = opts.horizonMonths / 12;
  const win = res.lsWinRate;
  const first = res.rows[0].start, last = res.rows.at(-1).start;
  const note = state.meta.get(sym)?.note;
  out.innerHTML = `
    ${note ? notices([`${esc(sym)}：${esc(note)}`]) : ""}
    <div class="verdict">
      <h3>📌 結論</h3>
      <p>從 <b>${first.slice(0, 7)}</b> 到 <b>${last.slice(0, 7)}</b>，共 <b>${res.count}</b> 個月份起點。每次拿到錢後持有 <b>${hY} 年</b>，
      單筆投入有 <b style="color:${c.ls}">${fmtPct(win, false)}</b> 的機率贏過「${opts.dcaMonths} 個月分 ${opts.dcaCount} 次」的定期定額。</p>
      <p>典型情況（中位數）下，單筆投入的期末資產比 DCA ${res.medianDiff >= 0 ? "多" : "少"} <b>${fmtPct(Math.abs(res.medianDiff), false)}</b>。
      最好的情況單筆多 ${fmtPct(res.best.diff, false)}（${res.best.start.slice(0, 7)} 起），最差的情況單筆少 ${fmtPct(-res.worst.diff, false)}（${res.worst.start.slice(0, 7)} 起）。</p>
      <p class="hint">換句話說：大約每 10 次有 ${Math.round(win * 10)} 次單筆比較好；但輸的時候（通常是崩盤前夕）可能輸很多。這就是「期望報酬」與「後悔風險」的取捨。</p>
    </div>
    <div class="cards">
      <div class="card ls"><div class="k">單筆投入勝率</div><div class="v">${fmtPct(win, false)}</div><div class="s">${res.count} 個起點</div></div>
      <div class="card dca"><div class="k">定期定額勝率</div><div class="v">${fmtPct(1 - win, false)}</div><div class="s">多半發生在崩盤前</div></div>
      <div class="card"><div class="k">單筆領先幅度（中位數）</div><div class="v ${cls(res.medianDiff)}">${fmtPct(res.medianDiff)}</div><div class="s">10%~90% 區間：${fmtPct(res.p10Diff)} ~ ${fmtPct(res.p90Diff)}</div></div>
    </div>
    <div class="panel">
      <h3>每個起點的勝負</h3>
      <div class="chart" id="chart-roll-time"></div>
      <p class="how-to-read"><b>這張圖怎麼看：</b>橫軸是「拿到錢的月份」，縱軸是持有 ${hY} 年後單筆比 DCA 多賺（正）或少賺（負）的百分比。
      <span style="color:${c.ls}">■ 藍色</span> = 單筆贏，<span style="color:${c.dca}">■ 橘色</span> = 定期定額贏。橘色常集中在 1929、2000、2007 這類大崩盤前夕。</p>
    </div>
    <div class="panel">
      <h3>勝負幅度分布</h3>
      <div class="chart short" id="chart-roll-hist"></div>
      <p class="how-to-read"><b>這張圖怎麼看：</b>把所有起點的結果做成直方圖。越多柱子落在 0 的右邊，代表單筆越常贏；柱子離 0 越遠，代表贏或輸得越多。</p>
    </div>
    <details class="explain panel"><summary>計算方式與注意事項</summary>
      <ul>
        <li>每個月的第一個交易日當作一個起點，兩種策略都從同一筆錢開始，比較 ${hY} 年後（最接近的交易日）的期末資產。</li>
        <li>勝負幅度 = 單筆期末資產 ÷ DCA 期末資產 − 1。</li>
        <li>相鄰起點的持有期間大量重疊，所以樣本<b>並非互相獨立</b>，勝率是「歷史描述」，不是精確的機率。</li>
        <li>DCA 還沒投入的現金以 ${fmtPct(opts.cashYield, false)} 年利率計息；調高利率會讓 DCA 勝率上升，可以自己試試。</li>
      </ul>
    </details>`;

  plot($("#chart-roll-time"), [{
    type: "bar", x: res.rows.map((r) => r.start), y: res.rows.map((r) => r.diff * 100),
    marker: { color: res.rows.map((r) => (r.diff >= 0 ? c.ls : c.dca)) },
    hovertemplate: "%{x|%Y-%m} 起：單筆 %{y:+.1f}%<extra></extra>", name: "單筆 − DCA",
  }], { bargap: 0, showlegend: false, yaxis: { gridcolor: c.border, ticksuffix: "%", title: { text: "單筆比 DCA 多賺" } }, hovermode: "closest" });

  // 直方圖（手動分箱，plotly-basic 沒有 histogram）
  const vals = res.rows.map((r) => r.diff * 100);
  const lo = Math.floor(Math.min(...vals)), hi = Math.ceil(Math.max(...vals));
  const width = Math.max(0.5, (hi - lo) / 40);
  const bins = new Map();
  for (const v of vals) {
    const b = lo + Math.floor((v - lo) / width) * width;
    bins.set(b, (bins.get(b) || 0) + 1);
  }
  const xs = [...bins.keys()].sort((a, b) => a - b);
  plot($("#chart-roll-hist"), [{
    type: "bar", x: xs.map((x) => x + width / 2), y: xs.map((x) => bins.get(x)), width: width * 0.95,
    marker: { color: xs.map((x) => (x + width / 2 >= 0 ? c.ls : c.dca)) },
    hovertemplate: "%{x:.1f}%：%{y} 次<extra></extra>",
  }], { showlegend: false, xaxis: { gridcolor: c.border, ticksuffix: "%", title: { text: "單筆比 DCA 多賺" } }, yaxis: { gridcolor: c.border, title: { text: "次數" } }, hovermode: "closest" });
}

// ============================================================
// 3. 資產配置
// ============================================================
function addAllocRow(sym = "", w = "") {
  const row = document.createElement("div");
  row.className = "alloc-row";
  row.innerHTML = `<input type="text" list="ticker-list" value="${esc(sym)}" placeholder="代號" aria-label="標的代號">
    <input type="number" value="${w}" min="0" max="100" step="5" aria-label="比例 %" placeholder="%">
    <button type="button" aria-label="移除">✕</button>`;
  $("button", row).addEventListener("click", () => { row.remove(); updateAllocSum(); });
  $$("input", row).forEach((i) => i.addEventListener("input", updateAllocSum));
  $("#alloc-rows").appendChild(row);
  updateAllocSum();
}
function readAllocRows() {
  return $$("#alloc-rows .alloc-row").map((r) => {
    const [a, b] = $$("input", r);
    return { raw: a.value.trim(), w: parseFloat(b.value) || 0 };
  }).filter((x) => x.raw || x.w);
}
function updateAllocSum() {
  const sum = readAllocRows().reduce((a, r) => a + r.w, 0);
  const el = $("#alloc-sum");
  const ok = Math.abs(sum - 100) < 0.01;
  el.textContent = `合計 ${fmtNum(sum, sum % 1 ? 1 : 0)}%${ok ? " ✓" : "（需等於 100%）"}`;
  el.className = `alloc-sum ${ok ? "ok" : "bad"}`;
}
$("#alloc-add").addEventListener("click", () => addAllocRow());
$("#alloc-wd").addEventListener("change", (e) => { $("#alloc-wd-box").hidden = !e.target.checked; });

$("#form-alloc").addEventListener("submit", async (e) => {
  e.preventDefault();
  const out = $("#out-alloc");
  try {
    const rows = readAllocRows();
    if (!rows.length) throw new Error("請至少新增一個標的");
    const syms = rows.map((r) => {
      const s = resolveSymbol(r.raw);
      if (!s) throw new Error(`找不到標的「${r.raw}」`);
      return s;
    });
    if (new Set(syms).size !== syms.length) throw new Error("有重複的標的，請合併比例");
    const sum = rows.reduce((a, r) => a + r.w, 0);
    if (Math.abs(sum - 100) > 0.01) throw new Error(`目前比例合計 ${sum}%，需剛好 100%`);
    const opts = {
      capital: readNum("#alloc-capital", { min: 1, name: "期初資金" }),
      start: $("#alloc-start").value,
      end: $("#alloc-end").value || today,
      weights: rows.map((r) => r.w / 100),
      rebalance: $("#alloc-rebal").value,
      withdraw: {
        enabled: $("#alloc-wd").checked,
        amount: readNum("#alloc-wd-amt", { min: 0, name: "每次提領" }),
        freq: $("#alloc-wd-freq").value,
        inflation: readNum("#alloc-wd-inf", { min: 0, max: 15, name: "提領調高" }) / 100,
      },
    };
    if (!opts.start || opts.start >= opts.end) throw new Error("請確認開始與結束日期");
    busy(out);
    const series = await Promise.all(syms.map(loadSeries));
    const res = assetAllocation(series, opts);
    if (res.error) throw new Error(res.error);
    renderAlloc(out, syms, res, opts);
  } catch (err) { errorBox(out, err.message); }
});

function renderAlloc(out, syms, res, opts) {
  const c = themeColors();
  const warns = [];
  if (toDay(res.actualStart) - toDay(opts.start) > 7) {
    const late = syms.map((s) => [s, state.meta.get(s)?.start]).filter(([, d]) => d && d > opts.start).map(([s, d]) => `${s}（${d} 起）`);
    warns.push(`實際回測起點為 <b>${res.actualStart}</b>，因為 ${late.join("、") || "部分標的"} 在那之前沒有資料。`);
  }
  const curs = new Set(syms.map(currencyOf).filter(Boolean));
  const cur = curs.size === 1 ? [...curs][0] : "";
  if (curs.size > 1) warns.push("⚠️ 同時混合新台幣與美元計價的標的，但<b>沒有做匯率換算</b>，結果會失真。建議同一幣別的標的放在一起回測。");
  const wdRate = opts.withdraw.enabled ? (opts.withdraw.amount * (opts.withdraw.freq === "month" ? 12 : 1)) / opts.capital : 0;

  out.innerHTML = `
    ${notices(warns)}
    ${res.bankrupt ? `<div class="notice error">💥 <b>資金在 ${res.bankruptDate} 耗盡。</b>在這個起點與提領速度下，投資組合撐了 ${fmtNum((toDay(res.bankruptDate) - toDay(res.actualStart)) / 365.25, 1)} 年。試試降低提領金額或提高債券比例。</div>` : ""}
    <div class="cards">
      <div class="card"><div class="k">期初資金</div><div class="v">${fmtMoney(opts.capital, cur)}</div><div class="s">${res.actualStart} 起</div></div>
      <div class="card"><div class="k">期末餘額</div><div class="v">${res.bankrupt ? "歸零" : fmtMoney(res.final, cur)}</div><div class="s">${res.actualEnd}</div></div>
      <div class="card"><div class="k">累計提領</div><div class="v">${fmtMoney(res.totalWithdrawn, cur)}</div><div class="s">${opts.withdraw.enabled ? `初始提領率 ${fmtPct(wdRate, false)}／年` : "未啟用提領"}</div></div>
      <div class="card"><div class="k">投資組合年化報酬（TWR）</div><div class="v ${cls(res.twrCagr)}">${fmtPct(res.twrCagr)}</div><div class="s">已排除提領影響</div></div>
      <div class="card"><div class="k">最大回撤</div><div class="v neg">${fmtPct(res.mdd)}</div><div class="s">${res.mddPeak} → ${res.mddTrough}</div></div>
    </div>
    <div class="panel">
      <h3>資產餘額變化</h3>
      <div class="chart" id="chart-alloc"></div>
      <p class="how-to-read"><b>這張圖怎麼看：</b>藍線是帳戶餘額（已扣除提領）。有提領時，餘額低於本金不代表投資虧損，要看上方的 TWR 年化報酬才知道投資組合本身的表現。</p>
    </div>
    <div class="panel">
      <h3>年度壓力測試表</h3>
      <div class="table-wrap">${allocTable(syms, res, cur)}</div>
      <details class="explain"><summary>表格說明與計算順序</summary>
        <ul>
          <li><b>標的報酬</b>：上一年最後一個交易日收盤 → 今年最後一個交易日收盤（第一年從開始日起算）。</li>
          <li><b>組合報酬</b>：時間加權報酬，不受提領影響。</li>
          <li>每個交易日的處理順序：① 用收盤價計算市值 → ② 若進入新的再平衡週期，依目標比例重新分配 → ③ 若進入新的提領週期，等比例賣出提領金額；不夠提領時視為破產。</li>
          <li>提領金額每年調高 ${fmtPct(opts.withdraw.inflation, false)}（以日曆年計算）。</li>
          <li>未計入交易成本、稅與匯率。</li>
        </ul>
      </details>
    </div>`;

  const shapes = [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: opts.capital, y1: opts.capital, line: { color: c.muted, dash: "dot", width: 1 } }];
  if (res.bankrupt) shapes.push({ type: "line", yref: "paper", y0: 0, y1: 1, x0: res.bankruptDate, x1: res.bankruptDate, line: { color: c.bad, dash: "dash", width: 2 } });
  plot($("#chart-alloc"), [{ x: res.dates, y: res.values, name: "帳戶餘額", mode: "lines", line: { color: c.ls, width: 2 }, hovertemplate: "%{y:,.0f}" }],
    { shapes, showlegend: false, yaxis: { gridcolor: c.border, tickformat: ",.0f" } });
}

function allocTable(syms, res, cur) {
  const head = syms.map((s) => `<th>${esc(s)} 報酬</th><th>${esc(s)} 年底金額</th>`).join("");
  const body = res.annual.map((r) => `<tr><td>${r.year}</td>${r.assets.map((a) => `<td class="${cls(a.ret)}">${fmtPct(a.ret)}</td><td>${fmtMoney(a.value, cur)}</td>`).join("")}
    <td class="${cls(r.portfolioRet)}">${fmtPct(r.portfolioRet)}</td><td>${fmtMoney(r.withdrawn, cur)}</td><td><b>${fmtMoney(r.endValue, cur)}</b></td></tr>`).join("");
  return `<table class="data"><thead><tr><th>年度</th>${head}<th>組合報酬</th><th>當年提領</th><th>年底餘額</th></tr></thead><tbody>${body}</tbody></table>`;
}

// ============================================================
// 4. 波動與風險
// ============================================================
$("#form-vol").addEventListener("submit", async (e) => {
  e.preventDefault();
  const out = $("#out-vol");
  try {
    const syms = state.pickers.vol;
    if (!syms.length) throw new Error("請至少選一個投資標的");
    const ths = [...new Set($$(".vol-t").map((i) => parseFloat(i.value)).filter((x) => x > 0))].sort((a, b) => a - b);
    if (!ths.length) throw new Error("請設定至少一個門檻");
    busy(out);
    const res = [], warns = [];
    for (const s of syms) {
      try {
        const r = volatilityStats(await loadSeries(s), ths, $("#vol-start").value || null, $("#vol-end").value || null);
        if (r.error) warns.push(esc(r.error)); else res.push(r);
      } catch (err) { warns.push(esc(err.message)); }
    }
    if (!res.length) throw new Error(warns.join("；") || "沒有可分析的資料");
    renderVol(out, res, ths, warns);
  } catch (err) { errorBox(out, err.message); }
});

function renderVol(out, res, ths, warns) {
  const c = themeColors();
  const starts = new Set(res.map((r) => r.start));
  if (starts.size > 1) warns.push("各標的資料起點不同（見表格「統計期間」），次數會受資料長度影響；比較時建議看「每年平均次數」或設定相同的開始日期。");
  const td = (v) => `<td>${v}</td>`;
  const rows = [
    ["統計期間", (r) => `${r.start}<br>~ ${r.end}`],
    ["交易日數", (r) => r.days.toLocaleString("en-US")],
    ...ths.flatMap((t, k) => [
      [`單日漲 ≥ ${t}%（次）`, (r) => `<span class="pos">${r.counts[k].up}</span> <span class="hint" style="display:inline">（${fmtNum(r.counts[k].up / (r.days / r.perYear), 1)}／年）</span>`],
      [`單日跌 ≥ ${t}%（次）`, (r) => `<span class="neg">${r.counts[k].down}</span> <span class="hint" style="display:inline">（${fmtNum(r.counts[k].down / (r.days / r.perYear), 1)}／年）</span>`],
    ]),
    ["最長連漲", (r) => `${r.maxUp.days} 天 <span class="pos">${fmtPct(r.maxUp.ret)}</span><br><span class="hint" style="display:inline">${r.maxUp.from || ""} ~ ${r.maxUp.to || ""}</span>`],
    ["最長連跌", (r) => `${r.maxDown.days} 天 <span class="neg">${fmtPct(r.maxDown.ret)}</span><br><span class="hint" style="display:inline">${r.maxDown.from || ""} ~ ${r.maxDown.to || ""}</span>`],
    ["最大回撤", (r) => `<span class="neg">${fmtPct(r.mdd)}</span><br><span class="hint" style="display:inline">${r.mddPeak} → ${r.mddTrough}</span>`],
    ["年化報酬率 (CAGR)", (r) => `<span class="${cls(r.cagr)}">${fmtPct(r.cagr)}</span>`],
    ["年化波動率", (r) => fmtPct(r.annVol, false)],
    ["索提諾比率", (r) => fmtNum(r.sortino)],
  ];
  out.innerHTML = `
    ${notices(warns)}
    <div class="panel">
      <h3>統計結果</h3>
      <div class="table-wrap"><table class="data"><thead><tr><th>指標</th>${res.map((r) => `<th>${esc(r.symbol)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(([k, f]) => `<tr><td>${k}</td>${res.map((r) => td(f(r))).join("")}</tr>`).join("")}</tbody></table></div>
      <details class="explain"><summary>這些指標怎麼看？</summary>
        <ul>
          <li><b>單日漲跌次數</b>：次數越多代表股性越活潑（或越暴躁）。括號內是「平均每年幾次」，資料長度不同時用它比較才公平。</li>
          <li><b>最長連漲／連跌</b>：連續收紅（或收黑）的最多天數與累積漲跌幅；平盤日會中斷連續。</li>
          <li><b>最大回撤</b>：從歷史高點跌到低點的最大幅度，代表「抱股最痛的程度」。</li>
          <li><b>年化波動率</b>：每日報酬標準差 × √(每年交易日數)。本工具依資料自動判斷每年交易日數（股票約 252、加密貨幣約 365）。</li>
          <li><b>索提諾比率</b>：平均日報酬 ÷ 下檔標準差 × √(每年交易日數)，下檔標準差只計算負報酬（無風險利率 = 0）。越高代表承受同樣下跌風險，換到越多報酬。</li>
        </ul>
      </details>
    </div>
    <div class="panel"><h3>大漲大跌頻率（每年平均次數）</h3><div class="chart short" id="chart-vol-bar"></div>
      <p class="how-to-read"><b>這張圖怎麼看：</b>向上的柱子是大漲次數、向下的是大跌次數，換算成「平均每年」以便比較不同長度的資料。</p></div>
    <div class="panel"><h3>水下曲線（距離歷史高點的跌幅）</h3><div class="chart" id="chart-vol-dd"></div>
      <p class="how-to-read"><b>這張圖怎麼看：</b>0% 代表創新高；越往下代表離高點越遠。曲線「泡在水下」越久，代表需要越久才能回本。</p></div>`;

  const bars = [];
  res.forEach((r, i) => {
    const yrs = r.days / r.perYear;
    bars.push({ type: "bar", name: r.symbol, x: ths.map((t) => `≥ ${t}%`), y: r.counts.map((x) => x.up / yrs), marker: { color: PALETTE[i % PALETTE.length] }, legendgroup: r.symbol, offsetgroup: r.symbol, hovertemplate: `${r.symbol} 漲 %{x}：%{y:.1f} 次／年<extra></extra>` });
    bars.push({ type: "bar", name: r.symbol, x: ths.map((t) => `≥ ${t}%`), y: r.counts.map((x) => -x.down / yrs), marker: { color: PALETTE[i % PALETTE.length], opacity: 0.55 }, legendgroup: r.symbol, offsetgroup: r.symbol, showlegend: false, hovertemplate: `${r.symbol} 跌 %{x}：%{customdata:.1f} 次／年<extra></extra>`, customdata: r.counts.map((x) => x.down / yrs) });
  });
  plot($("#chart-vol-bar"), bars, { barmode: "group", hovermode: "closest", yaxis: { title: { text: "次數／年（正 = 大漲，負 = 大跌）" } } });

  plot($("#chart-vol-dd"), res.map((r, i) => ({
    x: r.drawdown.dates, y: r.drawdown.values.map((v) => v * 100), name: r.symbol, mode: "lines",
    line: { color: PALETTE[i % PALETTE.length], width: 1.2 }, fill: res.length === 1 ? "tozeroy" : "none", hovertemplate: "%{y:.1f}%",
  })), { yaxis: { gridcolor: c.border, ticksuffix: "%" } });
}

// ============================================================
// 5. 看盤牆（TradingView）
// ============================================================
const DEFAULT_GROUPS = {
  "前20大市值美股(含TSM)": ["NASDAQ:QQQ", "NASDAQ:AAPL", "AMEX:PPA", "NASDAQ:MSFT", "NASDAQ:NVDA", "NASDAQ:GOOGL", "NASDAQ:AMZN", "NASDAQ:META", "NYSE:TSM", "NASDAQ:CRWD", "NASDAQ:MU", "NASDAQ:INTC", "NYSE:BRK.B", "NYSE:LLY", "NASDAQ:AVGO", "NYSE:JPM", "NYSE:XOM", "NYSE:V", "NYSE:MA", "NASDAQ:TSLA", "NASDAQ:KTOS"],
  "美股熱門科技": ["NASDAQ:NVDA", "NASDAQ:AAPL", "NASDAQ:MSFT", "NASDAQ:GOOGL", "NASDAQ:AMZN", "NASDAQ:META", "NASDAQ:TSLA", "NASDAQ:AMD", "NASDAQ:AVGO", "NYSE:TSM", "NASDAQ:NFLX"],
  "台股精選": ["TWSE:2330", "TWSE:2454", "TWSE:2317", "TWSE:2308", "TWSE:2881", "TWSE:2882", "TWSE:2891", "TWSE:2603", "TWSE:2886", "TWSE:2412"],
  "加密貨幣": ["BINANCE:BTCUSDT", "BINANCE:ETHUSDT", "BINANCE:SOLUSDT", "BINANCE:BNBUSDT", "BINANCE:XRPUSDT", "BINANCE:DOGEUSDT"],
};
const WALL_KEY = "tvGroups.v1";

const Wall = (() => {
  let groups, active = false, page = 0, timer = null, left = 0, paused = false, tvLoading = null;

  const store = {
    load() {
      try { const g = JSON.parse(localStorage.getItem(WALL_KEY)); if (g && Object.keys(g).length) return g; } catch { /* 無痕模式等 */ }
      return structuredClone(DEFAULT_GROUPS);
    },
    save() { try { localStorage.setItem(WALL_KEY, JSON.stringify(groups)); } catch { /* 忽略 */ } },
  };

  const loadTv = () => tvLoading ||= new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = "https://s3.tradingview.com/tv.js";
    s.onload = ok; s.onerror = () => { tvLoading = null; fail(new Error("TradingView 元件載入失敗")); };
    document.head.appendChild(s);
  });

  function fillGroupSelect(selectName) {
    const sel = $("#wall-group");
    sel.innerHTML = Object.keys(groups).map((g) => `<option>${esc(g)}</option>`).join("");
    if (selectName && groups[selectName]) sel.value = selectName;
    $("#wall-edit-name").value = sel.value;
    $("#wall-edit-list").value = (groups[sel.value] || []).join("\n");
  }

  function render() {
    const syms = groups[$("#wall-group").value] || [];
    const n = +$("#wall-grid").value, cells = n * n;
    const grid = $("#tv-grid");
    grid.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${n}, 1fr)`;
    grid.innerHTML = "";
    if (!syms.length) { grid.innerHTML = `<div style="color:#ccc;padding:20px">這個群組沒有標的</div>`; return; }
    const pages = Math.ceil(syms.length / cells);
    page %= pages;
    const batch = [];
    for (let i = 0; i < Math.min(cells, syms.length); i++) batch.push(syms[(page * cells + i) % syms.length]);
    batch.forEach((sym, i) => {
      const cell = document.createElement("div");
      cell.id = `tv_${i}`;
      grid.appendChild(cell);
      new window.TradingView.widget({
        autosize: true, symbol: sym, interval: $("#wall-tf").value, timezone: "Asia/Taipei",
        theme: "dark", style: "1", locale: "zh_TW", hide_top_toolbar: true, hide_side_toolbar: true,
        hide_volume: true, allow_symbol_change: false, save_image: false, container_id: cell.id,
      });
    });
    resetTimer(pages > 1);
  }

  function resetTimer(rotate) {
    clearInterval(timer); timer = null;
    const sec = +$("#wall-rotate").value;
    $("#wall-countdown").textContent = "";
    if (!rotate || !sec) return;
    left = sec;
    timer = setInterval(() => {
      if (paused) { $("#wall-countdown").textContent = "⏸ 已暫停"; return; }
      left--;
      $("#wall-countdown").textContent = `下一頁倒數 ${left} 秒`;
      if (left <= 0) { page++; render(); }
    }, 1000);
  }

  async function activate() {
    if (!groups) {
      groups = store.load();
      fillGroupSelect();
      bind();
    }
    active = true;
    try { await loadTv(); if (active) render(); }
    catch (e) { $("#tv-grid").innerHTML = `<div style="color:#ccc;padding:20px">${esc(e.message)}</div>`; }
  }
  function deactivate() {
    if (!active) return;
    active = false; clearInterval(timer); timer = null;
    $("#tv-grid").innerHTML = ""; // 離開分頁時釋放 iframe，省資源
  }

  function bind() {
    const rerender = () => { page = 0; active && window.TradingView && render(); };
    $("#wall-group").addEventListener("change", () => { fillGroupSelect($("#wall-group").value); rerender(); });
    ["#wall-grid", "#wall-tf", "#wall-rotate"].forEach((id) => $(id).addEventListener("change", rerender));
    $("#wall-next").addEventListener("click", () => { page++; render(); });
    $("#wall-full").addEventListener("click", () => $("#tv-grid").requestFullscreen?.());
    $("#tv-grid").addEventListener("mouseenter", () => { paused = true; });
    $("#tv-grid").addEventListener("mouseleave", () => { paused = false; });
    $("#wall-manage-btn").addEventListener("click", () => { $("#wall-manage").hidden = !$("#wall-manage").hidden; });
    $("#wall-save").addEventListener("click", () => {
      const oldName = $("#wall-group").value, name = $("#wall-edit-name").value.trim();
      if (!name) return alert("請輸入群組名稱");
      const list = $("#wall-edit-list").value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (!list.length) return alert("至少需要一個標的");
      if (name !== oldName) delete groups[oldName];
      groups[name] = list;
      store.save(); fillGroupSelect(name); rerender();
    });
    $("#wall-new").addEventListener("click", () => {
      const name = prompt("新群組名稱");
      if (!name || groups[name]) return;
      groups[name] = ["NASDAQ:AAPL"];
      store.save(); fillGroupSelect(name); rerender();
    });
    $("#wall-del").addEventListener("click", () => {
      const name = $("#wall-group").value;
      if (Object.keys(groups).length <= 1) return alert("至少保留一個群組");
      if (!confirm(`確定刪除「${name}」？`)) return;
      delete groups[name];
      store.save(); fillGroupSelect(); rerender();
    });
    $("#wall-export").addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(groups, null, 2)], { type: "application/json" }));
      a.download = "tradingview_groups.json"; a.click();
    });
    $("#wall-import").addEventListener("change", async (e) => {
      try {
        const g = JSON.parse(await e.target.files[0].text());
        if (typeof g !== "object" || !Object.values(g).every(Array.isArray)) throw new Error("格式應為 { \"群組名\": [\"代號\", ...] }");
        groups = g; store.save(); fillGroupSelect(); rerender();
      } catch (err) { alert("匯入失敗：" + err.message); }
      e.target.value = "";
    });
    $("#wall-reset").addEventListener("click", () => {
      if (!confirm("還原成預設群組？你自訂的群組會被覆蓋。")) return;
      groups = structuredClone(DEFAULT_GROUPS); store.save(); fillGroupSelect(); rerender();
    });
  }
  return { activate, deactivate };
})();

// ============================================================
// 網址參數（方便把設定好的回測分享給別人）
// ============================================================
function saveHash(tab, params) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null)).toString();
  history.replaceState(null, "", `#${tab}?${q}`);
}
function loadHash() {
  const [tab, q] = location.hash.slice(1).split("?");
  if (!tab || !$(`#tab-${tab}`)) return;
  showTab(tab);
  if (!q) return;
  const p = new URLSearchParams(q);
  const set = (id, k) => { if (p.has(k)) $(id).value = p.get(k); };
  if (tab === "dca") {
    if (p.get("t")) { state.pickers.dca = p.get("t").split(",").slice(0, 5); renderChips("dca"); }
    set("#dca-amount", "a"); set("#dca-start", "s"); set("#dca-end", "e"); set("#dca-months", "m"); set("#dca-count", "n"); set("#dca-yield", "y");
    updatePlanHint();
    $("#form-dca").requestSubmit();
  } else if (tab === "rolling") {
    if (p.get("t")) { state.pickers.rolling = [p.get("t")]; renderChips("rolling"); }
    set("#roll-from", "f"); set("#roll-horizon", "h"); set("#roll-months", "m"); set("#roll-count", "n"); set("#roll-yield", "y");
    $("#form-rolling").requestSubmit();
  }
}

// ============================================================
// 初始化
// ============================================================
function initEvents() {
  $$("select[data-event-for]").forEach((sel) => {
    sel.innerHTML = EVENTS.map(([d, t]) => `<option value="${d}">${t}</option>`).join("");
    const startInput = $(`#${sel.dataset.eventFor}-start`);
    sel.addEventListener("change", () => { if (sel.value) startInput.value = sel.value; });
    startInput.addEventListener("input", () => { sel.value = ""; });
  });
}

async function init() {
  $$('input[type="date"][id$="-end"]').forEach((i) => { i.max = today; });
  $("#dca-end").value = today;
  $("#alloc-end").value = today;
  initEvents();
  initPickers();
  addAllocRow("SPY", 60);
  addAllocRow("BND", 40);
  updatePlanHint();
  await loadManifest();
  loadHash();
  // 系統切換深淺色時重畫圖表
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    $$("section.tab.active form").forEach((f) => { if ($(".js-plotly-plot", f.parentElement)) f.requestSubmit(); });
  });
}
init();

