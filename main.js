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
    show: false, // Evita flash da janela/CMD antes da interface carregar
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: true
    }
  });

  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'index.html'));

  // Exibe a janela apenas quando o conteúdo estiver pronto para renderizar
  win.once('ready-to-show', () => {
    win.show();
  });

  // Previne a abertura do CMD ou navegadores externos indesejados ao clicar em links/download
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}

// Função para limpar dados de sessão e garantir inicialização limpa
async function clearAppSession() {
  try {
    if (session.defaultSession) {
      await session.defaultSession.clearStorageData();
      await session.defaultSession.clearCache();
    }
  } catch (err) {
    console.error('[Session] Erro ao limpar sessão:', err);
  }
}

app.whenReady().then(async () => {
  await clearAppSession();

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'notifications') {
      return callback(true);
    }
    callback(false);
  });

  createWindow();
});

// Força a limpeza completa quando o aplicativo for fechado
app.on('before-quit', async () => {
  await clearAppSession();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});