const { app, BrowserWindow, session, shell } = require('electron');
const path = require('path');

// Evita múltiplas instâncias do app rodando em segundo plano
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 600,
    title: "Zap Zap",
    autoHideMenuBar: true,
    show: false, // Evita flash da janela antes da interface carregar
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: true
    }
  });

  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'index.html'));

  // Exibe a janela apenas quando o conteúdo estiver pronto
  win.once('ready-to-show', () => {
    win.show();
  });

  // Abre links externos no navegador padrão em vez de criar janelas internas
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}

// Limpeza preventiva de cache temporário (sem apagar o localStorage/Sessão)
async function clearAppCache() {
  try {
    if (session.defaultSession) {
      await session.defaultSession.clearCache();
    }
  } catch (err) {
    console.error('[Session] Erro ao limpar cache:', err);
  }
}

app.whenReady().then(async () => {
  await clearAppCache();

  // Concede permissões automáticas de mídia (microfone) e notificações
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'notifications' || permission === 'pointerLock') {
      return callback(true);
    }
    callback(false);
  });

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
