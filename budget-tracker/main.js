const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const pdfParse = require('pdf-parse');

// Dossier de données de l'application
const userDataPath = app.getPath('userData');
const dbPath = path.join(userDataPath, 'budget.db');

let db;
let mainWindow;

// ─── Base de données ───────────────────────────────────────────────────────────

function initDatabase() {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      amount      REAL    NOT NULL,
      type        TEXT    NOT NULL CHECK(type IN ('income','expense')),
      category    TEXT    NOT NULL,
      description TEXT    DEFAULT '',
      date        TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT    UNIQUE NOT NULL,
      type TEXT    NOT NULL CHECK(type IN ('income','expense','both'))
    );

    CREATE TABLE IF NOT EXISTS budgets (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      category     TEXT    UNIQUE NOT NULL,
      limit_amount REAL    NOT NULL
    );
  `);

  // Catégories par défaut
  const defaultCategories = [
    { name: 'Salaire',        type: 'income' },
    { name: 'Freelance',      type: 'income' },
    { name: 'Autres revenus', type: 'income' },
    { name: 'Loyer',          type: 'expense' },
    { name: 'Alimentation',   type: 'expense' },
    { name: 'Transport',      type: 'expense' },
    { name: 'Santé',          type: 'expense' },
    { name: 'Loisirs',        type: 'expense' },
    { name: 'Vêtements',      type: 'expense' },
    { name: 'Abonnements',    type: 'expense' },
    { name: 'Épargne',        type: 'both' },
  ];

  const insertCat = db.prepare(
    `INSERT OR IGNORE INTO categories (name, type) VALUES (?, ?)`
  );
  const insertMany = db.transaction((cats) => {
    for (const c of cats) insertCat.run(c.name, c.type);
  });
  insertMany(defaultCategories);
}

// ─── Fenêtre principale ────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f8fafc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(() => {
  initDatabase();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── Handlers IPC ─────────────────────────────────────────────────────────────

// Transactions
ipcMain.handle('db:getTransactions', (_, filters = {}) => {
  let sql = 'SELECT * FROM transactions WHERE 1=1';
  const params = [];

  if (filters.type) { sql += ' AND type = ?'; params.push(filters.type); }
  if (filters.category) { sql += ' AND category = ?'; params.push(filters.category); }
  if (filters.month) { sql += ' AND strftime(\'%Y-%m\', date) = ?'; params.push(filters.month); }

  sql += ' ORDER BY date DESC, id DESC';
  return db.prepare(sql).all(...params);
});

ipcMain.handle('db:addTransaction', (_, data) => {
  const stmt = db.prepare(
    `INSERT INTO transactions (amount, type, category, description, date)
     VALUES (?, ?, ?, ?, ?)`
  );
  const result = stmt.run(data.amount, data.type, data.category, data.description || '', data.date);
  return { id: result.lastInsertRowid, ...data };
});

ipcMain.handle('db:deleteTransaction', (_, id) => {
  db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
  return { success: true };
});

// Catégories
ipcMain.handle('db:getCategories', () => {
  return db.prepare('SELECT * FROM categories ORDER BY type, name').all();
});

ipcMain.handle('db:addCategory', (_, data) => {
  const stmt = db.prepare('INSERT OR IGNORE INTO categories (name, type) VALUES (?, ?)');
  const result = stmt.run(data.name, data.type);
  return { id: result.lastInsertRowid, ...data };
});

ipcMain.handle('db:deleteCategory', (_, name) => {
  db.prepare('DELETE FROM categories WHERE name = ?').run(name);
  db.prepare('DELETE FROM budgets WHERE category = ?').run(name);
  return { success: true };
});

// Budgets
ipcMain.handle('db:getBudgets', () => {
  const budgets = db.prepare('SELECT * FROM budgets').all();
  // Joindre avec les dépenses du mois courant
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return budgets.map(b => {
    const spent = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
       WHERE type='expense' AND category=? AND strftime('%Y-%m', date)=?`
    ).get(b.category, month);
    return { ...b, spent: spent.total };
  });
});

ipcMain.handle('db:setBudget', (_, data) => {
  const stmt = db.prepare(
    `INSERT INTO budgets (category, limit_amount) VALUES (?, ?)
     ON CONFLICT(category) DO UPDATE SET limit_amount=excluded.limit_amount`
  );
  stmt.run(data.category, data.limit_amount);
  return { success: true };
});

ipcMain.handle('db:deleteBudget', (_, category) => {
  db.prepare('DELETE FROM budgets WHERE category = ?').run(category);
  return { success: true };
});

// Statistiques
ipcMain.handle('db:getSummary', (_, month) => {
  const filter = month || (() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  })();

  const income = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
     WHERE type='income' AND strftime('%Y-%m', date)=?`
  ).get(filter);

  const expense = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
     WHERE type='expense' AND strftime('%Y-%m', date)=?`
  ).get(filter);

  const byCategory = db.prepare(
    `SELECT category, SUM(amount) as total FROM transactions
     WHERE type='expense' AND strftime('%Y-%m', date)=?
     GROUP BY category ORDER BY total DESC`
  ).all(filter);

  const last6months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
    const inc = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type='income' AND strftime('%Y-%m', date)=?`
    ).get(m);
    const exp = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type='expense' AND strftime('%Y-%m', date)=?`
    ).get(m);
    last6months.push({ month: m, label, income: inc.total, expense: exp.total });
  }

  return {
    income: income.total,
    expense: expense.total,
    balance: income.total - expense.total,
    byCategory,
    last6months,
  };
});

// Export CSV
ipcMain.handle('export:csv', async () => {
  const transactions = db.prepare('SELECT * FROM transactions ORDER BY date DESC').all();

  const header = 'Date,Type,Catégorie,Description,Montant\n';
  const rows = transactions.map(t =>
    `${t.date},${t.type === 'income' ? 'Revenu' : 'Dépense'},"${t.category}","${t.description}",${t.amount}`
  ).join('\n');
  const csv = header + rows;

  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: 'Exporter en CSV',
    defaultPath: `budget-${new Date().toISOString().slice(0, 10)}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });

  if (canceled || !filePath) return { success: false };

  fs.writeFileSync(filePath, '\uFEFF' + csv, 'utf8'); // BOM pour Excel
  shell.showItemInFolder(filePath);
  return { success: true, filePath };
});

// Export PDF via impression navigateur
ipcMain.handle('export:pdf', async () => {
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: 'Exporter en PDF',
    defaultPath: `budget-${new Date().toISOString().slice(0, 10)}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });

  if (canceled || !filePath) return { success: false };

  const data = await mainWindow.webContents.printToPDF({
    marginsType: 1,
    printBackground: true,
    pageSize: 'A4',
  });

  fs.writeFileSync(filePath, data);
  shell.showItemInFolder(filePath);
  return { success: true, filePath };
});

// ─── Import CSV ────────────────────────────────────────────────────────────────

function parseCSVLine(line) {
  const result = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { result.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  result.push(cur.trim());
  return result;
}

function toISODate(str) {
  // Accepte DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD
  str = str.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (!m) return null;
  let [, d, mo, y] = m;
  if (y.length === 2) y = '20' + y;
  return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`;
}

function parseAmount(str) {
  if (!str) return null;
  const cleaned = str.replace(/\s/g,'').replace(',','.').replace(/[^0-9.\-]/g,'');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : Math.abs(n);
}

ipcMain.handle('import:csv', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title: 'Importer un fichier CSV',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { success: false };

  const raw = fs.readFileSync(filePaths[0], 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { success: false, error: 'Fichier vide' };

  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/['"éèêàùç ]/g, c => ({é:'e',è:'e',ê:'e',à:'a',ù:'u',ç:'c',' ':'_'}[c]||'')));

  // Détection colonnes
  const col = {
    date:        headers.findIndex(h => /date/.test(h)),
    amount:      headers.findIndex(h => /montant|amount|credit|crédit|debit|débit/.test(h)),
    debit:       headers.findIndex(h => /debit|débit/.test(h)),
    credit:      headers.findIndex(h => /credit|crédit/.test(h)),
    type:        headers.findIndex(h => /type/.test(h)),
    category:    headers.findIndex(h => /cat/.test(h)),
    description: headers.findIndex(h => /desc|libelle|libellé|label|note/.test(h)),
  };

  const transactions = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length < 2) continue;

    const dateStr = col.date >= 0 ? cols[col.date] : null;
    const date = dateStr ? toISODate(dateStr) : null;
    if (!date) continue;

    let amount = null, type = 'expense';

    if (col.debit >= 0 && col.credit >= 0) {
      const debit  = parseAmount(cols[col.debit]);
      const credit = parseAmount(cols[col.credit]);
      if (credit && credit > 0) { amount = credit; type = 'income'; }
      else if (debit && debit > 0) { amount = debit; type = 'expense'; }
    } else if (col.amount >= 0) {
      const raw = cols[col.amount].replace(/\s/g,'').replace(',','.');
      const n = parseFloat(raw.replace(/[^0-9.\-]/g,''));
      if (!isNaN(n)) { amount = Math.abs(n); type = n < 0 ? 'expense' : 'income'; }
    }
    if (!amount) continue;

    // Type explicite (notre propre export)
    if (col.type >= 0) {
      const t = cols[col.type].toLowerCase();
      if (t === 'revenu' || t === 'income') type = 'income';
      else if (t === 'dépense' || t === 'depense' || t === 'expense') type = 'expense';
    }

    const category    = col.category    >= 0 ? cols[col.category]    || 'Autres' : 'Autres';
    const description = col.description >= 0 ? cols[col.description] || ''       : '';

    transactions.push({ date, amount, type, category, description });
  }

  return { success: true, transactions, total: transactions.length };
});

ipcMain.handle('import:confirm', (_, transactions) => {
  const insert = db.prepare(
    `INSERT INTO transactions (amount, type, category, description, date) VALUES (?, ?, ?, ?, ?)`
  );
  const insertMany = db.transaction((txs) => {
    for (const t of txs) insert.run(t.amount, t.type, t.category, t.description || '', t.date);
  });
  insertMany(transactions);
  return { success: true, count: transactions.length };
});

// ─── Import PDF ────────────────────────────────────────────────────────────────

function extractAmounts(lineWithoutDates) {
  // Stratégie 1 : virgule comme séparateur décimal (format français)
  // Ex: 1 234,56 / -1234,56 / 1234,56-
  const frPattern = /([+-])?\s*(\d{1,3}(?:[\s\u00a0]\d{3})*|\d+)[,](\d{2})([+-])?/g;
  const results = [];

  for (const m of lineWithoutDates.matchAll(frPattern)) {
    const signBefore = m[1] || '';
    const signAfter  = m[4] || '';
    const sign = (signBefore === '-' || signAfter === '-') ? -1 : 1;
    const intPart = m[2].replace(/\s|\u00a0/g, '');
    const decPart = m[3];
    const value = sign * parseFloat(`${intPart}.${decPart}`);
    if (!isNaN(value) && value !== 0) results.push(value);
  }

  if (results.length > 0) return results;

  // Stratégie 2 : point comme séparateur décimal, mais seulement si partie entière > 31
  // (pour éviter de confondre 14.03 avec une date)
  const enPattern = /([+-])?\s*(\d+)[.](\d{2})([+-])?/g;
  for (const m of lineWithoutDates.matchAll(enPattern)) {
    const intVal = parseInt(m[2]);
    if (intVal <= 31) continue; // trop petit, ressemble à une date
    const signBefore = m[1] || '';
    const signAfter  = m[4] || '';
    const sign = (signBefore === '-' || signAfter === '-') ? -1 : 1;
    const value = sign * parseFloat(`${m[2]}.${m[3]}`);
    if (!isNaN(value) && value !== 0) results.push(value);
  }

  return results;
}

// Mots-clés indiquant une dépense
const EXPENSE_KEYWORDS = /\b(cb|carte|prelevement|prélèvement|virement|facture|achat|retrait|dab|frais|commission|loyer|assurance|abonnement|cotisation|impot|taxe)\b/i;
const INCOME_KEYWORDS  = /\b(salaire|vir recu|virement recu|remboursement|avoir|credit|crédit reçu|pension|allocation)\b/i;

ipcMain.handle('import:pdf', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title: 'Importer un relevé PDF',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { success: false };

  const buffer = fs.readFileSync(filePaths[0]);
  const pdfData = await pdfParse(buffer);
  const text = pdfData.text;

  const transactions = [];
  const lines = text.split('\n');

  // Stratégie 1 : montant EN FIN DE LIGNE avec signe +/- explicite
  // Format : "5.000,00-"  "427,00+"  "99,00-"  (point=milliers, virgule=décimale)
  const amountEndRe  = /(\d{1,3}(?:\.\d{3})*,\d{2})([+-])\s*$/;
  const dateStartRe  = /^(\d{1,2}[.\/\-]\d{1,2}[.\/\-](?:\d{4}|\d{2}))/;
  const anyDateRe    = /\d{1,2}[.\/\-]\d{1,2}[.\/\-](?:\d{4}|\d{2})/g;

  for (const line of lines) {
    const t = line.trim();
    if (t.length < 8) continue;

    const amountMatch = t.match(amountEndRe);
    if (!amountMatch) continue;

    const dateMatch = t.match(dateStartRe);
    if (!dateMatch) continue;

    const date = toISODate(dateMatch[1]);
    if (!date) continue;

    // Supprimer les séparateurs de milliers (points), convertir virgule→point
    const amountStr = amountMatch[1].replace(/\./g, '').replace(',', '.');
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount === 0) continue;

    const type = amountMatch[2] === '+' ? 'income' : 'expense';

    const desc = t
      .replace(amountMatch[0], '')
      .replace(anyDateRe, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);

    transactions.push({ date, amount, type, category: 'Autres', description: desc });
  }

  // Stratégie 2 (fallback) : format générique virgule/point décimal, signe avant
  if (transactions.length === 0) {
    const dateRegex = /\b(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.](\d{4}|\d{2}))\b/g;
    for (const line of lines) {
      if (line.trim().length < 5) continue;
      const dateMatches = [...line.matchAll(dateRegex)];
      if (!dateMatches.length) continue;
      const date = toISODate(dateMatches[0][1]);
      if (!date) continue;
      let lineForAmount = line;
      for (const dm of dateMatches) lineForAmount = lineForAmount.replace(dm[0], ' ');
      const amounts = extractAmounts(lineForAmount);
      if (!amounts.length) continue;
      const rawAmount = amounts[amounts.length - 1];
      const type = rawAmount < 0 ? 'expense' : (INCOME_KEYWORDS.test(line) ? 'income' : 'expense');
      const desc = lineForAmount.replace(/[+-]?\s*\d{1,3}(?:[\s\u00a0]\d{3})*[,\.]\d{2}[+-]?/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
      transactions.push({ date, amount: Math.abs(rawAmount), type, category: 'Autres', description: desc });
    }
  }

  return { success: true, transactions, total: transactions.length };
});
