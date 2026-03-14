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
  toast('Transaction ajoutée !');
  document.getElementById('add-form-card').style.display = 'none';
  clearTxForm();
  loadTransactions();
});

function clearTxForm() {
  document.getElementById('tx-amount').value = '';
  document.getElementById('tx-desc').value = '';
  document.getElementById('tx-date').value = '';
  document.getElementById('tx-income').checked = true;
}

document.getElementById('filter-type').addEventListener('change', loadTransactions);
document.getElementById('filter-cat').addEventListener('change', loadTransactions);
document.getElementById('filter-month').addEventListener('change', loadTransactions);
document.getElementById('btn-clear-filters').addEventListener('click', () => {
  document.getElementById('filter-type').value = '';
  document.getElementById('filter-cat').value = '';
  document.getElementById('filter-month').value = '';
  loadTransactions();
});

async function loadTransactions() {
  const type     = document.getElementById('filter-type').value;
  const category = document.getElementById('filter-cat').value;
  const month    = document.getElementById('filter-month').value;

  const categories = await window.api.getCategories();
  const txTypeSel = document.querySelector('input[name=tx-type]:checked')?.value || 'expense';
  populateCategorySelects(categories, txTypeSel);

  const txs = await window.api.getTransactions({ type: type || undefined, category: category || undefined, month: month || undefined });

  const tbody = document.getElementById('tx-tbody');
  tbody.innerHTML = txs.map(t => `
    <tr>
      <td>${fmtDate(t.date)}</td>
      <td><span class="badge badge-${t.type}">${t.type === 'income' ? 'Revenu' : 'Dépense'}</span></td>
      <td>${t.category}</td>
      <td style="color:var(--muted)">${t.description || '—'}</td>
      <td class="amount-${t.type}">${t.type === 'income' ? '+' : '−'}${fmt(t.amount)}</td>
      <td>
        <button class="btn btn-outline btn-sm" onclick="deleteTx(${t.id})">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>
        </button>
      </td>
    </tr>
  `).join('');

  const empty = document.getElementById('tx-empty');
  empty.style.display = txs.length === 0 ? 'block' : 'none';
}

window.deleteTx = async function(id) {
  await window.api.deleteTransaction(id);
  toast('Transaction supprimée');
  loadTransactions();
};

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

// ─── Initialisation ──────────────────────────────────────────────────────────────
async function init() {
  // Initialiser date par défaut
  document.getElementById('tx-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('filter-month').value = currentYearMonth();

  const categories = await window.api.getCategories();
  populateCategorySelects(categories, 'expense');

  await loadDashboard();
}

init();
