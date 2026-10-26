// ============================================================
// admin.js — 用密碼在網站上編輯「標的清單」(scripts/tickers.json)
//
// 為什麼這樣設計？
//   GitHub Pages 是靜態網站，沒有後端可以存資料，也沒辦法安全地在網頁裡藏密碼。
//   所以「存檔」= 直接用 GitHub API 修改 repo 裡的 scripts/tickers.json，
//   push 之後 GitHub Actions 會自動抓新標的的價格並重新部署。
//
//   修改 repo 需要 GitHub Token。Token 不能明文放在公開網站上，
//   因此用「你的密碼」把 Token 加密後才存進 repo（config/admin-key.json）：
//
//     初次設定： Token ──(用密碼加密 AES-GCM)──▶ config/admin-key.json（公開但看不懂）
//     之後編輯： 輸入密碼 ──解密──▶ Token（只放在記憶體）──▶ GitHub API 存檔
//
//   密碼本身不會存在任何地方。
// ============================================================

export const REPO = { owner: "ZLO-25", repo: "Lump-Sum-v.s.-DCA", branch: "main" };
const KEY_PATH = "config/admin-key.json";
const TICKERS_PATH = "scripts/tickers.json";
const ITERATIONS = 600000; // PBKDF2 次數：越高越難暴力猜密碼

// ---------- 加解密（瀏覽器與 Node.js 都有 crypto.subtle） ----------
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(secret, password, iterations = ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iterations);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(secret));
  return { v: 1, kdf: "PBKDF2-SHA256", iterations, salt: b64(salt), iv: b64(iv), ciphertext: b64(ct) };
}

/** 密碼錯誤時 AES-GCM 驗證會失敗 → 回傳 null */
export async function decryptSecret(blob, password) {
  try {
    const key = await deriveKey(password, unb64(blob.salt), blob.iterations);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(blob.iv) }, key, unb64(blob.ciphertext));
    return dec.decode(pt);
  } catch { return null; }
}

// ---------- GitHub API ----------
const utf8ToB64 = (s) => b64(enc.encode(s));
const b64ToUtf8 = (s) => dec.decode(unb64(s.replace(/\n/g, "")));

async function gh(token, path, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}${path}`, {
    ...opts,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const msg = res.status === 401 ? "Token 無效或已過期"
      : res.status === 403 ? "Token 沒有寫入這個 repo 的權限（需要 Contents: Read and write）"
      : res.status === 404 ? "找不到 repo 或檔案（Token 可能沒有被授權存取這個 repo）"
      : res.status === 409 ? "檔案剛被別人改過，請重新解鎖後再存"
      : `GitHub API 錯誤 ${res.status}`;
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return res.status === 204 ? null : res.json();
}

async function readFile(token, path) {
  const j = await gh(token, `/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${REPO.branch}`);
  return { text: b64ToUtf8(j.content), sha: j.sha };
}

async function writeFile(token, path, text, sha, message) {
  return gh(token, `/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({ message, content: utf8ToB64(text), branch: REPO.branch, ...(sha ? { sha } : {}) }),
  });
}

// ---------- 清單驗證 ----------
const SYMBOL_RE = /^[\^A-Z0-9][A-Z0-9.\-=^]{0,19}$/;
export function normalizeSymbol(s) { return s.trim().toUpperCase(); }
export function validateConfig(cfg) {
  const seen = new Set();
  for (const g of cfg.groups) {
    if (!g.name.trim()) throw new Error("群組名稱不能空白");
    for (const t of g.tickers) {
      if (!SYMBOL_RE.test(t.symbol)) throw new Error(`代號格式不正確：「${t.symbol}」`);
      if (seen.has(t.symbol)) throw new Error(`代號重複：${t.symbol}`);
      seen.add(t.symbol);
    }
  }
  if (!seen.size) throw new Error("清單至少要有一個標的");
}

// ============================================================
// 編輯器畫面（只在瀏覽器執行）
// ============================================================
if (typeof document !== "undefined") {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const dlg = $("#admin-dialog");
  const body = $("#admin-body");
  let token = null;      // 解密後的 Token，只存在記憶體，關掉分頁就消失
  let cfg = null, cfgSha = null;
  let keyBlob = undefined;

  const loadKeyBlob = async () => {
    if (keyBlob !== undefined) return keyBlob;
    try {
      const r = await fetch(KEY_PATH, { cache: "no-cache" });
      keyBlob = r.ok ? await r.json() : null;
    } catch { keyBlob = null; }
    return keyBlob;
  };

  const msg = (text, kind = "") => { const m = $("#admin-msg"); if (m) { m.className = `notice ${kind}`; m.hidden = !text; m.innerHTML = text; } };
  const busy = (btn, on, label) => { btn.disabled = on; if (label) btn.textContent = label; };

  async function open() {
    dlg.showModal();
    if (token && cfg) return renderEditor();
    const blob = await loadKeyBlob();
    blob ? renderUnlock() : renderSetup();
  }

  function renderUnlock() {
    body.innerHTML = `
      <h2>🔒 輸入密碼</h2>
      <p class="hint">輸入管理密碼後才能編輯標的清單。</p>
      <form id="admin-unlock" novalidate>
        <div class="field"><label for="admin-pw">密碼</label><input type="password" id="admin-pw" autocomplete="current-password" required></div>
        <div id="admin-msg" class="notice" hidden></div>
        <button class="primary" type="submit">解鎖</button>
      </form>
      <details class="explain"><summary>忘記密碼或 Token 過期？</summary>
        <p class="hint">刪除 repo 裡的 <code>${KEY_PATH}</code> 後重新整理，就能重新做初次設定。</p></details>`;
    $("#admin-pw").focus();
    $("#admin-unlock").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("button[type=submit]", e.target);
      busy(btn, true, "解密中…");
      const t = await decryptSecret(keyBlob, $("#admin-pw").value);
      if (!t) { msg("密碼錯誤", "error"); busy(btn, false, "解鎖"); return; }
      try {
        token = t;
        const f = await readFile(token, TICKERS_PATH);
        cfg = JSON.parse(f.text); cfgSha = f.sha;
        renderEditor();
      } catch (err) {
        token = null;
        msg(`密碼正確，但無法讀取清單：${esc(err.message)}。Token 可能已過期，可依「忘記密碼或 Token 過期」重新設定。`, "error");
        busy(btn, false, "解鎖");
      }
    });
  }

  function renderSetup() {
    body.innerHTML = `
      <h2>🛠️ 初次設定（只需要做一次）</h2>
      <p>網站是公開的靜態網頁，沒有伺服器可以保存資料，所以存檔時會直接更新 GitHub 上的清單檔。這需要一把只能改這個 repo 的 GitHub Token：</p>
      <ol class="hint" style="font-size:.88rem">
        <li>打開 <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → 建立 Fine-grained token</a></li>
        <li>Repository access 選 <b>Only select repositories</b> → <code>${REPO.repo}</code></li>
        <li>Permissions → Repository permissions → <b>Contents：Read and write</b>（其他都不用開）</li>
        <li>Expiration 建議設 1 年，到期後回來這裡重新設定即可</li>
      </ol>
      <form id="admin-setup" novalidate>
        <div class="field"><label for="admin-token">GitHub Token</label><input type="password" id="admin-token" placeholder="github_pat_…" autocomplete="off"></div>
        <div class="row2">
          <div class="field"><label for="admin-pw1">設定管理密碼</label><input type="password" id="admin-pw1" autocomplete="new-password"></div>
          <div class="field"><label for="admin-pw2">再輸入一次</label><input type="password" id="admin-pw2" autocomplete="new-password"></div>
        </div>
        <p class="hint">Token 會用這個密碼加密後存進 repo，密碼本身不會存在任何地方。密碼越長越安全（建議 12 個字元以上）。</p>
        <div id="admin-msg" class="notice" hidden></div>
        <button class="primary" type="submit">加密並儲存設定</button>
      </form>`;
    $("#admin-setup").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("button[type=submit]", e.target);
      const tok = $("#admin-token").value.trim(), p1 = $("#admin-pw1").value, p2 = $("#admin-pw2").value;
      if (!tok) return msg("請貼上 Token", "error");
      if (p1.length < 6) return msg("密碼至少 6 個字元", "error");
      if (p1 !== p2) return msg("兩次輸入的密碼不一樣", "error");
      busy(btn, true, "檢查 Token…");
      try {
        const f = await readFile(tok, TICKERS_PATH); // 順便確認 Token 有權限
        busy(btn, true, "加密並寫入 repo…");
        const blob = await encryptSecret(tok, p1);
        let sha;
        try { sha = (await readFile(tok, KEY_PATH)).sha; } catch { /* 第一次設定沒有舊檔 */ }
        await writeFile(tok, KEY_PATH, JSON.stringify(blob, null, 2) + "\n", sha, "設定網站管理金鑰（已加密的 GitHub Token）");
        token = tok; keyBlob = blob; cfg = JSON.parse(f.text); cfgSha = f.sha;
        renderEditor("✅ 設定完成。之後在任何電腦打開網站，輸入密碼就能編輯。");
      } catch (err) {
        msg(esc(err.message), "error");
        busy(btn, false, "加密並儲存設定");
      }
    });
  }

  /** 每個標的目前在網站上的狀態 */
  function dataStatus(sym) {
    const m = window.__tickerMeta?.get(sym);
    return m && m.file ? `<span class="pos" title="資料 ${esc(m.start)} ~ ${esc(m.end)}">✓ 有資料</span>` : `<span class="hint" style="display:inline" title="存檔後 GitHub Actions 會嘗試下載；抓不到就不會出現在網站上">⏳ 待下載</span>`;
  }

  function renderEditor(flash = "") {
    body.innerHTML = `
      <h2>✏️ 編輯標的清單</h2>
      <p class="hint">代號請用 <a href="https://finance.yahoo.com/" target="_blank" rel="noopener">Yahoo Finance</a> 的寫法：台股 <code>0050.TW</code>、上櫃 <code>6488.TWO</code>、港股 <code>0005.HK</code>、美股 <code>AAPL</code>、指數 <code>^GSPC</code>。存檔後約 2 分鐘網站更新。</p>
      <div id="admin-msg" class="notice" hidden></div>
      <div id="admin-groups">${cfg.groups.map((g, gi) => `
        <fieldset class="admin-group" data-gi="${gi}">
          <legend><input type="text" class="g-name" value="${esc(g.name)}" aria-label="群組名稱"></legend>
          <div class="table-wrap"><table class="data admin-table"><thead><tr><th>代號</th><th>名稱</th><th>備註</th><th>狀態</th><th></th></tr></thead><tbody>
          ${g.tickers.map((t, ti) => `<tr data-ti="${ti}">
            <td><input type="text" class="t-sym" value="${esc(t.symbol)}" aria-label="代號"></td>
            <td><input type="text" class="t-name" value="${esc(t.name)}" aria-label="名稱"></td>
            <td><input type="text" class="t-note" value="${esc(t.note)}" aria-label="備註" placeholder="（選填）"></td>
            <td>${dataStatus(t.symbol)}</td>
            <td><button type="button" class="icon-btn t-del" aria-label="刪除 ${esc(t.symbol)}">✕</button></td></tr>`).join("")}
          </tbody></table></div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
            <button type="button" class="secondary small g-add">＋ 新增標的</button>
            <button type="button" class="secondary small g-del">🗑️ 刪除整個群組</button>
          </div>
        </fieldset>`).join("")}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
        <button type="button" class="secondary small" id="admin-add-group">＋ 新增群組</button>
        <span style="flex:1"></span>
        <button type="button" class="secondary small" id="admin-lock">🔒 鎖定</button>
        <button type="button" class="primary" id="admin-save" style="width:auto">💾 儲存並重新部署</button>
      </div>`;
    if (flash) msg(flash);

    const collect = () => {
      // 把畫面上的輸入框讀回 cfg（不經驗證，給新增 / 刪除用）
      body.querySelectorAll(".admin-group").forEach((fs) => {
        const g = cfg.groups[+fs.dataset.gi];
        g.name = $(".g-name", fs).value.trim();
        g.tickers = [...fs.querySelectorAll("tbody tr")].map((tr) => {
          const t = { symbol: normalizeSymbol($(".t-sym", tr).value), name: $(".t-name", tr).value.trim() };
          const note = $(".t-note", tr).value.trim();
          if (note) t.note = note;
          return t;
        });
      });
    };
    body.querySelectorAll(".admin-group").forEach((fs) => {
      const gi = +fs.dataset.gi;
      $(".g-add", fs).addEventListener("click", () => {
        collect(); cfg.groups[gi].tickers.push({ symbol: "", name: "" }); renderEditor();
        const rows = body.querySelectorAll(`.admin-group[data-gi="${gi}"] .t-sym`); rows[rows.length - 1].focus();
      });
      $(".g-del", fs).addEventListener("click", () => {
        if (!confirm(`刪除整個「${cfg.groups[gi].name}」群組？（存檔後才生效）`)) return;
        collect(); cfg.groups.splice(gi, 1); renderEditor();
      });
      fs.querySelectorAll(".t-del").forEach((b) => b.addEventListener("click", () => {
        collect(); cfg.groups[gi].tickers.splice(+b.closest("tr").dataset.ti, 1); renderEditor();
      }));
    });
    $("#admin-add-group").addEventListener("click", () => {
      collect(); cfg.groups.push({ name: "新群組", tickers: [{ symbol: "", name: "" }] }); renderEditor();
    });
    $("#admin-lock").addEventListener("click", () => { token = null; cfg = null; dlg.close(); });
    $("#admin-save").addEventListener("click", async (e) => {
      const btn = e.target;
      collect();
      cfg.groups.forEach((g) => { g.tickers = g.tickers.filter((t) => t.symbol); });
      cfg.groups = cfg.groups.filter((g) => g.tickers.length);
      try { validateConfig(cfg); } catch (err) { return msg(esc(err.message), "error"); }
      busy(btn, true, "儲存中…");
      try {
        const res = await writeFile(token, TICKERS_PATH, JSON.stringify(cfg, null, 2) + "\n", cfgSha, "從網站更新標的清單");
        cfgSha = res.content.sha;
        renderEditor(`✅ 已儲存到 GitHub。網站約 2 分鐘後更新（可到 <a href="https://github.com/${REPO.owner}/${REPO.repo}/actions" target="_blank" rel="noopener">Actions</a> 看進度），完成後重新整理頁面即可在下拉選單看到新標的。`);
      } catch (err) {
        msg(esc(err.message), "error");
        busy(btn, false, "💾 儲存並重新部署");
      }
    });
  }

  $("#admin-open").addEventListener("click", open);
  $("#admin-close").addEventListener("click", () => dlg.close());
}
