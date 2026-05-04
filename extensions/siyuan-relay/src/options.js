const DEFAULT_BASE_URL = 'http://127.0.0.1:6806';
const TOKEN_MASK = '••••••••';

const baseUrlInput = document.querySelector('#baseUrl');
const tokenInput = document.querySelector('#token');
const status = document.querySelector('#status');

loadConfig().catch(() => {
  status.textContent = '读取本机配置失败，请重新打开扩展设置页';
});
document.querySelector('#save')?.addEventListener('click', () => {
  saveConfig().catch(() => {
    status.textContent = '保存失败，请检查浏览器扩展权限';
  });
});
document.querySelector('#clear')?.addEventListener('click', () => {
  clearConfig().catch(() => {
    status.textContent = '清除授权失败，请稍后重试';
  });
});

async function loadConfig() {
  const config = await chrome.storage.local.get(['baseUrl', 'token']);
  baseUrlInput.value = typeof config.baseUrl === 'string' ? config.baseUrl : DEFAULT_BASE_URL;
  tokenInput.value = typeof config.token === 'string' && config.token ? TOKEN_MASK : '';
}

async function saveConfig() {
  const baseUrl = baseUrlInput.value.trim() || DEFAULT_BASE_URL;
  if (!isTrustedBaseUrl(baseUrl)) {
    status.textContent = '仅支持 http://127.0.0.1:6806 或 http://localhost:6806';
    return;
  }
  const current = await chrome.storage.local.get(['token']);
  const token = tokenInput.value === TOKEN_MASK ? current.token : tokenInput.value.trim();
  await chrome.storage.local.set({ baseUrl });
  if (token) {
    await chrome.storage.local.set({ token });
  } else {
    await chrome.storage.local.remove(['token']);
  }
  tokenInput.value = token ? TOKEN_MASK : '';
  status.textContent = '已保存本机配置';
}

async function clearConfig() {
  await chrome.storage.local.remove(['token']);
  tokenInput.value = '';
  status.textContent = '已清除本机授权';
}

function isTrustedBaseUrl(value) {
  try {
    const url = new URL(value);
    return (url.origin === 'http://127.0.0.1:6806' || url.origin === 'http://localhost:6806')
      && url.pathname === '/'
      && !url.search
      && !url.hash
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}
