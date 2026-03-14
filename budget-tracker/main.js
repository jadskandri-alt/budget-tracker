const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

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
