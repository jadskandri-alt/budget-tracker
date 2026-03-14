// ─── État global ────────────────────────────────────────────────────────────────
let dashMonth = currentYearMonth();
let barChart = null;
let doughnutChart = null;

// ─── Utilitaires ────────────────────────────────────────────────────────────────
function currentYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function formatMonth(ym) {
  const [year, month] = ym.split('-');
  const d = new Date(year, month - 1);
  return d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
}

function fmt(n) {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(n);
}

function fmtDate(s) {
  if (!s) return '';
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ─── Navigation ─────────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const page = item.dataset.page;
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    item.classList.add('active');
    document.getElementById(`page-${page}`).classList.add('active');

    if (page === 'dashboard')    loadDashboard();
    if (page === 'transactions') loadTransactions();
    if (page === 'budgets')      loadBudgets();
    if (page === 'categories')   loadCategories();
    if (page === 'recurring')    loadRecurring();
    if (page === 'telegram')     loadTelegramPage();
  });
});

// ─── DASHBOARD ──────────────────────────────────────────────────────────────────
document.getElementById('dash-prev').addEventListener('click', () => {
  const [y, m] = dashMonth.split('-').map(Number);
  const d = new Date(y, m - 2);
  dashMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  loadDashboard();
});

document.getElementById('dash-next').addEventListener('click', () => {
  const [y, m] = dashMonth.split('-').map(Number);
  const d = new Date(y, m);
  dashMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  loadDashboard();
});

async function loadDashboard() {
  const summary = await window.api.getSummary(dashMonth);

  document.getElementById('dash-month-label').textContent = formatMonth(dashMonth);
  document.getElementById('dash-period').textContent = `Bilan de ${formatMonth(dashMonth)}`;

  document.getElementById('stat-income').textContent  = fmt(summary.income);
  document.getElementById('stat-expense').textContent = fmt(summary.expense);
  const bal = document.getElementById('stat-balance');
  bal.textContent = fmt(summary.balance);
  bal.style.color = summary.balance >= 0 ? 'var(--income)' : 'var(--expense)';

  // Bar chart
  const barCtx = document.getElementById('chart-bar').getContext('2d');
  if (barChart) barChart.destroy();
  barChart = new Chart(barCtx, {
    type: 'bar',
    data: {
      labels: summary.last6months.map(m => m.label),
      datasets: [
        { label: 'Revenus',  data: summary.last6months.map(m => m.income),  backgroundColor: '#10b98133', borderColor: '#10b981', borderWidth: 2, borderRadius: 4 },
        { label: 'Dépenses', data: summary.last6months.map(m => m.expense), backgroundColor: '#ef444433', borderColor: '#ef4444', borderWidth: 2, borderRadius: 4 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } },
      scales: { y: { beginAtZero: true, ticks: { callback: v => fmt(v) } } }
    }
  });

  // Doughnut chart
  const doCtx = document.getElementById('chart-doughnut').getContext('2d');
  if (doughnutChart) doughnutChart.destroy();

  const COLORS = ['#6366f1','#f59e0b','#ef4444','#10b981','#3b82f6','#8b5cf6','#ec4899','#14b8a6'];
  if (summary.byCategory.length > 0) {
    doughnutChart = new Chart(doCtx, {
      type: 'doughnut',
      data: {
        labels: summary.byCategory.map(c => c.category),
        datasets: [{ data: summary.byCategory.map(c => c.total), backgroundColor: COLORS, borderWidth: 0 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } },
          tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${fmt(ctx.raw)}` } }
        },
        cutout: '60%'
      }
    });
  }

  // Dernières transactions
  const txs = await window.api.getTransactions({ month: dashMonth });
  const tbody = document.getElementById('dash-tbody');
  tbody.innerHTML = txs.slice(0, 8).map(t => `
    <tr>
      <td>${fmtDate(t.date)}</td>
      <td>${t.category}</td>
      <td style="color:var(--muted)">${t.description || '—'}</td>
      <td><span class="badge badge-${t.type}">${t.type === 'income' ? 'Revenu' : 'Dépense'}</span></td>
      <td class="amount-${t.type}">${t.type === 'income' ? '+' : '−'}${fmt(t.amount)}</td>
    </tr>
  `).join('');
  if (txs.length === 0) tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:20px">Aucune transaction ce mois-ci</td></tr>';
}

// ─── TRANSACTIONS ────────────────────────────────────────────────────────────────
document.getElementById('btn-show-add-form').addEventListener('click', () => {
  document.getElementById('add-form-card').style.display = 'flex';
  document.getElementById('add-form-card').style.flexDirection = 'column';
  document.getElementById('tx-date').value = new Date().toISOString().slice(0, 10);
});

document.getElementById('btn-cancel-tx').addEventListener('click', () => {
  document.getElementById('add-form-card').style.display = 'none';
  clearTxForm();
});

document.getElementById('btn-save-tx').addEventListener('click', async () => {
  const amount = parseFloat(document.getElementById('tx-amount').value);
  const type = document.querySelector('input[name=tx-type]:checked').value;
  const category = document.getElementById('tx-category').value;
  const date = document.getElementById('tx-date').value;
  const description = document.getElementById('tx-desc').value;

  if (!amount || amount <= 0) return toast('Montant invalide', 'error');
  if (!category) return toast('Sélectionne une catégorie', 'error');
  if (!date) return toast('Date requise', 'error');

  await window.api.addTransaction({ amount, type, category, description, date });

  if (document.getElementById('tx-recurring').checked) {
    const day_of_month = new Date(date).getUTCDate();
    await window.api.addRecurring({ amount, type, category, description, day_of_month });
    toast('Transaction ajoutée et programmée chaque mois !');
  } else {
    toast('Transaction ajoutée !');
  }

  document.getElementById('add-form-card').style.display = 'none';
  clearTxForm();
  loadTransactions();
});

function clearTxForm() {
  document.getElementById('tx-amount').value = '';
  document.getElementById('tx-desc').value = '';
  document.getElementById('tx-date').value = '';
  document.getElementById('tx-income').checked = true;
  document.getElementById('tx-recurring').checked = false;
}

document.getElementById('filter-type').addEventListener('change', loadTransactions);
document.getElementById('filter-cat').addEventListener('change', loadTransactions);
document.getElementById('filter-month').addEventListener('change', loadTransactions);
document.getElementById('filter-search').addEventListener('input', loadTransactions);
document.getElementById('btn-clear-filters').addEventListener('click', () => {
  document.getElementById('filter-type').value = '';
  document.getElementById('filter-cat').value = '';
  document.getElementById('filter-month').value = '';
  document.getElementById('filter-search').value = '';
  loadTransactions();
});

async function loadTransactions() {
  const type     = document.getElementById('filter-type').value;
  const category = document.getElementById('filter-cat').value;
  const month    = document.getElementById('filter-month').value;
  const search   = document.getElementById('filter-search').value.trim();

  const categories = await window.api.getCategories();
  const txTypeSel = document.querySelector('input[name=tx-type]:checked')?.value || 'expense';
  populateCategorySelects(categories, txTypeSel);

  const txs = await window.api.getTransactions({ type: type || undefined, category: category || undefined, month: month || undefined, search: search || undefined });

  const allCats = await window.api.getCategories();
  const tbody = document.getElementById('tx-tbody');
  tbody.innerHTML = txs.map(t => {
    const opts = allCats.map(c =>
      `<option value="${c.name}" ${c.name === t.category ? 'selected' : ''}>${c.name}</option>`
    ).join('');
    return `
    <tr>
      <td>${fmtDate(t.date)}</td>
      <td><span class="badge badge-${t.type}">${t.type === 'income' ? 'Revenu' : 'Dépense'}</span></td>
      <td>
        <select onchange="updateTxCat(${t.id}, this.value)" style="border:1px solid var(--border);border-radius:6px;padding:3px 6px;font-size:12px;background:var(--bg);">
          ${opts}
        </select>
      </td>
      <td style="color:var(--muted)">${t.description || '—'}</td>
      <td class="amount-${t.type}">${t.type === 'income' ? '+' : '−'}${fmt(t.amount)}</td>
      <td>
        <button class="btn btn-outline btn-sm" onclick="openEditModal(${t.id})" title="Modifier">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
      </td>
      <td>
        <button class="btn btn-outline btn-sm" onclick="deleteTx(${t.id})">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
        </button>
      </td>
    </tr>
  `;
  }).join('');

  const empty = document.getElementById('tx-empty');
  empty.style.display = txs.length === 0 ? 'block' : 'none';
}

window.deleteTx = async function(id) {
  await window.api.deleteTransaction(id);
  toast('Transaction supprimée');
  loadTransactions();
};

window.updateTxCat = async function(id, category) {
  await window.api.updateTransaction({ id, category });
  toast('Catégorie mise à jour');
};

// ─── MODAL ÉDITION ───────────────────────────────────────────────────────────
let _editId = null;

window.openEditModal = async function(id) {
  _editId = id;
  const txs = await window.api.getTransactions({});
  const t = txs.find(x => x.id === id);
  if (!t) return;

  const cats = await window.api.getCategories();
  document.getElementById('edit-amount').value = t.amount;
  document.getElementById('edit-date').value = t.date;
  document.getElementById('edit-desc').value = t.description || '';
  document.querySelector(`input[name=edit-type][value=${t.type}]`).checked = true;

  const editCatSel = document.getElementById('edit-category');
  editCatSel.innerHTML = cats.map(c =>
    `<option value="${c.name}" ${c.name === t.category ? 'selected' : ''}>${c.name}</option>`
  ).join('');

  const overlay = document.getElementById('edit-modal-overlay');
  overlay.style.display = 'flex';
};

document.getElementById('btn-edit-cancel').addEventListener('click', () => {
  document.getElementById('edit-modal-overlay').style.display = 'none';
  _editId = null;
});

document.getElementById('edit-modal-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.style.display = 'none';
    _editId = null;
  }
});

document.getElementById('btn-edit-save').addEventListener('click', async () => {
  if (!_editId) return;
  const amount = parseFloat(document.getElementById('edit-amount').value);
  const type = document.querySelector('input[name=edit-type]:checked').value;
  const category = document.getElementById('edit-category').value;
  const date = document.getElementById('edit-date').value;
  const description = document.getElementById('edit-desc').value;

  if (!amount || amount <= 0) return toast('Montant invalide', 'error');
  if (!date) return toast('Date requise', 'error');

  await window.api.updateTransaction({ id: _editId, amount, type, category, date, description });
  toast('Transaction modifiée');
  document.getElementById('edit-modal-overlay').style.display = 'none';
  _editId = null;
  loadTransactions();
});

// Sync category filter quand type change
document.querySelectorAll('input[name=tx-type]').forEach(radio => {
  radio.addEventListener('change', async () => {
    const categories = await window.api.getCategories();
    populateCategorySelects(categories, radio.value);
  });
});

function populateCategorySelects(categories, txType = 'expense') {
  const txSel = document.getElementById('tx-category');
  const filtered = categories.filter(c => c.type === txType || c.type === 'both');
  txSel.innerHTML = filtered.map(c => `<option value="${c.name}">${c.name}</option>`).join('');

  const filterSel = document.getElementById('filter-cat');
  const current = filterSel.value;
  filterSel.innerHTML = '<option value="">Toutes catégories</option>' +
    categories.map(c => `<option value="${c.name}" ${c.name === current ? 'selected' : ''}>${c.name}</option>`).join('');
}

// ─── BUDGETS ─────────────────────────────────────────────────────────────────────
document.getElementById('btn-save-budget').addEventListener('click', async () => {
  const category    = document.getElementById('budget-cat').value;
  const limit_amount = parseFloat(document.getElementById('budget-limit').value);
  if (!category) return toast('Sélectionne une catégorie', 'error');
  if (!limit_amount || limit_amount <= 0) return toast('Montant invalide', 'error');
  await window.api.setBudget({ category, limit_amount });
  toast('Budget enregistré !');
  document.getElementById('budget-limit').value = '';
  loadBudgets();
});

async function loadBudgets() {
  const categories = await window.api.getCategories();
  const expCats = categories.filter(c => c.type === 'expense' || c.type === 'both');
  const budgetCatSel = document.getElementById('budget-cat');
  budgetCatSel.innerHTML = expCats.map(c => `<option value="${c.name}">${c.name}</option>`).join('');

  const budgets = await window.api.getBudgets();
  const list = document.getElementById('budget-list');
  const empty = document.getElementById('budget-empty');

  if (budgets.length === 0) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  list.innerHTML = budgets.map(b => {
    const pct = Math.min((b.spent / b.limit_amount) * 100, 100);
    const cls = pct >= 100 ? 'danger' : pct >= 80 ? 'warning' : 'ok';
    return `
      <div class="budget-item">
        <div class="budget-row">
          <span class="budget-cat">${b.category}</span>
          <div style="display:flex;align-items:center;gap:12px;">
            <span class="budget-amounts">${fmt(b.spent)} / ${fmt(b.limit_amount)}</span>
            <button class="btn btn-outline btn-sm" onclick="deleteBudget('${b.category}')">×</button>
          </div>
        </div>
        <div class="progress">
          <div class="progress-bar ${cls}" style="width:${pct}%"></div>
        </div>
        ${pct >= 100 ? `<div style="font-size:11px;color:var(--expense);margin-top:4px;">⚠ Budget dépassé de ${fmt(b.spent - b.limit_amount)}</div>` : ''}
      </div>
    `;
  }).join('');
}

window.deleteBudget = async function(category) {
  await window.api.deleteBudget(category);
  toast('Budget supprimé');
  loadBudgets();
};

// ─── CATÉGORIES ──────────────────────────────────────────────────────────────────
document.getElementById('btn-add-cat').addEventListener('click', async () => {
  const name = document.getElementById('cat-name').value.trim();
  const type = document.getElementById('cat-type').value;
  if (!name) return toast('Nom requis', 'error');
  await window.api.addCategory({ name, type });
  toast(`Catégorie "${name}" ajoutée !`);
  document.getElementById('cat-name').value = '';
  loadCategories();
});

async function loadCategories() {
  const categories = await window.api.getCategories();
  const typeLabels = { income: 'Revenu', expense: 'Dépense', both: 'Les deux' };
  const tbody = document.getElementById('cat-tbody');
  tbody.innerHTML = categories.map(c => `
    <tr>
      <td style="font-weight:500">${c.name}</td>
      <td><span class="badge badge-${c.type === 'income' ? 'income' : 'expense'}">${typeLabels[c.type]}</span></td>
      <td>
        <button class="btn btn-outline btn-sm" onclick="deleteCat('${c.name}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
        </button>
      </td>
    </tr>
  `).join('');
}

window.deleteCat = async function(name) {
  await window.api.deleteCategory(name);
  toast(`Catégorie supprimée`);
  loadCategories();
};

// ─── IMPORT ──────────────────────────────────────────────────────────────────────

let pendingImport = [];

document.getElementById('btn-import-csv').addEventListener('click', async () => {
  const result = await window.api.importCSV();
  if (!result.success) return;
  if (result.transactions.length === 0) return toast('Aucune transaction détectée dans ce fichier', 'error');
  showImportPreview(result.transactions);
});

document.getElementById('btn-import-pdf').addEventListener('click', async () => {
  const result = await window.api.importPDF();
  if (!result.success) return;
  if (result.transactions.length === 0) return toast('Aucune transaction détectée dans ce PDF', 'error');
  showImportPreview(result.transactions);
});

function showImportPreview(transactions) {
  pendingImport = transactions;
  const card = document.getElementById('import-preview-card');
  const tbody = document.getElementById('import-preview-tbody');
  const count = document.getElementById('import-preview-count');

  count.textContent = `${transactions.length} transaction${transactions.length > 1 ? 's' : ''} détectée${transactions.length > 1 ? 's' : ''}`;

  tbody.innerHTML = transactions.map((t, i) => `
    <tr>
      <td>${fmtDate(t.date)}</td>
      <td><span class="badge badge-${t.type}">${t.type === 'income' ? 'Revenu' : 'Dépense'}</span></td>
      <td>
        <select onchange="pendingImport[${i}].category=this.value" style="border:1px solid var(--border);border-radius:6px;padding:3px 6px;font-size:12px;">
          ${window._categories.map(c => `<option value="${c.name}" ${c.name === t.category ? 'selected' : ''}>${c.name}</option>`).join('')}
        </select>
      </td>
      <td style="color:var(--muted);font-size:12px;">${t.description || '—'}</td>
      <td class="amount-${t.type}">${t.type === 'income' ? '+' : '−'}${fmt(t.amount)}</td>
      <td>
        <button class="btn btn-outline btn-sm" onclick="removeImportRow(${i})">×</button>
      </td>
    </tr>
  `).join('');

  card.style.display = 'block';
  card.scrollIntoView({ behavior: 'smooth' });
}

window.removeImportRow = function(i) {
  pendingImport.splice(i, 1);
  showImportPreview(pendingImport);
};

document.getElementById('btn-import-cancel').addEventListener('click', () => {
  pendingImport = [];
  document.getElementById('import-preview-card').style.display = 'none';
});

document.getElementById('btn-import-confirm').addEventListener('click', async () => {
  if (!pendingImport.length) return;
  const result = await window.api.importConfirm(pendingImport);
  let msg = `${result.count} transaction${result.count > 1 ? 's' : ''} importée${result.count > 1 ? 's' : ''} !`;
  if (result.skipped > 0) msg += ` (${result.skipped} doublon${result.skipped > 1 ? 's' : ''} ignoré${result.skipped > 1 ? 's' : ''})`;
  toast(msg);
  pendingImport = [];
  document.getElementById('import-preview-card').style.display = 'none';
});

// ─── EXPORT ──────────────────────────────────────────────────────────────────────
document.getElementById('btn-export-csv').addEventListener('click', async () => {
  const result = await window.api.exportCSV();
  if (result.success) toast('CSV exporté avec succès !');
  else toast('Export annulé', 'error');
});

document.getElementById('btn-export-pdf').addEventListener('click', async () => {
  const result = await window.api.exportPDF();
  if (result.success) toast('PDF exporté avec succès !');
  else toast('Export annulé', 'error');
});

// ─── RÉCURRENTS ───────────────────────────────────────────────────────────────────

document.querySelectorAll('input[name=rec-type]').forEach(radio => {
  radio.addEventListener('change', async () => {
    const categories = await window.api.getCategories();
    const recSel = document.getElementById('rec-category');
    const filtered = categories.filter(c => c.type === radio.value || c.type === 'both');
    recSel.innerHTML = filtered.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
  });
});

document.getElementById('btn-add-recurring').addEventListener('click', async () => {
  const amount = parseFloat(document.getElementById('rec-amount').value);
  const type = document.querySelector('input[name=rec-type]:checked').value;
  const category = document.getElementById('rec-category').value;
  const description = document.getElementById('rec-desc').value.trim();
  const day_of_month = parseInt(document.getElementById('rec-day').value) || 1;

  if (!amount || amount <= 0) return toast('Montant invalide', 'error');
  if (!category) return toast('Sélectionne une catégorie', 'error');
  if (day_of_month < 1 || day_of_month > 28) return toast('Jour invalide (1–28)', 'error');

  await window.api.addRecurring({ amount, type, category, description, day_of_month });
  toast('Transaction récurrente ajoutée !');
  document.getElementById('rec-amount').value = '';
  document.getElementById('rec-desc').value = '';
  document.getElementById('rec-day').value = '1';
  loadRecurring();
});

async function loadRecurring() {
  const categories = await window.api.getCategories();
  const recType = document.querySelector('input[name=rec-type]:checked')?.value || 'expense';
  const recSel = document.getElementById('rec-category');
  const filtered = categories.filter(c => c.type === recType || c.type === 'both');
  recSel.innerHTML = filtered.map(c => `<option value="${c.name}">${c.name}</option>`).join('');

  const list = await window.api.getRecurring();
  const container = document.getElementById('recurring-list');
  const empty = document.getElementById('recurring-empty');

  if (list.length === 0) {
    container.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  container.innerHTML = `
    <table style="width:100%">
      <thead><tr><th>Type</th><th>Catégorie</th><th>Description</th><th>Montant</th><th>Jour</th><th></th></tr></thead>
      <tbody>
        ${list.map(r => `
          <tr>
            <td><span class="badge badge-${r.type}">${r.type === 'income' ? 'Revenu' : 'Dépense'}</span></td>
            <td>${r.category}</td>
            <td style="color:var(--muted)">${r.description || '—'}</td>
            <td class="amount-${r.type}">${r.type === 'income' ? '+' : '−'}${fmt(r.amount)}</td>
            <td style="color:var(--muted)">le ${r.day_of_month}</td>
            <td>
              <button class="btn btn-outline btn-sm" onclick="deleteRecurring(${r.id})">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
              </button>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

window.deleteRecurring = async function(id) {
  await window.api.deleteRecurring(id);
  toast('Récurrence supprimée');
  loadRecurring();
};

// ─── TELEGRAM ────────────────────────────────────────────────────────────────────

async function loadTelegramPage() {
  const s = await window.api.settingsGet();
  const tokenInput = document.getElementById('tg-token');
  const connectBtn = document.getElementById('btn-tg-connect');
  const disconnectBtn = document.getElementById('btn-tg-disconnect');
  const badge = document.getElementById('tg-status-badge');

  if (s.active) {
    tokenInput.value = s.telegramToken;
    tokenInput.disabled = true;
    connectBtn.style.display = 'none';
    disconnectBtn.style.display = '';
    badge.style.display = '';
  } else {
    tokenInput.disabled = false;
    connectBtn.style.display = '';
    disconnectBtn.style.display = 'none';
    badge.style.display = 'none';
  }
}

document.getElementById('btn-tg-connect').addEventListener('click', async () => {
  const token = document.getElementById('tg-token').value.trim();
  const errEl = document.getElementById('tg-error');
  if (!token) { errEl.textContent = 'Colle ton token ici.'; errEl.style.display = ''; return; }
  errEl.style.display = 'none';

  const btn = document.getElementById('btn-tg-connect');
  btn.textContent = 'Connexion…'; btn.disabled = true;

  const res = await window.api.telegramConnect(token);
  btn.textContent = 'Connecter'; btn.disabled = false;

  if (res.success) {
    toast(`Bot @${res.botName} connecté ! Envoie /start à ton bot.`);
    loadTelegramPage();
  } else {
    errEl.textContent = res.error || 'Erreur de connexion';
    errEl.style.display = '';
  }
});

document.getElementById('btn-tg-disconnect').addEventListener('click', async () => {
  await window.api.telegramDisconnect();
  toast('Bot déconnecté');
  loadTelegramPage();
});

// Rafraîchir le dashboard quand une transaction arrive via Telegram
window.api.onTelegramNewTx(() => {
  const activePage = document.querySelector('.nav-item.active')?.dataset.page;
  if (activePage === 'dashboard') loadDashboard();
  if (activePage === 'transactions') loadTransactions();
  toast('Nouvelle transaction reçue via Telegram !');
});

// ─── Initialisation ──────────────────────────────────────────────────────────────
async function init() {
  // Initialiser date par défaut
  document.getElementById('tx-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('filter-month').value = currentYearMonth();

  const categories = await window.api.getCategories();
  window._categories = categories;
  populateCategorySelects(categories, 'expense');

  await loadDashboard();
}

init();
