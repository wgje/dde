/**
 * 兼容入口：复用 Angular NGSW，并为已安装的 legacy desktop widget 提供退役兼容层。
 *
 * 当前产品已经不再支持桌面端 widget，但仍需给历史已安装实例一个可控退役路径：
 * - 保留旧 SW 注册入口，避免升级后旧客户端直接命中 404
 * - 让 legacy widget 显示“已停用”卡片，而不是空白/报错
 * - 点击卡片仍可安全打开主应用工作区
 *
 * 注意：这里不是恢复桌面 widget 功能，只是保留最小 retirement shim。
 */

importScripts('./ngsw-worker.js');

(() => {
	'use strict';

	const LEGACY_WIDGET_TAG = 'nanoflow-focus-summary';
	const WORKSPACE_FRAGMENT = '#/projects?entry=shortcut&intent=open-workspace';
	const TEMPLATE = `{
	  "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
	  "type": "AdaptiveCard",
	  "version": "1.6",
	  "body": [
	    {
	      "type": "TextBlock",
	      "text": "${title}",
	      "weight": "Bolder",
	      "size": "Medium"
	    },
	    {
	      "type": "TextBlock",
	      "text": "${message}",
	      "wrap": true,
	      "spacing": "Medium"
	    },
	    {
	      "type": "TextBlock",
	      "text": "${detail}",
	      "wrap": true,
	      "size": "Small",
	      "isSubtle": true,
	      "spacing": "Small"
	    }
	  ],
	  "actions": [
	    {
	      "type": "Action.Execute",
	      "title": "打开 NanoFlow",
	      "verb": "open-app"
	    }
	  ]
	}`;
	const DATA = `{
	  "title": "NanoFlow",
	  "message": "桌面端小组件已停用",
	  "detail": "当前只保留 Android 手机端小组件。请打开 NanoFlow 继续使用。"
	}`;

	function hasWidgetHostApi() {
		return Boolean(self.widgets && typeof self.widgets.getByTag === 'function');
	}

	async function updateWidgetInstance(widget) {
		if (!hasWidgetHostApi() || !widget || widget.instanceId == null) {
			return;
		}

		try {
			await self.widgets.updateByInstanceId(widget.instanceId, {
				template: TEMPLATE,
				data: DATA,
			});
		} catch {
			// 历史宿主不存在或 API 不可用时静默退化，避免影响主应用缓存链。
		}
	}

	async function updateAllLegacyWidgets() {
		if (!hasWidgetHostApi()) {
			return;
		}

		try {
			const widgets = await self.widgets.getByTag(LEGACY_WIDGET_TAG);
			if (!Array.isArray(widgets)) {
				if (widgets) {
					await updateWidgetInstance(widgets);
				}
				return;
			}

			await Promise.all(widgets.map((widget) => updateWidgetInstance(widget)));
		} catch {
			// noop
		}
	}

	function buildWorkspaceUrl() {
		let scope = self.registration && self.registration.scope ? self.registration.scope : '/';
		if (!scope.endsWith('/')) {
			scope += '/';
		}
		return `${scope}${WORKSPACE_FRAGMENT}`;
	}

	async function focusOrOpenWorkspace() {
		if (!self.clients || typeof self.clients.matchAll !== 'function') {
			return;
		}

		const targetUrl = buildWorkspaceUrl();

		try {
			const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
			const reusable = windowClients.find((client) => typeof client.url === 'string' && client.url.includes('#/projects'))
				?? windowClients[0]
				?? null;

			if (reusable) {
				if (typeof reusable.navigate === 'function') {
					await reusable.navigate(targetUrl);
				}
				if (typeof reusable.focus === 'function') {
					await reusable.focus();
				}
				return;
			}
		} catch {
			// 继续降级到 openWindow
		}

		if (self.clients && typeof self.clients.openWindow === 'function') {
			await self.clients.openWindow(targetUrl);
		}
	}

	self.addEventListener('widgetinstall', (event) => {
		event.waitUntil(updateWidgetInstance(event.widget));
	});

	self.addEventListener('widgetresume', (event) => {
		event.waitUntil(updateWidgetInstance(event.widget));
	});

	self.addEventListener('activate', (event) => {
		event.waitUntil(updateAllLegacyWidgets());
	});

	self.addEventListener('widgetclick', (event) => {
		const verb = event && event.action ? event.action.verb : 'open-app';
		if (verb === 'open-app') {
			event.waitUntil(focusOrOpenWorkspace());
		}
	});
})();
