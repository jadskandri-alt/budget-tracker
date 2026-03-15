const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Transactions
  getTransactions: (filters) => ipcRenderer.invoke('db:getTransactions', filters),
  addTransaction:  (data)    => ipcRenderer.invoke('db:addTransaction', data),
  deleteTransaction:  (id)   => ipcRenderer.invoke('db:deleteTransaction', id),
  updateTransaction:  (data) => ipcRenderer.invoke('db:updateTransaction', data),

  // Catégories
  getCategories: ()     => ipcRenderer.invoke('db:getCategories'),
  addCategory:   (data) => ipcRenderer.invoke('db:addCategory', data),
  deleteCategory: (name)=> ipcRenderer.invoke('db:deleteCategory', name),

  // Budgets
  getBudgets: ()     => ipcRenderer.invoke('db:getBudgets'),
  setBudget:  (data) => ipcRenderer.invoke('db:setBudget', data),
  deleteBudget: (cat)=> ipcRenderer.invoke('db:deleteBudget', cat),

  // Stats
  getSummary: (month) => ipcRenderer.invoke('db:getSummary', month),
  getAvg3Months: () => ipcRenderer.invoke('db:getAvg3Months'),

  // Export & Backup
  exportCSV: () => ipcRenderer.invoke('export:csv'),
  exportPDF: () => ipcRenderer.invoke('export:pdf'),
  backupNow: () => ipcRenderer.invoke('backup:now'),

  // Import
  importCSV:     ()     => ipcRenderer.invoke('import:csv'),
  importPDF:     ()     => ipcRenderer.invoke('import:pdf'),
  importConfirm: (txs)  => ipcRenderer.invoke('import:confirm', txs),

  // Récurrents
  getRecurring:    ()     => ipcRenderer.invoke('recurring:get'),
  addRecurring:    (data) => ipcRenderer.invoke('recurring:add', data),
  deleteRecurring: (id)   => ipcRenderer.invoke('recurring:delete', id),

  // Paramètres & Telegram
  settingsGet:        ()      => ipcRenderer.invoke('settings:get'),
  setSavingsGoal:     (goal)  => ipcRenderer.invoke('settings:setSavingsGoal', goal),
  telegramConnect:    (token) => ipcRenderer.invoke('telegram:connect', token),
  telegramDisconnect: ()      => ipcRenderer.invoke('telegram:disconnect'),
  onTelegramNewTx:    (cb)    => ipcRenderer.on('telegram:new-tx', cb),
});
