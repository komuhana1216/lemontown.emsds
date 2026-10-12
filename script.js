
/* ==================================================
   EMS COMMAND DASHBOARD
   GitHub Pages frontend
================================================== */

/*
  Google Apps ScriptのウェブアプリURLを設定する。
  例：https://script.google.com/macros/s/DEPLOYMENT_ID/exec

  URLが空の場合、ログイン・保存機能は利用できない。
*/
const API_URL = "";

/* ---------- 設定 ---------- */

const ITEMS = {
  bandage: {
    name: "包帯",
    limit: 30,
    selectId: "saleBandage",
    soldId: "bandageSold",
    progressId: "bandageProgress"
  },
  hemostatic: {
    name: "止血剤",
    limit: 20,
    selectId: "saleHemostatic",
    soldId: "hemostaticSold",
    progressId: "hemostaticProgress"
  },
  painkiller: {
    name: "痛み止め剤",
    limit: 20,
    selectId: "salePainkiller",
    soldId: "painkillerSold",
    progressId: "painkillerProgress"
  }
};

const RANKS = [
  "体験",
  "新人隊員",
  "救命士",
  "臨床医",
  "専門医",
  "医長",
  "診療部長",
  "救急司令補",
  "救急司令",
  "副院長",
  "院長"
];

const MANAGER_RANKS = ["副院長", "院長"];

let currentMember = null;
let salesCache = [];
let notesCache = [];
let currentPage = "dashboard";
let apiBusy = false;
let warningRequestId = 0;

/* ---------- DOMヘルパー ---------- */

const $ = (selector) => document.querySelector(selector);

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function formatDate(value) {
  if (!value) return "-";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function japanDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function setMessage(element, message, type = "") {
  if (!element) return;

  element.textContent = message;
  element.classList.toggle("success", type === "success");
  element.classList.toggle("error", type === "error");
}

function showGlobalMessage(message, type = "") {
  const element = $("#globalMessage");
  element.textContent = message;
  element.classList.remove("hidden", "error");

  if (type === "error") {
    element.classList.add("error");
  }

  element.scrollIntoView({
    behavior: "smooth",
    block: "nearest"
  });
}

function clearGlobalMessage() {
  $("#globalMessage").classList.add("hidden");
}

function setConnectionStatus(online, text) {
  $("#connectionStatus").textContent = text;
  $(".status-dot").classList.toggle("online", online);
}

/* ---------- API通信 ---------- */

/*
  Apps Script側で受け付けるリクエスト形式：

  {
    action: "login",
    memberId: "EMS-001"
  }

  ログイン後の各リクエストにはtokenを含める。
  tokenの発行・検証はサーバー側で実装する。
*/
async function apiRequest(action, payload = {}) {
  if (!API_URL) {
    throw new Error(
      "API_URLが未設定です。Google Apps ScriptのウェブアプリURLを設定してください。"
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },
      body: JSON.stringify({
        action,
        token: sessionStorage.getItem("emsSessionToken") || "",
        ...payload
      }),
      redirect: "follow",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`サーバー通信エラー (${response.status})`);
    }

    const result = await response.json();

    if (!result || result.ok !== true) {
      if (result?.code === "SESSION_EXPIRED") {
        logout(false);
      }

      throw new Error(
        result?.message || "リクエストを処理できませんでした。"
      );
    }

    return result.data ?? {};
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("通信がタイムアウトしました。");
    }

    if (
      error instanceof TypeError ||
      /Failed to fetch/i.test(error.message)
    ) {
      throw new Error(
        "サーバーに接続できません。Apps Scriptの公開設定や通信設定を確認してください。"
      );
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/* ---------- ログイン・ログアウト ---------- */

$("#loginForm").addEventListener("submit", async event => {
  event.preventDefault();

  if (apiBusy) return;

  const memberId = $("#loginId").value.trim();

  if (!memberId) {
    setMessage($("#loginMessage"), "隊員IDを入力してください。");
    return;
  }

  if (!API_URL) {
    setMessage(
      $("#loginMessage"),
      "まだ接続先が未設定です。Apps Scriptの設定後にログインできます。"
    );
    return;
  }

  const button = event.currentTarget.querySelector("button[type='submit']");
  button.disabled = true;
  button.textContent = "認証中...";
  setMessage($("#loginMessage"), "");

  try {
    const result = await apiRequest("login", { memberId });

    if (!result.token || !result.member) {
      throw new Error("認証サーバーの応答形式が正しくありません。");
    }

    sessionStorage.setItem("emsSessionToken", result.token);

    currentMember = normalizeMember(result.member);

    if (!currentMember.id || !currentMember.name || !currentMember.rank) {
      sessionStorage.removeItem("emsSessionToken");
      currentMember = null;
      throw new Error("隊員情報が不足しています。運営に確認してください。");
    }

    openApplication();
    await refreshDashboard();
  } catch (error) {
    setMessage($("#loginMessage"), error.message);
  } finally {
    button.disabled = false;
    button.innerHTML = 'ログイン <span>→</span>';
  }
});

function normalizeMember(member) {
  return {
    id: String(member.id ?? member.memberId ?? ""),
    name: String(member.name ?? ""),
    rank: String(member.rank ?? "")
  };
}

async function restoreSession() {
  const token = sessionStorage.getItem("emsSessionToken");

  if (!token || !API_URL) return;

  try {
    const result = await apiRequest("me");

    if (!result.member) {
      throw new Error("セッションが無効です。");
    }

    currentMember = normalizeMember(result.member);
    openApplication();
    await refreshDashboard();
  } catch {
    sessionStorage.removeItem("emsSessionToken");
    currentMember = null;
  }
}

function openApplication() {
  $("#loginScreen").classList.add("hidden");
  $("#appScreen").classList.remove("hidden");

  $("#profileName").textContent = currentMember.name;
  $("#profileRank").textContent = currentMember.rank;

  const canManageNotes = MANAGER_RANKS.includes(currentMember.rank);

  $("#notesNav").classList.toggle("hidden", !canManageNotes);
  $("#notesQuickAction").classList.toggle("hidden", !canManageNotes);

  setConnectionStatus(true, "ログイン中");
  updateDateDisplay();
  navigateTo("dashboard");
}

function logout(notify = true) {
  sessionStorage.removeItem("emsSessionToken");
  currentMember = null;
  salesCache = [];
  notesCache = [];

  $("#appScreen").classList.add("hidden");
  $("#loginScreen").classList.remove("hidden");
  $("#loginId").value = "";
  setMessage($("#loginMessage"), "");
  setConnectionStatus(false, "未ログイン");

  if (notify) {
    setMessage($("#loginMessage"), "ログアウトしました。", "success");
  }
}

$("#logoutButton").addEventListener("click", () => {
  logout(true);
});

/* ---------- ナビゲーション ---------- */

const PAGE_TITLES = {
  dashboard: "ダッシュボード",
  sales: "販売登録",
  history: "販売履歴",
  notes: "隊員活動メモ"
};

function navigateTo(page) {
  if (!PAGE_TITLES[page]) return;

  if (
    page === "notes" &&
    (!currentMember || !MANAGER_RANKS.includes(currentMember.rank))
  ) {
    showGlobalMessage("この機能を利用する権限がありません。", "error");
    return;
  }

  currentPage = page;
  clearGlobalMessage();

  document.querySelectorAll(".page").forEach(section => {
    section.classList.toggle(
      "hidden",
      section.id !== `page-${page}`
    );
  });

  document.querySelectorAll(".nav-item").forEach(button => {
    button.classList.toggle(
      "active",
      button.dataset.page === page
    );
  });

  $("#pageTitle").textContent = PAGE_TITLES[page];
  $("#sidebar").classList.remove("open");

  if (page === "history") loadSalesHistory();
  if (page === "notes") loadNotes();
}

document.querySelectorAll("[data-page]").forEach(button => {
  button.addEventListener("click", () => {
    navigateTo(button.dataset.page);
  });
});

document.querySelectorAll("[data-goto]").forEach(button => {
  button.addEventListener("click", () => {
    navigateTo(button.dataset.goto);
  });
});

$("#menuToggle").addEventListener("click", () => {
  $("#sidebar").classList.toggle("open");
});

/* ---------- 日付表示 ---------- */

function updateDateDisplay() {
  $("#todayDate").textContent = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short"
  }).format(new Date());
}

/* ---------- 販売数量プルダウン ---------- */

function setupQuantitySelects() {
  Object.values(ITEMS).forEach(item => {
    const select = document.getElementById(item.selectId);

    select.innerHTML = "";

    for (let quantity = 0; quantity <= item.limit; quantity += 5) {
      const option = document.createElement("option");
      option.value = String(quantity);
      option.textContent = `${quantity}個`;
      select.appendChild(option);
    }

    select.value = "0";
  });

  updateTotalQuantity();
}

function getSaleQuantities() {
  return {
    bandage: Number($("#saleBandage").value),
    hemostatic: Number($("#saleHemostatic").value),
    painkiller: Number($("#salePainkiller").value)
  };
}

function updateTotalQuantity() {
  const quantities = getSaleQuantities();
  const total = Object.values(quantities).reduce(
    (sum, quantity) => sum + quantity,
    0
  );

  $("#totalQuantity").textContent = String(total);
}

Object.values(ITEMS).forEach(item => {
  document.getElementById(item.selectId).addEventListener("change", () => {
    updateTotalQuantity();
    checkSaleLimit();
  });
});

$("#recipient").addEventListener("input", () => {
  checkSaleLimit();
});

$("#resetSalesButton").addEventListener("click", () => {
  setTimeout(() => {
    $("#limitWarning").classList.add("hidden");
    updateTotalQuantity();
  }, 0);
});

/* ---------- 販売上限の事前チェック ---------- */

/*
  checkSaleLimitは事前警告用。
  最終的な上限チェックは、登録処理時にも
  Apps Script側で必ず実施すること。
*/
async function checkSaleLimit() {
  const requestId = ++warningRequestId;
  const recipient = $("#recipient").value.trim();
  const quantities = getSaleQuantities();
  const warning = $("#limitWarning");

  warning.classList.add("hidden");
  warning.textContent = "";

  if (!recipient || !Object.values(quantities).some(q => q > 0)) {
    return;
  }

  if (!API_URL || !currentMember) return;

  try {
    const result = await apiRequest("checkSale", {
      recipient,
      quantities
    });

    if (requestId !== warningRequestId) return;

    const violations = Array.isArray(result.violations)
      ? result.violations
      : [];

    if (violations.length > 0) {
      warning.replaceChildren();

      const title = document.createElement("strong");
      title.textContent = "販売上限を超える可能性があります。";
      warning.appendChild(title);

      const list = document.createElement("ul");

      violations.forEach(violation => {
        const li = document.createElement("li");
        li.textContent =
          `${violation.itemName || violation.item}：` +
          `現在 ${Number(violation.current || 0)}個、` +
          `今回 ${Number(violation.requested || 0)}個、` +
          `上限 ${Number(violation.limit || 0)}個`;
        list.appendChild(li);
      });

      warning.appendChild(list);
      warning.classList.remove("hidden");
    }
  } catch (error) {
    // 事前チェックが失敗しても、登録時のサーバー検証は必須。
    console.warn("販売上限の事前確認に失敗:", error.message);
  }
}

/* ---------- 販売登録 ---------- */

$("#salesForm").addEventListener("submit", async event => {
  event.preventDefault();

  if (apiBusy) return;

  if (!currentMember) {
    showGlobalMessage("ログインしてください。", "error");
    return;
  }

  const recipient = $("#recipient").value.trim();
  const quantities = getSaleQuantities();
  const total = Object.values(quantities).reduce(
    (sum, quantity) => sum + quantity,
    0
  );

  if (!recipient) {
    showGlobalMessage("販売相手を入力してください。", "error");
    return;
  }

  if (total === 0) {
    showGlobalMessage("販売個数を1個以上選択してください。", "error");
    return;
  }

  if (
    Object.entries(quantities).some(([key, quantity]) => {
      const item = ITEMS[key];
      return !Number.isInteger(quantity) ||
        quantity < 0 ||
        quantity > item.limit ||
        quantity % 5 !== 0;
    })
  ) {
    showGlobalMessage("販売個数の指定が正しくありません。", "error");
    return;
  }

  const button = $("#submitSalesButton");
  button.disabled = true;
  button.textContent = "登録中...";
  apiBusy = true;

  try {
    const result = await apiRequest("createSale", {
      recipient,
      quantities
    });

    $("#salesForm").reset();
    updateTotalQuantity();
    $("#limitWarning").classList.add("hidden");

    showGlobalMessage(
      `販売記録を登録しました。（合計 ${total}個）`,
      "success"
    );

    await refreshDashboard();

    if (result.sale) {
      salesCache.unshift(result.sale);
    }

    if (currentPage === "history") {
      await loadSalesHistory();
    }

    navigateTo("dashboard");
  } catch (error) {
    showGlobalMessage(error.message, "error");

    if (/上限|超過|limit/i.test(error.message)) {
      await checkSaleLimit();
    }
  } finally {
    apiBusy = false;
    button.disabled = false;
    button.textContent = "販売を登録する →";
  }
});

/* ---------- ダッシュボード集計 ---------- */

function normalizeSale(sale) {
  return {
    id: String(sale.id ?? ""),
    timestamp: sale.timestamp ?? sale.dateTime ?? sale.createdAt ?? "",
    memberId: String(sale.memberId ?? ""),
    memberName: String(sale.memberName ?? ""),
    recipient: String(sale.recipient ?? ""),
    bandage: Number(sale.bandage ?? sale.quantities?.bandage ?? 0),
    hemostatic: Number(sale.hemostatic ?? sale.quantities?.hemostatic ?? 0),
    painkiller: Number(sale.painkiller ?? sale.quantities?.painkiller ?? 0)
  };
}

function isToday(sale) {
  if (!sale.timestamp) return false;
  return japanDateKey(new Date(sale.timestamp)) === japanDateKey();
}

function renderDashboard(data = {}) {
  const totals = data.totals || {};

  Object.entries(ITEMS).forEach(([key, item]) => {
    const sold = Number(totals[key] ?? 0);
    $(`#${item.soldId}`).textContent = String(sold);

    // 全隊員合計は上限を超えることがあるため、
    // 進捗バーのみ100%で止める。
    const percent = Math.min(100, sold / item.limit * 100);
    $(`#${item.progressId}`).style.width = `${percent}%`;
  });

  const recent = Array.isArray(data.recentSales)
    ? data.recentSales.map(normalizeSale)
    : [];

  renderRecentSales(recent);
}

function renderRecentSales(sales) {
  const container = $("#recentSales");

  if (!sales.length) {
    container.innerHTML =
      '<div class="empty-state">まだ販売記録がありません。</div>';
    return;
  }

  container.innerHTML = sales.slice(0, 5).map(sale => {
    const total = sale.bandage + sale.hemostatic + sale.painkiller;

    return `
      <div class="recent-item">
        <div class="recent-avatar">✚</div>
        <div class="recent-main">
          <strong>${escapeHTML(sale.recipient || "相手未登録")}</strong>
          <small>${escapeHTML(sale.memberName || sale.memberId || "隊員不明")} · ${escapeHTML(formatDate(sale.timestamp))}</small>
        </div>
        <div class="recent-quantity">
          <strong>${total}個</strong>
          <small>合計</small>
        </div>
      </div>
    `;
  }).join("");
}

async function refreshDashboard() {
  if (!currentMember) return;

  try {
    const result = await apiRequest("getDashboard");

    renderDashboard(result);
    setConnectionStatus(true, "サーバー接続中");
    updateDateDisplay();
  } catch (error) {
    setConnectionStatus(false, "通信エラー");
    showGlobalMessage(error.message, "error");
  }
}

$("#refreshButton").addEventListener("click", refreshDashboard);

/* ---------- 販売履歴 ---------- */

async function loadSalesHistory() {
  if (!currentMember) return;

  $("#historyTableBody").innerHTML =
    '<tr><td colspan="6" class="empty-state">読み込み中...</td></tr>';

  try {
    const result = await apiRequest("getSales");

    salesCache = Array.isArray(result.sales)
      ? result.sales.map(normalizeSale)
      : [];

    renderHistory();
  } catch (error) {
    $("#historyTableBody").innerHTML =
      `<tr><td colspan="6" class="empty-state">${escapeHTML(error.message)}</td></tr>`;
  }
}

function renderHistory() {
  const keyword = $("#historySearch").value.trim().toLowerCase();
  const period = $("#historyPeriod").value;
  const now = Date.now();

  let sales = [...salesCache];

  if (period === "today") {
    sales = sales.filter(isToday);
  } else if (period === "7" || period === "30") {
    const days = Number(period);
    const threshold = now - days * 24 * 60 * 60 * 1000;

    sales = sales.filter(sale => {
      const time = new Date(sale.timestamp).getTime();
      return Number.isFinite(time) && time >= threshold && time <= now;
    });
  }

  if (keyword) {
    sales = sales.filter(sale => [
      sale.recipient,
      sale.memberName,
      sale.memberId
    ].some(value => value.toLowerCase().includes(keyword)));
  }

  sales.sort((a, b) =>
    new Date(b.timestamp).getTime() -
    new Date(a.timestamp).getTime()
  );

  const tbody = $("#historyTableBody");

  if (!sales.length) {
    tbody.innerHTML =
      '<tr><td colspan="6" class="empty-state">該当する販売記録がありません。</td></tr>';
  } else {
    tbody.innerHTML = sales.map(sale => `
      <tr>
        <td>${escapeHTML(formatDate(sale.timestamp))}</td>
        <td>${escapeHTML(sale.memberName || sale.memberId || "-")}</td>
        <td>${escapeHTML(sale.recipient || "-")}</td>
        <td>${sale.bandage}</td>
        <td>${sale.hemostatic}</td>
        <td>${sale.painkiller}</td>
      </tr>
    `).join("");
  }

  $("#historyCount").textContent = `${sales.length}件`;
}

$("#historySearch").addEventListener("input", renderHistory);
$("#historyPeriod").addEventListener("change", renderHistory);
$("#historyRefreshButton").addEventListener("click", loadSalesHistory);

/* ---------- 活動メモ ---------- */

function ensureManager() {
  if (!currentMember || !MANAGER_RANKS.includes(currentMember.rank)) {
    throw new Error("副院長・院長のみ利用できます。");
  }
}

async function loadNotes() {
  try {
    ensureManager();

    $("#notesList").innerHTML =
      '<div class="empty-state">読み込み中...</div>';

    const result = await apiRequest("getNotes");

    notesCache = Array.isArray(result.notes)
      ? result.notes.map(note => ({
          id: String(note.id ?? ""),
          memberId: String(note.memberId ?? ""),
          memberName: String(note.memberName ?? ""),
          content: String(note.content ?? ""),
          authorName: String(note.authorName ?? ""),
          createdAt: note.createdAt ?? "",
          updatedAt: note.updatedAt ?? ""
        }))
      : [];

    renderNotes();
  } catch (error) {
    $("#notesList").innerHTML =
      `<div class="empty-state">${escapeHTML(error.message)}</div>`;
  }
}

function renderNotes() {
  const container = $("#notesList");

  if (!notesCache.length) {
    container.innerHTML =
      '<div class="empty-state">活動メモはまだありません。</div>';
    return;
  }

  container.innerHTML = notesCache.map(note => `
    <article class="note-card">
      <div class="note-card-head">
        <div>
          <h4>${escapeHTML(note.memberName || note.memberId)}</h4>
          <time>${escapeHTML(formatDate(note.updatedAt || note.createdAt))}</time>
        </div>
      </div>
      <p class="note-content">${escapeHTML(note.content)}</p>
      <div class="muted">記録者：${escapeHTML(note.authorName || "-")}</div>
      <div class="note-actions">
        <button type="button" data-edit-note="${escapeHTML(note.id)}">編集</button>
        <button type="button" class="delete-note" data-delete-note="${escapeHTML(note.id)}">削除</button>
      </div>
    </article>
  `).join("");
}

$("#notesList").addEventListener("click", async event => {
  const editButton = event.target.closest("[data-edit-note]");
  const deleteButton = event.target.closest("[data-delete-note]");

  if (editButton) {
    try {
      ensureManager();

      const note = notesCache.find(
        item => item.id === editButton.dataset.editNote
      );

      if (!note) return;

      $("#noteId").value = note.id;
      $("#noteMemberId").value = note.memberId;
      $("#noteContent").value = note.content;
      $("#noteFormTitle").textContent = "活動メモを編集";

      $("#noteForm").scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    } catch (error) {
      showGlobalMessage(error.message, "error");
    }
  }

  if (deleteButton) {
    try {
      ensureManager();

      const noteId = deleteButton.dataset.deleteNote;

      if (!confirm("この活動メモを削除しますか？")) return;

      await apiRequest("deleteNote", { noteId });
      showGlobalMessage("活動メモを削除しました。", "success");
      await loadNotes();
    } catch (error) {
      showGlobalMessage(error.message, "error");
    }
  }
});

$("#noteForm").addEventListener("submit", async event => {
  event.preventDefault();

  try {
    ensureManager();

    const memberId = $("#noteMemberId").value.trim();
    const content = $("#noteContent").value.trim();
    const noteId = $("#noteId").value.trim();

    if (!memberId || !content) {
      throw new Error("対象隊員IDと活動メモを入力してください。");
    }

    const result = await apiRequest("saveNote", {
      noteId,
      memberId,
      content
    });

    $("#noteForm").reset();
    $("#noteId").value = "";
    $("#noteFormTitle").textContent = "活動メモを作成";

    showGlobalMessage(
      result.updated ? "活動メモを更新しました。" : "活動メモを保存しました。",
      "success"
    );

    await loadNotes();
  } catch (error) {
    showGlobalMessage(error.message, "error");
  }
});

$("#resetNoteButton").addEventListener("click", () => {
  setTimeout(() => {
    $("#noteId").value = "";
    $("#noteFormTitle").textContent = "活動メモを作成";
  }, 0);
});

$("#notesRefreshButton").addEventListener("click", loadNotes);

/* ---------- 起動処理 ---------- */

setupQuantitySelects();
updateDateDisplay();
setConnectionStatus(false, "接続待機中");

if (!API_URL) {
  setMessage(
    $("#loginMessage"),
    "接続先の設定待ちです。Apps Scriptを公開後、script.jsのAPI_URLを設定してください。"
  );
} else {
  restoreSession();
}

/*
  日付表示は定期更新する。
  日次集計の判定はクライアントのタイマーではなく、
  Apps Script側で日本時間を基準に行う。
*/
let displayedDateKey = japanDateKey();

setInterval(() => {
  const nextKey = japanDateKey();

  updateDateDisplay();

  if (nextKey !== displayedDateKey) {
    displayedDateKey = nextKey;

    if (currentMember) {
      refreshDashboard();

      if (currentPage === "history") {
        loadSalesHistory();
      }
    }
  }
}, 30000);
