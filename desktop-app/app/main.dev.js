/* eslint global-require: off */
require('dotenv').config();
/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `yarn build` or `yarn build-main`, this file is compiled to
 * `./app/main.prod.js` using webpack. This gives us some performance wins.
 *
 * @flow
 */
import electron, {
  app,
  BrowserWindow,
  BrowserView,
  globalShortcut,
  ipcMain,
  nativeTheme,
  webContents,
  shell,
  dialog,
} from 'electron';
import settings from 'electron-settings';
import log from 'electron-log';
import * as Sentry from '@sentry/electron';
import installExtension, {
  REACT_DEVELOPER_TOOLS,
  REDUX_DEVTOOLS,
} from 'electron-devtools-installer';
import fs from 'fs';
import MenuBuilder from './menu';
import {USER_PREFERENCES} from './constants/settingKeys';
import {migrateDeviceSchema} from './settings/migration';
import {DEVTOOLS_MODES} from './constants/previewerLayouts';
import {initMainShortcutManager} from './shortcut-manager/main-shortcut-manager';
import {appUpdater} from './app-updater';
import trimStart from 'lodash/trimStart';
import isURL from 'validator/lib/isURL';
import {
  initBrowserSync,
  getBrowserSyncHost,
  getBrowserSyncEmbedScriptURL,
  closeBrowserSync,
  stopWatchFiles,
  watchFiles,
} from './utils/browserSync';
import {getHostFromURL} from './utils/urlUtils';
import browserSync from 'browser-sync';
import {captureOnSentry} from './utils/logUtils';
import appMetadata from './services/db/appMetadata';

const path = require('path');
const chokidar = require('chokidar');
const URL = require('url').URL;

migrateDeviceSchema();

if (process.env.NODE_ENV !== 'development') {
  Sentry.init({
    dsn: 'https://f2cdbc6a88aa4a068a738d4e4cfd3e12@sentry.io/1553155',
  });
}

const protocol = 'responsively';

let hasActiveWindow = false;

let mainWindow = null;
let urlToOpen = null;
let devToolsView = null;
let fileToOpen = null;

const httpAuthCallbacks = {};

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

if (
  process.env.NODE_ENV === 'development' ||
  process.env.DEBUG_PROD === 'true'
) {
  require('electron-debug')({isEnabled: true});
}

const openWithHandler = filePath => {
  fileToOpen = null;
  if (
    filePath != null &&
    (filePath.endsWith('.html') || filePath.endsWith('.htm'))
  ) {
    const url = `file://${filePath}`;
    fileToOpen = url;
    return true;
  }
  return false;
};

/**
 * Add event listeners...
 */
app.on('will-finish-launching', () => {
  if (process.platform === 'win32') {
    urlToOpen = process.argv.filter(i => /^responsively/.test(i))[0];
  }
  if (['win32', 'darwin'].includes(process.platform)) {
    if (process.argv.length >= 2) {
      if (!openWithHandler(process.argv[1])) {
        app.setAsDefaultProtocolClient(protocol, process.execPath, [
          path.resolve(process.argv[1]),
        ]);
      }
    } else {
      app.setAsDefaultProtocolClient(protocol);
    }
  }
});

app.on('open-file', async (event, filePath) => {
  event.preventDefault();
  let htmlFile = filePath;
  if (process.platform === 'win32' && process.argv.length >= 2) {
    htmlFile = process.argv[1];
  }
  if (openWithHandler(htmlFile)) {
    if (mainWindow) {
      openFile(fileToOpen);
    } else if (!hasActiveWindow) {
      createWindow();
    }
  }
});

app.on('open-url', async (event, url) => {
  if (mainWindow) {
    openUrl(url);
  } else {
    urlToOpen = url;
    if (!hasActiveWindow) {
      createWindow();
    }
  }
});

app.on('window-all-closed', () => {
  hasActiveWindow = false;
  ipcMain.removeAllListeners();
  ipcMain.removeHandler('install-extension');
  ipcMain.removeHandler('get-local-extension-path');
  ipcMain.removeHandler('get-screen-shot-save-path');
  ipcMain.removeHandler('request-browser-sync');
  closeBrowserSync();
  // Respect the OSX convention of having the application in memory even
  // after all windows have been closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on(
  'certificate-error',
  (event, webContents, url, error, certificate, callback) => {
    if (
      getHostFromURL(url) === getBrowserSyncHost() ||
      (settings.get(USER_PREFERENCES) || {}).disableSSLValidation === true
    ) {
      event.preventDefault();
      callback(true);
    }
  }
);

app.on('login', (event, webContents, request, authInfo, callback) => {
  event.preventDefault();
  const {url} = request;
  if (httpAuthCallbacks[url]) {
    return httpAuthCallbacks[url].push(callback);
  }
  httpAuthCallbacks[url] = [callback];
  mainWindow.webContents.send('http-auth-prompt', {url});
});

app.on('activate', (event, hasVisibleWindows) => {
  if (hasVisibleWindows || hasActiveWindow) {
    return;
  }
  createWindow();
});

app.on('ready', () => {
  if (hasActiveWindow) {
    return;
  }
  createWindow();
});

const chooseOpenWindowHandler = url => {
  if (url == null || url.trim() === '' || url === 'about:blank#blocked')
    return 'none';

  if (url === 'about:blank') return 'useWindow';

  if (isURL(url, {protocols: ['http', 'https']})) return 'useWindow';

  let urlObj = null;
  try {
    urlObj = new URL(url);
  } catch {}

  if (
    urlObj != null &&
    urlObj.protocol === 'file:' &&
    (urlObj.pathname.endsWith('.html') || urlObj.pathname.endsWith('.htm'))
  )
    return 'useWindow';

  return 'useShell';
};

const installExtensions = async () => {
  const extensions = [REACT_DEVELOPER_TOOLS, REDUX_DEVTOOLS];
  try {
    await installExtension(extensions);
  } catch (err) {
    console.log('Error installing extensions', err);
  }
};

const openUrl = url => {
  mainWindow.webContents.send(
    'address-change',
    url.replace(`${protocol}://`, '')
  );
  mainWindow.show();
};

const openFile = filePath => {
  mainWindow.webContents.send('address-change', filePath);
  mainWindow.show();
};

const createWindow = async () => {
  appMetadata.incrementOpenCount();
  hasActiveWindow = true;

  if (process.env.NODE_ENV === 'development') {
    await installExtensions();
  }

  const {width, height} = electron.screen.getPrimaryDisplay().workAreaSize;

  const iconPath = path.resolve(__dirname, '../resources/icons/64x64.png');
  mainWindow = new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: {
      nodeIntegration: true,
      nodeIntegrationInWorker: true,
      webviewTag: true,
      enableRemoteModule: true,
    },
    titleBarStyle: 'hidden',
    icon: iconPath,
  });

  await initBrowserSync();
  ipcMain.handle('request-browser-sync', (event, data) => {
    const browserSyncOptions = {
      url: getBrowserSyncEmbedScriptURL(),
    };
    return browserSyncOptions;
  });

  mainWindow.loadURL(`file://${__dirname}/app.html`);

  mainWindow.webContents.on('did-finish-load', () => {
    if (process.platform === 'darwin') {
      // Trick to make the transparent title bar draggable
      mainWindow.webContents
        .executeJavaScript(
          `
            var div = document.createElement("div");
            div.style.position = "absolute";
            div.style.top = 0;
            div.style.height = "23px";
            div.style.width = "100%";
            div.style["-webkit-app-region"] = "drag";
            div.style['-webkit-user-select'] = 'none';
            document.body.appendChild(div);
            true;
          `
        )
        .catch(captureOnSentry);
    }
  });

  initMainShortcutManager();

  const onResize = () => {
    const [width, height] = mainWindow.getContentSize();
    mainWindow.webContents.send('window-resize', {height, width});
  };

  mainWindow.on('resize', onResize);

  mainWindow.once('ready-to-show', () => {
    if (urlToOpen) {
      openUrl(urlToOpen);
      urlToOpen = null;
    } else if (fileToOpen) {
      openFile(fileToOpen);
      fileToOpen = null;
    } else {
      mainWindow.show();
    }
    onResize();
  });

  ipcMain.on('start-watching-file', async (event, fileInfo) => {
    let path = fileInfo.path.replace('file://', '');
    if (process.platform === 'win32') {
      path = trimStart(path, '/');
    }
    app.addRecentDocument(path);
    await stopWatchFiles();
    watchFiles(path);
  });

  ipcMain.on('stop-watcher', async () => {
    await stopWatchFiles();
  });

  ipcMain.on('open-new-window', (event, data) => {
    const handler = chooseOpenWindowHandler(data.url);

    if (handler === 'useWindow') {
      let win = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
          devTools: false,
        },
      });
      win.setMenu(null);
      win.loadURL(data.url);
      win.once('ready-to-show', () => {
        win.show();
      });
      win.on('closed', () => {
        win = null;
      });
    } else if (handler === 'useShell') {
      shell.openExternal(data.url);
    }
  });

  ipcMain.on('http-auth-promt-response', (event, ...args) => {
    if (!args[0].url) {
      return;
    }
    const {url, username, password} = args[0];
    if (!httpAuthCallbacks[url]) {
      return;
    }
    httpAuthCallbacks[url].forEach(cb => cb(username, password));
    httpAuthCallbacks[url] = null;
  });

  ipcMain.on('prefers-color-scheme-select', (event, scheme) => {
    nativeTheme.themeSource = scheme || 'system';
  });

  ipcMain.handle('install-extension', (event, extensionId) => {
    let isLocalExtension;

    try {
      isLocalExtension = fs.statSync(extensionId).isDirectory();
    } catch {
      isLocalExtension = false;
    }

    if (isLocalExtension) {
      return electron.BrowserWindow.addDevToolsExtension(extensionId);
    }

    const id = extensionId
      .replace(/\/$/, '')
      .split('/')
      .pop();

    return installExtension(id, true);
  });

  ipcMain.on('uninstall-extension', (event, name) =>
    BrowserWindow.removeDevToolsExtension(name)
  );

  ipcMain.handle('get-local-extension-path', async event => {
    try {
      const {filePaths = []} = await dialog.showOpenDialog({
        properties: ['openDirectory'],
      });

      const [localExtensionPath = ''] = filePaths;
      return localExtensionPath;
    } catch {
      return '';
    }
  });

  ipcMain.handle('get-screen-shot-save-path', async event => {
    try {
      const {filePaths = []} = await dialog.showOpenDialog({
        properties: ['openDirectory'],
      });
      return filePaths[0];
    } catch {
      return '';
    }
  });

  ipcMain.on('open-devtools', (event, ...args) => {
    const {webViewId, bounds, mode} = args[0];
    if (!webViewId) {
      return;
    }
    const webView = webContents.fromId(webViewId);

    if (mode === DEVTOOLS_MODES.UNDOCKED) {
      return webView.openDevTools();
    }

    devToolsView = new BrowserView();
    mainWindow.setBrowserView(devToolsView);
    devToolsView.setBounds(bounds);
    webView.setDevToolsWebContents(devToolsView.webContents);
    webView.openDevTools();
    devToolsView.webContents
      .executeJavaScript(
        `
          (async function () {
            const sleep = ms => (new Promise(resolve => setTimeout(resolve, ms)));
            var retryCount = 0;
            var done = false;
            while(retryCount < 10 && !done) {
              try {
                retryCount++;
                document.querySelectorAll('div[slot="insertion-point-main"]')[0].shadowRoot.querySelectorAll('.tabbed-pane-left-toolbar.toolbar')[0].style.display = 'none'
                done = true
              } catch(err){
                await sleep(100);
              }
            }
          })()
        `
      )
      .catch(captureOnSentry);
  });

  ipcMain.on('close-devtools', (event, ...args) => {
    const {webViewId} = args[0];
    if (!webViewId) {
      return;
    }
    const _webContents = webContents.fromId(webViewId);
    if (_webContents) {
      _webContents.closeDevTools();
    }
    if (!devToolsView) {
      return;
    }
    mainWindow.removeBrowserView(devToolsView);
    devToolsView.destroy();
    devToolsView = null;
  });

  ipcMain.on('resize-devtools', (event, ...args) => {
    const {bounds} = args[0];
    if (!bounds || !devToolsView) {
      return;
    }
    devToolsView.setBounds(bounds);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on(
    'new-window',
    (event, url, frameName, disposition, options) => {
      if (url?.indexOf('headwayapp.co') !== -1) {
        event.preventDefault();
        shell.openExternal(url);
      }
    }
  );

  const menuBuilder = new MenuBuilder(mainWindow);
  menuBuilder.buildMenu();

  appUpdater.on('status-changed', nextStatus => {
    menuBuilder.buildMenu(true);
    mainWindow.webContents.send('updater-status-changed', {nextStatus});
  });
  // Remove this if your app does not use auto updates
  appUpdater
    .checkForUpdatesAndNotify()
    .catch(err => console.log('Error while updating app', err));
};
