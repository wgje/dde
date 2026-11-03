const status = document.querySelector('#status');

loadLegacyStatus().catch(() => {
  status.textContent = '读取旧版授权状态失败，请重新打开扩展设置页';
});
document.querySelector('#clearLegacy')?.addEventListener('click', () => {
  clearLegacyConfig().catch(() => {
    status.textContent = '清除旧版授权失败，请稍后重试';
  });
});

async function loadLegacyStatus() {
  const config = await chrome.storage.local.get(['baseUrl', 'token']);
  const hasLegacyConfig = typeof config.baseUrl === 'string'
    || (typeof config.token === 'string' && config.token.length > 0);
  status.textContent = hasLegacyConfig
    ? '检测到旧版未绑定账号的授权；它不会再用于请求，请点击清除。'
    : '未检测到旧版未绑定账号的授权。';
}

async function clearLegacyConfig() {
  await chrome.storage.local.remove(['baseUrl', 'token']);
  status.textContent = '已清除旧版未绑定账号的授权。';
}
