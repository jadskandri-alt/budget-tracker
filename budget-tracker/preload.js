const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Transactions
  getTransactions: (filters) => ipcRenderer.invoke('db:getTransactions', filters),
  addTransaction:  (data)    => ipcRenderer.invoke('db:addTransaction', data),
  deleteTransaction: (id)    => ipcRenderer.invoke('db:deleteTransaction', id),

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

  // Export
  exportCSV: () => ipcRenderer.invoke('export:csv'),
  exportPDF: () => ipcRenderer.invoke('export:pdf'),

  // Import
  importCSV:     ()     => ipcRenderer.invoke('import:csv'),
  importPDF:     ()     => ipcRenderer.invoke('import:pdf'),
  importConfirm: (txs)  => ipcRenderer.invoke('import:confirm', txs),

  // Paramètres & Telegram
  settingsGet:        ()      => ipcRenderer.invoke('settings:get'),
  telegramConnect:    (token) => ipcRenderer.invoke('telegram:connect', token),
  telegramDisconnect: ()      => ipcRenderer.invoke('telegram:disconnect'),
  onTelegramNewTx:    (cb)    => ipcRenderer.on('telegram:new-tx', cb),
});
