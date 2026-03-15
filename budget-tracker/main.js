const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const Database = require('better-sqlite3');
const pdfParse = require('pdf-parse');

// Dossier de données de l'application
const userDataPath = app.getPath('userData');
const dbPath = path.join(userDataPath, 'budget.db');
const settingsPath = path.join(userDataPath, 'settings.json');

let db;
let mainWindow;

// ─── Paramètres ────────────────────────────────────────────────────────────────

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch { return {}; }
}

function saveSettings(patch) {
  fs.writeFileSync(settingsPath, JSON.stringify({ ...loadSettings(), ...patch }, null, 2), 'utf8');
}

// ─── Bot Telegram ───────────────────────────────────────────────────────────────

let telegramPolling = false;
let telegramOffset = 0;

function telegramGet(token, method, params = {}) {
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams(params).toString();
    const req = https.get(`https://api.telegram.org/bot${token}/${method}${q ? '?' + q : ''}`, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('JSON')); } });
    });
    req.on('error', reject);
    // Timeout de 35s (> long-poll 25s) pour éviter un gel si la connexion se coupe
    req.setTimeout(35000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function telegramPost(token, method, payload) {
  const body = JSON.stringify(payload);
  const req = https.request({
    hostname: 'api.telegram.org', path: `/bot${token}/${method}`, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  });
  return new Promise(resolve => {
    let data = '';
    req.on('response', res => { res.on('data', c => data += c); res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({}); } }); });
    req.on('error', () => resolve({}));
    req.write(body); req.end();
  });
}

function telegramSend(token, chatId, text) {
  telegramPost(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' });
}

function telegramSendKeyboard(token, chatId, text, keyboard) {
  return telegramPost(token, 'sendMessage', {
    chat_id: chatId, text, parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: keyboard }
  });
}

function telegramEditMessage(token, chatId, messageId, text) {
  telegramPost(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown' });
}

function telegramAnswerCallback(token, callbackQueryId) {
  telegramPost(token, 'answerCallbackQuery', { callback_query_id: callbackQueryId });
}

// Transactions en attente de catégorisation : clé = "chatId_msgId"
const pendingTxs = new Map();
// Dernière transaction ajoutée via Telegram par chat (pour /annuler)
const lastTelegramTx = new Map();

function parseTelegramMessage(text) {
  const m = text.match(/(\d+[.,]\d{1,2}|\d+)/);
  if (!m) return null;
  const amount = parseFloat(m[1].replace(',', '.'));
  if (!amount || amount <= 0) return null;

  const desc = text.slice(0, m.index).trim();
  const after = text.slice(m.index + m[0].length).trim();

  // Type explicite avec + ou -
  let type = null;
  if (after.startsWith('+') || /\b(salaire|revenu|income|remboursement|allocation|pension)\b/i.test(desc)) type = 'income';
  else if (after.startsWith('-')) type = 'expense';
  // Sinon type = null → on demandera à l'utilisateur

  return { amount, type, description: desc || '', date: new Date().toISOString().slice(0, 10) };
}

function buildTypeKeyboard() {
  return [[
    { text: '💸 Dépense', callback_data: 'type:expense' },
    { text: '✅ Revenu',  callback_data: 'type:income'  },
  ]];
}

function buildUndoKeyboard(txId) {
  return [[{ text: '🗑 Annuler', callback_data: `delete:${txId}` }]];
}

async function saveTelegramTx(token, chatId, tx) {
  const result = db.prepare('INSERT INTO transactions (amount, type, category, description, date) VALUES (?, ?, ?, ?, ?)').run(tx.amount, tx.type, tx.category, tx.description, tx.date);
  const txId = result.lastInsertRowid;
  lastTelegramTx.set(chatId.toString(), txId);
  const e = tx.type === 'income' ? '✅' : '💸';
  await telegramSendKeyboard(token, chatId,
    `${e} *Enregistré !*\n\n${tx.description ? `📝 ${tx.description}\n` : ''}💶 ${tx.amount.toFixed(2)} €\n🏷 ${tx.category}`,
    buildUndoKeyboard(txId)
  );
  if (mainWindow) mainWindow.webContents.send('telegram:new-tx');
}

function buildCategoryKeyboard(cats, type) {
  const filtered = cats.filter(c => c.type === type || c.type === 'both');
  const keyboard = [];
  for (let i = 0; i < filtered.length; i += 2) {
    const row = [{ text: filtered[i].name, callback_data: `cat:${filtered[i].name}` }];
    if (filtered[i + 1]) row.push({ text: filtered[i + 1].name, callback_data: `cat:${filtered[i + 1].name}` });
    keyboard.push(row);
  }
  return keyboard;
}

async function startTelegramPolling() {
  const settings = loadSettings();
  if (!settings.telegramToken) return;
  telegramPolling = true;
  telegramOffset = settings.telegramOffset || 0;

  const poll = async () => {
    if (!telegramPolling) return;
    try {
      const currentToken = loadSettings().telegramToken;
      if (!currentToken) { if (telegramPolling) setTimeout(poll, 5000); return; }
      const res = await telegramGet(currentToken, 'getUpdates', {
        offset: telegramOffset, timeout: 25,
        allowed_updates: JSON.stringify(['message', 'callback_query'])
      });

      if (res.ok && res.result.length > 0) {
        for (const update of res.result) {
          telegramOffset = update.update_id + 1;
          const token = loadSettings().telegramToken;

          // ── Callback d'un bouton (type ou catégorie) ───────────────────────
          if (update.callback_query) {
            const cb = update.callback_query;
            const chatId = cb.message.chat.id;
            const msgId  = cb.message.message_id;
            const data   = cb.data;
            const key    = `${chatId}_${msgId}`;

            telegramAnswerCallback(token, cb.id);

            if (data.startsWith('type:')) {
              // L'utilisateur a choisi dépense ou revenu
              const type = data.slice(5);
              const tx = pendingTxs.get(key);
              if (tx) {
                tx.type = type;
                const guessed = guessCategory(tx.description);
                const e = type === 'income' ? '✅' : '💸';
                if (guessed !== 'Autres') {
                  // Catégorie détectée → auto-save
                  tx.category = guessed;
                  pendingTxs.delete(key);
                  telegramEditMessage(token, chatId, msgId,
                    `${e} *${tx.amount.toFixed(2)} €*${tx.description ? ` — ${tx.description}` : ''}\n\n🏷 Catégorie détectée : *${guessed}*`
                  );
                  await saveTelegramTx(token, chatId, tx);
                } else {
                  // Demander la catégorie
                  const cats = db.prepare('SELECT * FROM categories').all();
                  const keyboard = buildCategoryKeyboard(cats, type);
                  telegramEditMessage(token, chatId, msgId,
                    `${e} *${tx.amount.toFixed(2)} €*${tx.description ? ` — ${tx.description}` : ''}\n\nChoisis une catégorie :`
                  );
                  const sent = await telegramSendKeyboard(token, chatId, 'Catégorie :', keyboard);
                  if (sent.ok) {
                    pendingTxs.delete(key);
                    pendingTxs.set(`${chatId}_${sent.result.message_id}`, tx);
                  }
                }
              }
            } else if (data.startsWith('cat:')) {
              const category = data.slice(4);
              const tx = pendingTxs.get(key);
              if (tx) {
                tx.category = category;
                pendingTxs.delete(key);
                const e = tx.type === 'income' ? '✅' : '💸';
                telegramEditMessage(token, chatId, msgId, `${e} *${tx.amount.toFixed(2)} €* — 🏷 ${category}`);
                await saveTelegramTx(token, chatId, tx);
              }
            } else if (data.startsWith('delete:')) {
              const txId = parseInt(data.slice(7));
              db.prepare('DELETE FROM transactions WHERE id=?').run(txId);
              telegramEditMessage(token, chatId, msgId, '🗑 *Transaction supprimée.*');
              if (mainWindow) mainWindow.webContents.send('telegram:new-tx');
            }
            continue;
          }

          // ── Message texte ──────────────────────────────────────────────────
          const msg = update.message;
          if (!msg || !msg.text) continue;

          const chatId = msg.chat.id;
          const savedChatId = loadSettings().telegramChatId;
          if (savedChatId && chatId.toString() !== savedChatId.toString()) {
            telegramSend(token, chatId, '❌ Accès non autorisé.'); continue;
          }

          const text = msg.text.trim();
          if (text === '/start') {
            saveSettings({ telegramChatId: chatId });
            telegramSend(token, chatId, '✅ *Bot connecté !*\n\nEnvoie tes dépenses :\n\n• `café 4.50` → dépense\n• `salaire 3000+` → revenu\n\n/solde — solde du mois\n/liste — 5 dernières transactions\n/budget — état des budgets\n/annuler — annuler la dernière saisie\n/aide — aide');
          } else if (text === '/solde') {
            const month = new Date().toISOString().slice(0, 7);
            const r = db.prepare(`SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) as inc, COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) as exp FROM transactions WHERE strftime('%Y-%m', date)=?`).get(month);
            const bal = r.inc - r.exp;
            telegramSend(token, chatId, `📊 *Ce mois-ci :*\n\n✅ Revenus : ${r.inc.toFixed(2)} €\n💸 Dépenses : ${r.exp.toFixed(2)} €\n💰 Solde : ${bal >= 0 ? '+' : ''}${bal.toFixed(2)} €`);
          } else if (text === '/liste') {
            const txs = db.prepare('SELECT * FROM transactions ORDER BY date DESC, id DESC LIMIT 5').all();
            if (!txs.length) {
              telegramSend(token, chatId, '📋 Aucune transaction enregistrée.');
            } else {
              const lines = txs.map(t => {
                const e = t.type === 'income' ? '✅' : '💸';
                return `${e} ${t.date} — *${t.amount.toFixed(2)} €* (${t.category})${t.description ? ` — _${t.description}_` : ''}`;
              }).join('\n');
              telegramSend(token, chatId, `📋 *5 dernières transactions :*\n\n${lines}`);
            }
          } else if (text === '/budget') {
            const month = new Date().toISOString().slice(0, 7);
            const budgets = db.prepare('SELECT * FROM budgets').all();
            if (!budgets.length) {
              telegramSend(token, chatId, '📊 Aucun budget défini.');
            } else {
              const lines = budgets.map(b => {
                const spent = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE type='expense' AND category=? AND strftime('%Y-%m',date)=?`).get(b.category, month);
                const pct = Math.round((spent.total / b.limit_amount) * 100);
                const icon = pct >= 100 ? '🔴' : pct >= 80 ? '🟠' : '🟢';
                return `${icon} *${b.category}* : ${spent.total.toFixed(2)} / ${b.limit_amount.toFixed(2)} € (${pct}%)`;
              }).join('\n');
              telegramSend(token, chatId, `📊 *Budgets ce mois :*\n\n${lines}`);
            }
          } else if (text === '/annuler') {
            const txId = lastTelegramTx.get(chatId.toString());
            if (txId) {
              db.prepare('DELETE FROM transactions WHERE id=?').run(txId);
              lastTelegramTx.delete(chatId.toString());
              telegramSend(token, chatId, '🗑 Dernière transaction supprimée.');
              if (mainWindow) mainWindow.webContents.send('telegram:new-tx');
            } else {
              telegramSend(token, chatId, 'Aucune transaction récente à annuler.');
            }
          } else if (text === '/aide') {
            telegramSend(token, chatId, '📖 *Formats acceptés :*\n\n• `café 4.50` → dépense 4.50€\n• `salaire 3000+` → revenu 3000€\n• `loyer 800 -` → dépense + auto-catégorie\n\n*/Commandes :*\n/solde — solde du mois\n/liste — 5 dernières transactions\n/budget — état des budgets\n/annuler — annuler la dernière saisie');
          } else {
            const tx = parseTelegramMessage(text);
            if (tx) {
              const guessed = guessCategory(tx.description);
              if (tx.type === null) {
                // Type non précisé → demander dépense ou revenu
                const sent = await telegramSendKeyboard(token, chatId,
                  `💰 *${tx.amount.toFixed(2)} €*${tx.description ? ` — ${tx.description}` : ''}\n\nC'est une dépense ou un revenu ?`,
                  buildTypeKeyboard()
                );
                if (sent.ok) pendingTxs.set(`${chatId}_${sent.result.message_id}`, tx);
              } else if (guessed !== 'Autres') {
                // Type ET catégorie connus → auto-save
                tx.category = guessed;
                const e = tx.type === 'income' ? '✅' : '💸';
                telegramSend(token, chatId, `${e} *${tx.amount.toFixed(2)} €*${tx.description ? ` — ${tx.description}` : ''}\n\n🏷 Catégorie détectée : *${guessed}*`);
                await saveTelegramTx(token, chatId, tx);
              } else {
                // Type explicite, catégorie inconnue → demander catégorie
                const cats = db.prepare('SELECT * FROM categories').all();
                const keyboard = buildCategoryKeyboard(cats, tx.type);
                const e = tx.type === 'income' ? '✅' : '💸';
                const sent = await telegramSendKeyboard(token, chatId,
                  `${e} *${tx.amount.toFixed(2)} €*${tx.description ? ` — ${tx.description}` : ''}\n\nChoisis une catégorie :`,
                  keyboard
                );
                if (sent.ok) pendingTxs.set(`${chatId}_${sent.result.message_id}`, tx);
              }
            } else {
              telegramSend(token, chatId, '❓ Format non reconnu.\n\nExemple : `café 4.50` ou `salaire 3000+`\n\n/aide pour plus d\'infos');
            }
          }
        }
        saveSettings({ telegramOffset });
      }
    } catch (err) {
      // Erreur réseau ou timeout → on loggue et on réessaie dans 3s
      console.error('[Telegram poll error]', err.message);
    }
    if (telegramPolling) setTimeout(poll, 3000);
  };
  poll();
}

function stopTelegramPolling() { telegramPolling = false; }

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

    CREATE TABLE IF NOT EXISTS recurring_transactions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      amount       REAL    NOT NULL,
      type         TEXT    NOT NULL CHECK(type IN ('income','expense')),
      category     TEXT    NOT NULL,
      description  TEXT    DEFAULT '',
      day_of_month INTEGER NOT NULL DEFAULT 1,
      active       INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS recurring_applied (
      recurring_id INTEGER NOT NULL,
      month        TEXT    NOT NULL,
      PRIMARY KEY (recurring_id, month)
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

// ─── Transactions récurrentes ─────────────────────────────────────────────────

function applyRecurringTransactions() {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const today = now.getDate();

  const recurrings = db.prepare('SELECT * FROM recurring_transactions WHERE active=1').all();
  const insert = db.prepare(
    `INSERT INTO transactions (amount, type, category, description, date) VALUES (?, ?, ?, ?, ?)`
  );
  const markApplied = db.prepare(
    `INSERT OR IGNORE INTO recurring_applied (recurring_id, month) VALUES (?, ?)`
  );

  const applyAll = db.transaction(() => {
    for (const r of recurrings) {
      const already = db.prepare(
        'SELECT 1 FROM recurring_applied WHERE recurring_id=? AND month=?'
      ).get(r.id, month);
      if (already) continue;
      if (today < r.day_of_month) continue; // pas encore le bon jour

      const day = Math.min(r.day_of_month, new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate());
      const date = `${month}-${String(day).padStart(2, '0')}`;
      insert.run(r.amount, r.type, r.category, r.description, date);
      markApplied.run(r.id, month);
    }
  });
  applyAll();
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
  applyRecurringTransactions();
  createWindow();
  startTelegramPolling();

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
  if (filters.search) { sql += ' AND (description LIKE ? OR category LIKE ?)'; params.push(`%${filters.search}%`, `%${filters.search}%`); }

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

ipcMain.handle('db:updateTransaction', (_, { id, category, amount, type, description, date }) => {
  const fields = [];
  const params = [];
  if (category    !== undefined) { fields.push('category=?');    params.push(category); }
  if (amount      !== undefined) { fields.push('amount=?');      params.push(amount); }
  if (type        !== undefined) { fields.push('type=?');        params.push(type); }
  if (description !== undefined) { fields.push('description=?'); params.push(description); }
  if (date        !== undefined) { fields.push('date=?');        params.push(date); }
  if (!fields.length) return { success: false };
  params.push(id);
  db.prepare(`UPDATE transactions SET ${fields.join(',')} WHERE id=?`).run(...params);
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

    const description = col.description >= 0 ? cols[col.description] || ''       : '';
    const category    = col.category    >= 0 ? (cols[col.category] || guessCategory(description)) : guessCategory(description);

    transactions.push({ date, amount, type, category, description });
  }

  return { success: true, transactions, total: transactions.length };
});

ipcMain.handle('import:confirm', (_, transactions) => {
  const exists = db.prepare(
    `SELECT 1 FROM transactions WHERE date=? AND amount=? AND type=? AND description=? LIMIT 1`
  );
  const insert = db.prepare(
    `INSERT INTO transactions (amount, type, category, description, date) VALUES (?, ?, ?, ?, ?)`
  );
  let inserted = 0;
  const insertMany = db.transaction((txs) => {
    for (const t of txs) {
      const dup = exists.get(t.date, t.amount, t.type, t.description || '');
      if (dup) continue;
      insert.run(t.amount, t.type, t.category, t.description || '', t.date);
      inserted++;
    }
  });
  insertMany(transactions);
  return { success: true, count: inserted, skipped: transactions.length - inserted };
});

// ─── Auto-catégorisation ──────────────────────────────────────────────────────

function guessCategory(description) {
  const d = (description || '').toLowerCase();
  if (/loyer|rent|bail|appartement/.test(d)) return 'Loyer';
  if (/netflix|spotify|amazon prime|apple|disney|deezer|youtube|hbo|canal\+|abonnement|subscription/.test(d)) return 'Abonnements';
  if (/carburant|essence|total|esso|bp |shell|autoroute|parking|bus |train|tec |cfl |taxi|uber/.test(d)) return 'Transport';
  if (/cactus|auchan|carrefour|lidl|aldi|delhaize|supermarche|supermarché|intermarche|match |provera|spar |colruyt|bofferding/.test(d)) return 'Alimentation';
  if (/restaurant|mcdonald|burger|pizza|subway|sushi|snack|boulangerie|friterie|cafe |brasserie/.test(d)) return 'Alimentation';
  if (/pharmacie|docteur|medecin|hopital|hospital|sante|santé|dentiste|opticien|laboratoire/.test(d)) return 'Santé';
  if (/salaire|salary|traitement|paie /.test(d)) return 'Salaire';
  if (/freelance|honoraire|prestation|facture /.test(d)) return 'Freelance';
  if (/remboursement|avoir|vir recu|virement recu/.test(d)) return 'Autres revenus';
  if (/vetement|vêtement|zara|h&m|primark|c&a|uniqlo|sport/.test(d)) return 'Vêtements';
  if (/cinema|theatre|musee|concert|sport|gym|fitness|loisir/.test(d)) return 'Loisirs';
  if (/pret|prêt|credit|crédit|hypotheque|hypothèque/.test(d)) return 'Loyer';
  return 'Autres';
}

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
    title: 'Importer des relevés PDF',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (canceled || !filePaths.length) return { success: false };

  const transactions = [];

  // Stratégie 1 : format Spuerkeess/BCEE — date valeur DD.MM.YY collée au montant
  const amountEndRe = /(\d{2}\.\d{2}\.\d{2})(\d{1,3}(?:\.\d{3})*,\d{2})([+-])\s*$/;
  const dateStartRe = /^(\d{1,2}[.\/\-]\d{1,2}[.\/\-](?:20\d{2}|\d{2}))(?!\d)/;
  const anyDateRe   = /\d{1,2}[.\/\-]\d{1,2}[.\/\-](?:20\d{2}|\d{2})(?!\d)/g;
  const dateRegex   = /\b(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.](\d{4}|\d{2}))\b/g;

  for (const filePath of filePaths) {
    const buffer = fs.readFileSync(filePath);
    const pdfData = await pdfParse(buffer);
    const lines = pdfData.text.split('\n');
    const beforeCount = transactions.length;

    for (const line of lines) {
      const t = line.trim();
      if (t.length < 8) continue;

      const amountMatch = t.match(amountEndRe);
      if (!amountMatch) continue;

      // Date comptable en début de ligne, sinon utiliser la date valeur du montant
      const dateMatch = t.match(dateStartRe);
      const dateStr = dateMatch ? dateMatch[1] : amountMatch[1];
      const date = toISODate(dateStr);
      if (!date) continue;

      const amountStr = amountMatch[2].replace(/\./g, '').replace(',', '.');
      const amount = parseFloat(amountStr);
      if (isNaN(amount) || amount === 0) continue;

      const type = amountMatch[3] === '+' ? 'income' : 'expense';
      const desc = t
        .replace(amountMatch[0], '')
        .replace(anyDateRe, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);

      transactions.push({ date, amount, type, category: guessCategory(desc), description: desc });
    }

    // Stratégie 2 (fallback) : format générique
    if (transactions.length === beforeCount) {
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
        transactions.push({ date, amount: Math.abs(rawAmount), type, category: guessCategory(desc), description: desc });
      }
    }
  }

  return { success: true, transactions, total: transactions.length };
});

// ─── Paramètres & Telegram IPC ────────────────────────────────────────────────

ipcMain.handle('settings:get', () => {
  const s = loadSettings();
  return { telegramToken: s.telegramToken || '', telegramChatId: s.telegramChatId || null, active: telegramPolling };
});

ipcMain.handle('telegram:connect', async (_, token) => {
  try {
    const res = await telegramGet(token, 'getMe');
    if (!res.ok) return { success: false, error: 'Token invalide' };
    stopTelegramPolling();
    saveSettings({ telegramToken: token, telegramOffset: 0 });
    startTelegramPolling();
    return { success: true, botName: res.result.username };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('telegram:disconnect', () => {
  stopTelegramPolling();
  saveSettings({ telegramToken: null, telegramChatId: null, telegramOffset: 0 });
  return { success: true };
});

// ─── Transactions récurrentes IPC ─────────────────────────────────────────────

ipcMain.handle('recurring:get', () => {
  return db.prepare('SELECT * FROM recurring_transactions ORDER BY id DESC').all();
});

ipcMain.handle('recurring:add', (_, data) => {
  const stmt = db.prepare(
    `INSERT INTO recurring_transactions (amount, type, category, description, day_of_month) VALUES (?, ?, ?, ?, ?)`
  );
  const result = stmt.run(data.amount, data.type, data.category, data.description || '', data.day_of_month || 1);
  // Apply immediately if today >= day_of_month and not yet applied this month
  applyRecurringTransactions();
  return { id: result.lastInsertRowid, ...data };
});

ipcMain.handle('recurring:delete', (_, id) => {
  db.prepare('DELETE FROM recurring_transactions WHERE id=?').run(id);
  db.prepare('DELETE FROM recurring_applied WHERE recurring_id=?').run(id);
  return { success: true };
});
