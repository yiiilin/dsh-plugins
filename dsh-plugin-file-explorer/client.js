/**
 * dsh-plugin-file-explorer — browser bundle (static DSH client module).
 *
 * Registers the file explorer as a page in the `right-panel` host. The host
 * owns the right layout column, width, navigation rail, and page switching.
 *
 * Two views behind the page's local tabs:
 *  - Files: directory browser (list / read / download / delete via the
 *    /_dsh/file-explorer API).
 *  - Git Graph: a vscode/git-graph style commit DAG with colored lanes, ref
 *    pills, a working-tree row, expandable commit details, and per-file diffs
 *    (via the /_dsh/file-explorer/git-* API).
 */
window.__ModuleLoader__.load({
	id: "@yiln-dsh/dsh-plugin-file-explorer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let React = require("react");

		const inject = ["slots", "rightPanel"];

		const LOCALE_NS = "file-explorer";
		const ZH_DICT = {
			"files.title": "文件",
			"git.title": "Git 图谱",
			"workspace": "工作区",
			"files.refresh": "刷新",
			"files.refreshList": "刷新文件列表",
			"git.refreshGraph": "刷新图谱",
			"files.up": "上一级",
			"files.goUp": "返回上级目录",
			"files.delete": "删除",
			"files.deleteFile": "删除 {name}",
			"files.confirmDelete": "确认删除 {name}",
			"files.clickAgain": "再次点击确认删除",
			"files.deleteFailed": "删除失败",
			"files.view": "查看",
			"files.viewFile": "查看 {name}",
			"files.download": "下载",
			"files.downloadFile": "下载 {name}",
			"files.downloadFailed": "下载失败",
			"files.closePreview": "关闭预览",
			"files.preview": "预览",
			"files.fullscreen": "全屏",
			"files.enterFullscreen": "进入全屏",
			"files.exitFullscreen": "退出全屏",
			"files.imageControls": "图片控制",
			"files.zoomIn": "放大",
			"files.zoomOut": "缩小",
			"files.resetZoom": "重置缩放",
			"files.resetImageZoom": "重置图片缩放",
			"files.imagePreview": "图片预览",
			"files.previewDialog": "文件预览",
			"files.workspaceRoot": "工作区根目录",
			"files.loading": "加载中…",
			"git.loading": "加载中…",
			"files.empty": "空文件夹",
			"files.listFailed": "文件列表加载失败",
			"files.readFailed": "文件读取失败",
			"files.imageMeta": "图片 / {size}",
			"files.binary": "二进制文件",
			"files.fileTooLarge": "文件过大，无法在此预览",
			"files.imageTooLarge": "图片过大，无法在此预览",
			"files.noPreview": "（无预览）",
			"files.binaryNoPreview": "二进制文件无法预览",
			"files.edit": "编辑",
			"files.editFile": "编辑 {name}",
			"files.save": "保存",
			"files.saving": "保存中…",
			"files.saved": "已保存",
			"files.saveFailed": "保存失败",
			"files.dirty": "有未保存的更改",
			"files.discardConfirm": "有未保存的更改，确定放弃并关闭吗？",
			"files.editorLoadFailed": "编辑器加载失败",
			"git.logFailed": "Git 提交记录加载失败",
			"git.commitFailed": "提交详情加载失败",
			"git.diffFailed": "差异加载失败",
			"git.loadingChanges": "加载变更…",
			"git.noDiff": "（无差异）",
			"git.noMessage": "（无提交信息）",
			"git.diffTruncated": "…（差异已截断）",
			"git.uncommitted": "未提交的更改",
			"git.workingTree": "工作区",
			"git.workingTreeLabel": "工作区",
			"git.noCommitsYet": "暂无提交",
			"git.noCommitsYetSuffix": "（暂无提交）",
			"git.noData": "暂无数据",
			"git.detachedHead": "游离 HEAD",
			"git.allBranches": "所有分支",
			"git.branchFilter": "分支筛选",
			"git.currentBranch": "当前分支",
			"git.diff": "差异",
			"git.closeDiff": "关闭差异",
			"git.authorUnknown": "未知",
			"git.changedFiles.one": "共 {count} 个变更文件",
			"git.changedFiles.other": "共 {count} 个变更文件",
			"git.changedVsHead.one": "共 {count} 个变更文件（对比 HEAD）",
			"git.changedVsHead.other": "共 {count} 个变更文件（对比 HEAD）",
			"git.changesCount.one": "{count} 个变更",
			"git.changesCount.other": "{count} 个变更",
			"time.justNow": "刚刚",
			"time.minutesAgo": "{n} 分钟前",
			"time.hoursAgo": "{n} 小时前",
			"time.daysAgo": "{n} 天前",
			"time.weeksAgo": "{n} 周前",
			"time.monthsAgo": "{n} 个月前",
			"time.yearsAgo": "{n} 年前",
		};
		const EN_DICT = {
			"files.title": "Files",
			"git.title": "Git Graph",
			"workspace": "Workspace",
			"files.refresh": "Refresh",
			"files.refreshList": "Refresh file list",
			"git.refreshGraph": "Refresh graph",
			"files.up": "Up",
			"files.goUp": "Go to parent directory",
			"files.delete": "Delete",
			"files.deleteFile": "Delete {name}",
			"files.confirmDelete": "Confirm deleting {name}",
			"files.clickAgain": "Click again to delete",
			"files.deleteFailed": "Delete failed",
			"files.view": "View",
			"files.viewFile": "View {name}",
			"files.download": "Download",
			"files.downloadFile": "Download {name}",
			"files.downloadFailed": "Download failed",
			"files.closePreview": "Close preview",
			"files.preview": "Preview",
			"files.fullscreen": "Fullscreen",
			"files.enterFullscreen": "Enter fullscreen",
			"files.exitFullscreen": "Exit fullscreen",
			"files.imageControls": "Image controls",
			"files.zoomIn": "Zoom in",
			"files.zoomOut": "Zoom out",
			"files.resetZoom": "Reset zoom",
			"files.resetImageZoom": "Reset image zoom",
			"files.imagePreview": "Image preview",
			"files.previewDialog": "File preview",
			"files.workspaceRoot": "workspace root",
			"files.loading": "Loading...",
			"git.loading": "Loading…",
			"files.empty": "Empty folder",
			"files.listFailed": "Failed to list files",
			"files.readFailed": "Failed to read file",
			"files.imageMeta": "Image / {size}",
			"files.binary": "Binary",
			"files.fileTooLarge": "File is too large to preview here",
			"files.imageTooLarge": "Image is too large to preview here",
			"files.noPreview": "(No preview)",
			"files.binaryNoPreview": "Binary file cannot be previewed",
			"files.edit": "Edit",
			"files.editFile": "Edit {name}",
			"files.save": "Save",
			"files.saving": "Saving…",
			"files.saved": "Saved",
			"files.saveFailed": "Save failed",
			"files.dirty": "Unsaved changes",
			"files.discardConfirm": "You have unsaved changes. Discard them and close?",
			"files.editorLoadFailed": "Editor failed to load",
			"git.logFailed": "Failed to load git log",
			"git.commitFailed": "Failed to load commit",
			"git.diffFailed": "Failed to load diff",
			"git.loadingChanges": "Loading changes…",
			"git.noDiff": "(no diff)",
			"git.noMessage": "(no message)",
			"git.diffTruncated": "… (diff truncated)",
			"git.uncommitted": "Uncommitted changes",
			"git.workingTree": "Working tree",
			"git.workingTreeLabel": "working tree",
			"git.noCommitsYet": "No commits yet",
			"git.noCommitsYetSuffix": " (no commits yet)",
			"git.noData": "No data",
			"git.detachedHead": "detached HEAD",
			"git.allBranches": "All branches",
			"git.branchFilter": "Branch filter",
			"git.currentBranch": "Current branch",
			"git.diff": "Diff",
			"git.closeDiff": "Close diff",
			"git.authorUnknown": "unknown",
			"git.changedFiles.one": "{count} changed file",
			"git.changedFiles.other": "{count} changed files",
			"git.changedVsHead.one": "{count} changed file (vs HEAD)",
			"git.changedVsHead.other": "{count} changed files (vs HEAD)",
			"git.changesCount.one": "{count} change",
			"git.changesCount.other": "{count} changes",
			"time.justNow": "just now",
			"time.minutesAgo": "{n}m ago",
			"time.hoursAgo": "{n}h ago",
			"time.daysAgo": "{n}d ago",
			"time.weeksAgo": "{n}w ago",
			"time.monthsAgo": "{n}mo ago",
			"time.yearsAgo": "{n}y ago",
		};

		function applyParams(template, params) {
			if (!params) return template;
			return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
		}

		function apply(ctx) {
			const slots = ctx.get('slots')
			const rightPanel = ctx.get('rightPanel')
			if (slots === undefined || rightPanel === undefined) return

			const locale = ctx.get("locale");
			if (locale !== undefined) {
				ctx.effect(() => locale.register(LOCALE_NS, { zh: ZH_DICT, en: EN_DICT }), "file-explorer: locale");
			}
			const t = locale !== undefined
				? locale.bind(LOCALE_NS)
				: (key, params) => applyParams(ZH_DICT[key] ?? EN_DICT[key] ?? key, params);

			const style = document.createElement("style");
			style.id = "dsh-plugin-file-explorer-style";
			style.setAttribute("data-plugin", "dsh-plugin-file-explorer");
			style.textContent = `
.dsh-fe-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f5f5f4));
  color: var(--dsw-alias-label-primary, #111827);
  overflow: hidden;
}
.dsh-fe-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 48px;
  padding: 10px 12px 10px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
  box-sizing: border-box;
}
.dsh-fe-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #111827);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-fe-icon {
  flex: 0 0 auto;
  cursor: pointer;
  width: 28px;
  height: 28px;
  color: var(--dsw-alias-label-secondary, #4b5563);
  background: transparent;
  border: 0;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.dsh-fe-icon:hover {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2, #e7e5e4));
}
.dsh-fe-path {
  min-width: 0;
  margin: 8px 12px 0;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary, #57534e);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: text;
  box-sizing: border-box;
  background: transparent;
  text-align: left;
}
.dsh-fe-path:hover {
  background: var(--dsw-alias-bg-layer-2, #e7e5e4);
}
.dsh-fe-path-input {
  width: 100%;
  box-sizing: border-box;
  margin: 8px 12px 0;
  padding: 5px 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.2));
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #111827);
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  outline: none;
  width: calc(100% - 24px);
}
.dsh-fe-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px 4px;
}
.dsh-fe-toolbutton {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #4b5563);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.dsh-fe-toolbutton:hover:not(:disabled) {
  background: var(--dsw-alias-bg-layer-2, #e7e5e4);
  color: var(--dsw-alias-label-primary, #111827);
}
.dsh-fe-toolbutton:disabled {
  opacity: 0.35;
  cursor: default;
}
.dsh-fe-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 8px 10px;
}
.dsh-fe-row {
  width: 100%;
  height: 34px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary, #111827);
  cursor: pointer;
  text-align: left;
  box-sizing: border-box;
  font: inherit;
}
.dsh-fe-row:hover {
  background: var(--dsw-alias-bg-layer-2, #e7e5e4);
}
.dsh-fe-marker {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.dsh-fe-marker-dir {
  color: var(--dsw-alias-brand-primary, #4f46e5);
}
.dsh-fe-marker-file {
  color: var(--dsw-alias-label-secondary, #78716c);
}
.dsh-fe-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.dsh-fe-meta {
  flex: 0 0 auto;
  min-width: 56px;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
}
.dsh-fe-size {
  color: var(--dsw-alias-label-secondary, #78716c);
  font-size: 11px;
  white-space: nowrap;
}
.dsh-fe-actions {
  display: none;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
}
.dsh-fe-row:hover .dsh-fe-actions {
  display: inline-flex;
}
.dsh-fe-row:hover .dsh-fe-size {
  display: none;
}
.dsh-fe-action {
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #57534e);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.dsh-fe-action:hover {
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #111827);
}
.dsh-fe-action-danger:hover {
  color: var(--dsw-alias-state-error-primary, #b91c1c);
}
.dsh-fe-action-confirm {
  color: var(--dsw-alias-state-error-primary, #b91c1c);
  background: var(--dsw-alias-bg-layer-1, #ffffff);
}
.dsh-fe-status {
  margin: 8px 10px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
  border-radius: 6px;
  color: var(--dsw-alias-label-secondary, #57534e);
  font-size: 12px;
  line-height: 16px;
  overflow-wrap: anywhere;
}
.dsh-fe-status-error {
  color: var(--dsw-alias-state-error-primary, #b91c1c);
}
.dsh-fe-overlay {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--dsw-alias-bg-base, #000) 45%, transparent);
  pointer-events: auto;
}
.dsh-fe-modal {
  width: min(680px, calc(100vw - 40px));
  max-height: min(80vh, 640px);
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.2));
  border-radius: 8px;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.22);
  overflow: hidden;
}
.dsh-fe-modal-editor {
  width: min(920px, calc(100vw - 32px));
  height: min(80vh, 720px);
  max-height: min(80vh, 720px);
}
.dsh-fe-modal-fullscreen {
  width: 100vw;
  height: 100vh;
  max-width: none;
  max-height: none;
  border: 0;
  border-radius: 0;
}
.dsh-fe-modal-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
}
.dsh-fe-modal-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
}
.dsh-fe-editor-title-dot {
  display: inline-block;
  margin-left: 6px;
  color: var(--dsw-alias-state-warning-primary, #d97706);
  font-size: 10px;
  vertical-align: 1px;
}
.dsh-fe-modal-meta {
  flex: 0 0 auto;
  color: var(--dsw-alias-label-secondary, #6b7280);
  font-size: 12px;
}
.dsh-fe-image-tools {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.dsh-fe-image-tool {
  width: 28px;
  height: 28px;
  padding: 0;
}
.dsh-fe-image-tool:disabled {
  opacity: 0.35;
  cursor: default;
}
.dsh-fe-image-zoom-label {
  display: inline-block;
  min-width: 40px;
  color: var(--dsw-alias-label-secondary, #6b7280);
  font-size: 11px;
  text-align: center;
  white-space: nowrap;
}
.dsh-fe-modal-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 12px 14px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 12px;
  line-height: 18px;
}
.dsh-fe-modal-body-image {
  display: flex;
  align-items: stretch;
  justify-content: stretch;
  min-height: 160px;
  padding: 0;
  overflow: hidden;
  background: var(--dsw-alias-bg-base, #f5f5f4);
  white-space: normal;
}
.dsh-fe-modal-body-editor {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 0;
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
}
.dsh-fe-editor-host {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
}
.dsh-fe-editor-host .monaco-editor,
.dsh-fe-editor-host .monaco-editor-background,
.dsh-fe-editor-host .monaco-editor .margin {
  background-color: transparent;
}
.dsh-fe-editor-status {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  padding: 2px 14px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
  color: var(--dsw-alias-label-secondary, #78716c);
  font-size: 11px;
}
.dsh-fe-editor-status-dirty {
  color: var(--dsw-alias-state-warning-primary, #d97706);
}
.dsh-fe-editor-status-error {
  color: var(--dsw-alias-state-error-primary, #b91c1c);
}
.dsh-fe-editor-save {
  margin-left: auto;
  height: 24px;
  padding: 0 12px;
  border: 0;
  border-radius: 6px;
  background: var(--dsw-alias-brand-primary, #4f46e5);
  color: #ffffff;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dsh-fe-editor-save:hover:not(:disabled) {
  filter: brightness(1.08);
}
.dsh-fe-editor-save:disabled {
  opacity: 0.55;
  cursor: default;
}
.dsh-fe-image-stage {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  touch-action: none;
}
.dsh-fe-preview-image {
  display: block;
  max-width: 100%;
  max-height: 60vh;
  width: auto;
  height: auto;
  object-fit: contain;
  user-select: none;
  -webkit-user-drag: none;
  transition: transform 120ms ease;
}
.dsh-fe-modal-fullscreen .dsh-fe-preview-image {
  max-height: calc(100vh - 64px);
}
.dsh-fe-preview-image-pannable {
  cursor: grab;
}
.dsh-fe-preview-image-dragging {
  cursor: grabbing;
  transition: none;
}
.dsh-git-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px 2px;
}
.dsh-git-scope {
  margin-left: auto;
  height: 24px;
  padding: 0 4px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.2));
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-secondary, #4b5563);
  font: inherit;
  font-size: 11px;
}
.dsh-git-info {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 4px 14px 6px;
  color: var(--dsw-alias-label-secondary, #78716c);
  font-size: 11px;
}
.dsh-git-info-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary, #111827);
  font-weight: 600;
}
.dsh-git-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 8px 10px;
}
.dsh-git-row {
  width: 100%;
  height: 38px;
  display: flex;
  align-items: stretch;
  border: 0;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  text-align: left;
  padding: 0;
  font: inherit;
  overflow: hidden;
}
.dsh-git-row:hover {
  background: var(--dsw-alias-bg-layer-2, #e7e5e4);
}
.dsh-git-cell {
  flex: 0 0 auto;
  display: block;
}
.dsh-git-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
  padding: 0 8px 0 2px;
}
.dsh-git-line1 {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.dsh-git-subject {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--dsw-alias-label-primary, #111827);
}
.dsh-git-line2 {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #78716c);
}
.dsh-git-pill {
  flex: 0 0 auto;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  line-height: 15px;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid transparent;
}
.dsh-git-pill-head {
  background: var(--dsw-alias-brand-primary, #4f46e5);
  color: #fff;
}
.dsh-git-pill-branch {
  background: var(--dsw-alias-bg-layer-2, #e7e5e4);
  color: var(--dsw-alias-label-secondary, #57534e);
}
.dsh-git-pill-remote {
  background: transparent;
  border-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.2));
  color: var(--dsw-alias-label-secondary, #78716c);
}
.dsh-git-pill-tag {
  background: rgba(217, 119, 6, 0.16);
  color: #b45309;
}
.dsh-git-pill-detached {
  background: transparent;
  border-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.2));
  color: var(--dsw-alias-label-secondary, #78716c);
  font-style: italic;
}
.dsh-git-detail {
  padding: 2px 8px 10px 36px;
}
.dsh-git-msg {
  margin: 0 0 6px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #111827);
  font-family: var(--ds-font-family-code, ui-monospace, monospace);
  font-size: 11px;
  line-height: 16px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.dsh-git-files-title {
  margin: 0 2px 4px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, #78716c);
}
.dsh-git-file {
  width: 100%;
  height: 24px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font: inherit;
}
.dsh-git-file:hover {
  background: var(--dsw-alias-bg-layer-2, #e7e5e4);
}
.dsh-git-badge {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
}
.dsh-git-file-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  unicode-bidi: plaintext;
}
.dsh-fe-page {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  overflow: hidden;
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f5f5f4));
  color: var(--dsw-alias-label-primary, #111827);
}
`;
			document.head.append(style);

			async function api(method, payload) {
				const options = { headers: { "content-type": "application/json" } };
				options.method = "POST";
				options.body = JSON.stringify(payload === undefined ? {} : payload);
				const response = await fetch(`/_dsh/file-explorer/${method}`, options);
				let data;
				try {
					data = await response.json();
				} catch {
					throw new Error(`file explorer API returned HTTP ${response.status}`);
				}
				if (!response.ok || data.ok === false) {
					throw new Error(data.error || `file explorer API returned HTTP ${response.status}`);
				}
				return data;
			}

			// --- monaco editor loading --------------------------------------------
			// monaco-editor ships as AMD chunks served verbatim from the host at
			// /_dsh/file-explorer/monaco/vs. We load the AMD loader as a classic
			// script (it installs global require/define — the DSH client module
			// system does not install either), configure its baseUrl to the served
			// tree, and resolve 'vs/editor/editor.main' once. Language features for
			// css/html/json/typescript register on demand when a model with that
			// language id is created.
			const MONACO_BASE = '/_dsh/file-explorer/monaco/vs'
			let monacoPromise = null
			function loadMonaco() {
				if (monacoPromise) return monacoPromise
				monacoPromise = new Promise((resolve, reject) => {
					if (window.monaco && window.monaco.editor) {
						resolve(window.monaco)
						return
					}
					const script = document.createElement('script')
					script.src = `${MONACO_BASE}/loader.js`
					script.async = true
					script.onload = () => {
						const loader = window.require
						if (typeof loader !== 'function') {
							reject(new Error('monaco AMD loader did not install require'))
							return
						}
						loader.config({ baseUrl: MONACO_BASE, paths: { vs: MONACO_BASE } })
						loader(['vs/editor/editor.main'], () => {
							resolve(window.monaco)
						}, (error) => {
							reject(error instanceof Error ? error : new Error(String(error)))
						})
					}
					script.onerror = () => reject(new Error('could not load monaco loader'))
					document.head.append(script)
				})
				return monacoPromise
			}

			// Map a file name to a monaco language id. Mirrors the host's mime map
			// so text files open with the right syntax highlighting.
			const EXT_TO_LANG = {
				js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
				ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
				json: 'json', jsonc: 'json',
				html: 'html', htm: 'html', svg: 'html',
				css: 'css', scss: 'scss', less: 'less',
				md: 'markdown', markdown: 'markdown', mdx: 'markdown',
				py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
				c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
				cs: 'csharp', php: 'php', sh: 'shell', bash: 'shell', zsh: 'shell',
				yml: 'yaml', yaml: 'yaml', xml: 'xml', sql: 'sql',
				txt: 'plaintext', text: 'plaintext', log: 'plaintext',
			}
			function languageForName(name) {
				if (typeof name !== 'string') return 'plaintext'
				const dot = name.lastIndexOf('.')
				if (dot === -1) return 'plaintext'
				const ext = name.slice(dot + 1).toLowerCase()
				return EXT_TO_LANG[ext] || 'plaintext'
			}

			// Monaco container component: owns the editor lifecycle (create on
			// mount, dispose on unmount, update model/content when props change).
			// The text lives in props.value, so the parent's React state is the
			// single source of truth and the save flow just reads it.
			function MonacoEditor(props) {
				const hostRef = React.useRef(null)
				const editorRef = React.useRef(null)
				const modelRef = React.useRef(null)
				const valueRef = React.useRef(props.value || '')
				const onChangeRef = React.useRef(props.onChange)
				onChangeRef.current = props.onChange

				React.useEffect(() => {
					let disposed = false
					loadMonaco()
						.then((monaco) => {
							if (disposed || !hostRef.current) return
							const editor = monaco.editor.create(hostRef.current, {
								value: valueRef.current,
								language: languageForName(props.name || ''),
								automaticLayout: true,
								minimap: { enabled: false },
								scrollBeyondLastLine: false,
								renderWhitespace: 'selection',
								fontSize: 12,
								lineHeight: 18,
								tabSize: 2,
								wordWrap: 'off',
								padding: { top: 10, bottom: 10 },
								theme: document.body.hasAttribute('data-ds-dark-theme') ? 'vs-dark' : 'vs',
							})
							editorRef.current = editor
							modelRef.current = editor.getModel()
							const sub = editor.onDidChangeModelContent(() => {
								const value = editor.getValue()
								valueRef.current = value
								if (onChangeRef.current) onChangeRef.current(value)
							})
							editor.__dshDispose = () => {
								sub.dispose()
								editor.dispose()
							}
							// The editor measures its container on mount; the modal
							// may still be sizing, so re-layout once after a frame.
							window.requestAnimationFrame(() => {
								if (!disposed && editorRef.current) editorRef.current.layout()
							})
						})
						.catch((error) => {
							if (!disposed) {
								const el = hostRef.current
								if (el) {
									el.textContent = t('files.editorLoadFailed') + ': ' + (error && typeof error.message === 'string' ? error.message : String(error))
									el.style.display = 'flex'
									el.style.alignItems = 'center'
									el.style.justifyContent = 'center'
									el.style.color = 'var(--dsw-alias-label-secondary, #78716c)'
									el.style.font = '13px/1.5 sans-serif'
								}
							}
						})
					return () => {
						disposed = true
						if (editorRef.current) {
							if (editorRef.current.__dshDispose) editorRef.current.__dshDispose()
							editorRef.current = null
							modelRef.current = null
						}
					}
				}, [])

				// Sync external value changes (reload/undo after save) without
				// clobbering the user's typing: only replace when the model still
				// holds the previous external value.
				React.useEffect(() => {
					const editor = editorRef.current
					const next = props.value || ''
					if (!editor || valueRef.current === next) return
					valueRef.current = next
					editor.setValue(next)
				}, [props.value])

				return React.createElement('div', {
					ref: hostRef,
					className: 'dsh-fe-editor-host',
				})
			}

			function svgIcon(icon, size) {
				return React.createElement('svg', {
					viewBox: '0 0 24 24',
					width: size || 16,
					height: size || 16,
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.8,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': true,
				}, icon)
			}
			const folderIcon = React.createElement('path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' })
			const fileIcon = React.createElement(React.Fragment, null,
				React.createElement('path', { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' }),
				React.createElement('polyline', { points: '14 2 14 8 20 8' }),
			)
			const upIcon = React.createElement(React.Fragment, null,
				React.createElement('path', { d: 'M12 19V5' }),
				React.createElement('polyline', { points: '5 12 12 5 19 12' }),
			)
			const refreshIcon = React.createElement(React.Fragment, null,
				React.createElement('path', { d: 'M3 12a9 9 0 1 0 2.64-6.36' }),
				React.createElement('polyline', { points: '21 3 21 9 15 9' }),
			)
			const editIcon = React.createElement(React.Fragment, null,
				React.createElement('path', { d: 'M12 20h9' }),
				React.createElement('path', { d: 'M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z' }),
			)
			const downloadIcon = React.createElement(React.Fragment, null,
				React.createElement('path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }),
				React.createElement('polyline', { points: '7 10 12 15 17 10' }),
				React.createElement('line', { x1: '12', y1: '15', x2: '12', y2: '3' }),
			)
			const trashIcon = React.createElement(React.Fragment, null,
				React.createElement('path', { d: 'M3 6h18' }),
				React.createElement('path', { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }),
				React.createElement('path', { d: 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6' }),
				React.createElement('line', { x1: '10', y1: '11', x2: '10', y2: '17' }),
				React.createElement('line', { x1: '14', y1: '11', x2: '14', y2: '17' }),
			)
			const closeIcon = React.createElement(React.Fragment, null,
				React.createElement('line', { x1: '18', y1: '6', x2: '6', y2: '18' }),
				React.createElement('line', { x1: '6', y1: '6', x2: '18', y2: '18' }),
			)
			const zoomOutIcon = React.createElement(React.Fragment, null,
				React.createElement('circle', { cx: '10.5', cy: '10.5', r: '6.5' }),
				React.createElement('line', { x1: '15.5', y1: '15.5', x2: '21', y2: '21' }),
				React.createElement('line', { x1: '8', y1: '10.5', x2: '13', y2: '10.5' }),
			)
			const zoomInIcon = React.createElement(React.Fragment, null,
				React.createElement('circle', { cx: '10.5', cy: '10.5', r: '6.5' }),
				React.createElement('line', { x1: '15.5', y1: '15.5', x2: '21', y2: '21' }),
				React.createElement('line', { x1: '8', y1: '10.5', x2: '13', y2: '10.5' }),
				React.createElement('line', { x1: '10.5', y1: '8', x2: '10.5', y2: '13' }),
			)
			const fullscreenIcon = React.createElement(React.Fragment, null,
				React.createElement('polyline', { points: '8 3 3 3 3 8' }),
				React.createElement('polyline', { points: '16 3 21 3 21 8' }),
				React.createElement('polyline', { points: '8 21 3 21 3 16' }),
				React.createElement('polyline', { points: '16 21 21 21 21 16' }),
			)
			const fullscreenExitIcon = React.createElement(React.Fragment, null,
				React.createElement('polyline', { points: '9 3 9 9 3 9' }),
				React.createElement('polyline', { points: '15 3 15 9 21 9' }),
				React.createElement('polyline', { points: '9 21 9 15 3 15' }),
				React.createElement('polyline', { points: '15 21 15 15 21 15' }),
			)
			// Mirror of DeepSeek's sidebar IconPanelLeftOutline16 (spine on the
			// right): this panel lives on the right edge, so the glyph mirrors the
			// left sidebar's, signaling collapse into the right-edge icon rail.
			const collapseIcon = React.createElement('svg', {
				viewBox: '0 0 16 16',
				width: 16,
				height: 16,
				fill: 'none',
				'aria-hidden': true,
			},
				React.createElement('g', { transform: 'translate(16,0) scale(-1,1)' },
					React.createElement('path', {
						fillRule: 'evenodd',
						clipRule: 'evenodd',
						fill: 'currentColor',
						d: 'M9.67272 0.522841C10.8339 0.522841 11.76 0.522714 12.4963 0.602493C13.2453 0.683657 13.8789 0.854248 14.4264 1.25197C14.7504 1.48739 15.0355 1.77247 15.2709 2.0965C15.6686 2.64394 15.8392 3.27758 15.9204 4.02655C16.0002 4.7629 16 5.68895 16 6.85014V9.14986C16 10.3111 16.0002 11.2371 15.9204 11.9735C15.8392 12.7224 15.6686 13.3561 15.2709 13.9035C15.0355 14.2275 14.7504 14.5126 14.4264 14.748C13.8789 15.1458 13.2453 15.3163 12.4963 15.3975C11.76 15.4773 10.8339 15.4772 9.67272 15.4772H6.3273C5.16611 15.4772 4.24006 15.4773 3.50371 15.3975C2.75474 15.3163 2.1211 15.1458 1.57366 14.748C1.24963 14.5126 0.964549 14.2275 0.729131 13.9035C0.331407 13.3561 0.160817 12.7224 0.0796529 11.9735C-0.000126137 11.2371 1.25338e-09 10.3111 1.25338e-09 9.14986V6.85014C1.25329e-09 5.68895 -0.000126137 4.7629 0.0796529 4.02655C0.160817 3.27758 0.331407 2.64394 0.729131 2.0965C0.964549 1.77247 1.24963 1.48739 1.57366 1.25197C2.1211 0.854248 2.75474 0.683657 3.50371 0.602493C4.24006 0.522714 5.16611 0.522841 6.3273 0.522841H9.67272ZM5.54303 1.88715V14.1118C5.78636 14.1128 6.04709 14.1169 6.3273 14.1169H9.67272C10.8639 14.1169 11.7032 14.1164 12.3493 14.0465C12.9824 13.9779 13.3497 13.8494 13.6268 13.6482C13.8354 13.4966 14.0195 13.3125 14.1711 13.1039C14.3723 12.8268 14.5007 12.4595 14.5693 11.8264C14.6393 11.1803 14.6398 10.341 14.6398 9.14986V6.85014C14.6398 5.65896 14.6393 4.81967 14.5693 4.1736C14.5007 3.54048 14.3723 3.17318 14.1711 2.89609C14.0195 2.68747 13.8354 2.50337 13.6268 2.35179C13.3497 2.1506 12.9824 2.02212 12.3493 1.95353C11.7032 1.88358 10.8639 1.88307 9.67272 1.88307H6.3273C6.04709 1.88307 5.78636 1.8862 5.54303 1.88715ZM4.1828 1.91166C3.99125 1.9216 3.8148 1.93577 3.65076 1.95353C3.01764 2.02212 2.65034 2.1506 2.37325 2.35179C2.16463 2.50337 1.98052 2.68747 1.82895 2.89609C1.62776 3.17318 1.49928 3.54048 1.43069 4.1736C1.36074 4.81967 1.36023 5.65896 1.36023 6.85014V9.14986C1.36023 10.341 1.36074 11.1803 1.43069 11.8264C1.49928 12.4595 1.62776 12.8268 1.82895 13.1039C1.98052 13.3125 2.16463 13.4966 2.37325 13.6482C2.65034 13.8494 3.01764 13.9779 3.65076 14.0465C3.81478 14.0642 3.99127 14.0774 4.1828 14.0873V1.91166Z',
					}),
				),
			)
			const branchIcon = React.createElement(React.Fragment, null,
				React.createElement('line', { x1: '6', y1: '3', x2: '6', y2: '15' }),
				React.createElement('circle', { cx: '18', cy: '6', r: '3' }),
				React.createElement('circle', { cx: '6', cy: '18', r: '3' }),
				React.createElement('path', { d: 'M18 9a9 9 0 0 1-9 9' }),
			)

			function formatSize(size) {
				if (typeof size !== 'number' || !Number.isFinite(size)) return ''
				if (size < 1024) return `${size} B`
				if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
				if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
				return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
			}

			// --- git graph helpers -------------------------------------------------

			const LANE_COLORS = ['#4f46e5', '#0891b2', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#db2777']
			const STATUS_COLORS = {
				A: '#16a34a', M: '#d97706', D: '#dc2626', R: '#2563eb', C: '#2563eb',
				T: '#d97706', U: '#7c3aed', B: '#6b7280', X: '#6b7280', '?': '#6b7280',
			}
			const GIT_ROW_H = 38

			function statusColor(letter) {
				return STATUS_COLORS[letter] || '#6b7280'
			}

			function relTime(epochSeconds, t) {
				if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds) || epochSeconds <= 0) return ''
				const s = Math.max(0, Date.now() / 1000 - epochSeconds)
				if (s < 60) return t('time.justNow')
				if (s < 3600) return t('time.minutesAgo', { n: Math.floor(s / 60) })
				if (s < 86400) return t('time.hoursAgo', { n: Math.floor(s / 3600) })
				if (s < 604800) return t('time.daysAgo', { n: Math.floor(s / 86400) })
				if (s < 2592000) return t('time.weeksAgo', { n: Math.floor(s / 604800) })
				if (s < 31536000) return t('time.monthsAgo', { n: Math.floor(s / 2592000) })
				return t('time.yearsAgo', { n: Math.floor(s / 31536000) })
			}

			function shortHash(hash) {
				return typeof hash === 'string' && hash.length > 7 ? hash.slice(0, 7) : (hash || '')
			}

			// Turn the linear commit list (newest first) into graph rows with lane
			// assignments and parent edges, mirroring git-graph/vscode style layout:
			// each lane tracks the hash expected to appear there next; a commit
			// consumes its lane and re-fills it with its first parent, while extra
			// parents take new lanes (drawn as merge curves).
			function buildGraphData(commits) {
				const lanes = [] // expected hash per lane; null = free slot
				const colorOf = new Map()
				let nextColor = 0
				const pickColor = (hash, preferred) => {
					let c = colorOf.get(hash)
					if (c === undefined) {
						if (preferred === undefined) {
							c = nextColor % LANE_COLORS.length
							nextColor += 1
						} else {
							c = preferred % LANE_COLORS.length
						}
						colorOf.set(hash, c)
					}
					return c
				}
				const rows = commits.map((commit) => {
					const parents = Array.isArray(commit.parents)
						? commit.parents.filter((p) => typeof p === 'string' && p !== '')
						: []
					const inLanes = lanes.slice()
					let lane = lanes.indexOf(commit.hash)
					const isNew = lane === -1
					if (isNew) {
						let free = lanes.indexOf(null)
						if (free === -1) {
							lanes.push(null)
							free = lanes.length - 1
						}
						lane = free
					}
					const color = pickColor(commit.hash)
					lanes[lane] = null
					const edges = []
					parents.forEach((p, pi) => {
						let pl = lanes.indexOf(p)
						if (pl === -1) {
							let slot = pi === 0 ? lane : lanes.indexOf(null)
							if (slot === -1) {
								lanes.push(p)
								slot = lanes.length - 1
							} else {
								lanes[slot] = p
							}
							pl = slot
						}
						const pColor = pickColor(p, pi === 0 ? color : undefined)
						edges.push({ from: lane, to: pl, color: pColor })
					})
					return { commit, lane, color, isNew, inLanes, edges }
				})
				let width = 1
				rows.forEach((r) => {
					if (r.lane + 1 > width) width = r.lane + 1
					r.edges.forEach((e) => { if (e.to + 1 > width) width = e.to + 1 })
				})
				return { rows, width, colorOf }
			}

			// One commit row's graph cell: pass-through lanes, its incoming stub,
			// parent edges (straight for first parents, curves for merges), dot.
			function GraphSvg(props) {
				const { row, width, colorOf } = props
				const laneW = 12
				const padL = 9
				const xOf = (l) => padL + l * laneW
				// Cell width follows THIS row's actual lanes (lane indices are
				// absolute, so columns stay aligned row-to-row; this just trims the
				// empty right side that a global max-lane width would leave on
				// mostly-linear rows). 1 lane = 24px, so linear history renders
				// compact and the commit text sits right next to the graph.
				let rowLanes = row.lane + 1
				row.edges.forEach((e) => {
					if (e.from + 1 > rowLanes) rowLanes = e.from + 1
					if (e.to + 1 > rowLanes) rowLanes = e.to + 1
				})
				row.inLanes.forEach((hash, k) => {
					if (hash !== null && hash !== undefined && k + 1 > rowLanes) rowLanes = k + 1
				})
				const w = rowLanes * laneW + padL + 3
				const h = GIT_ROW_H
				const cy = h / 2
				const els = []
				const colorOfHash = (hash) => {
					const c = colorOf.get(hash)
					return LANE_COLORS[(typeof c === 'number' ? c : 0) % LANE_COLORS.length]
				}
				row.inLanes.forEach((hash, k) => {
					if (hash === null || hash === undefined || hash === row.commit.hash) return
					els.push(React.createElement('line', {
						key: 'p' + k,
						x1: xOf(k), y1: 0, x2: xOf(k), y2: h,
						stroke: colorOfHash(hash), strokeWidth: 1.5,
					}))
				})
				if (!row.isNew) {
					els.push(React.createElement('line', {
						key: 'in',
						x1: xOf(row.lane), y1: 0, x2: xOf(row.lane), y2: cy,
						stroke: LANE_COLORS[row.color % LANE_COLORS.length], strokeWidth: 1.5,
					}))
				}
				row.edges.forEach((edge, i) => {
					const stroke = LANE_COLORS[edge.color % LANE_COLORS.length]
					if (edge.from === edge.to) {
						els.push(React.createElement('line', {
							key: 'e' + i,
							x1: xOf(edge.from), y1: cy, x2: xOf(edge.to), y2: h,
							stroke, strokeWidth: 1.5,
						}))
					} else {
						const bend = (h - cy) * 0.55
						const d = 'M ' + xOf(edge.from) + ' ' + cy +
							' C ' + xOf(edge.from) + ' ' + (cy + bend) +
							', ' + xOf(edge.to) + ' ' + (h - bend) +
							', ' + xOf(edge.to) + ' ' + h
						els.push(React.createElement('path', {
							key: 'e' + i, d, fill: 'none', stroke, strokeWidth: 1.5,
						}))
					}
				})
				els.push(React.createElement('circle', {
					key: 'dot',
					cx: xOf(row.lane), cy, r: 3.5,
					fill: LANE_COLORS[row.color % LANE_COLORS.length],
					stroke: 'var(--dsw-alias-bg-base, #ffffff)', strokeWidth: 1,
				}))
				return React.createElement('svg', {
					className: 'dsh-git-cell',
					width: w, height: h,
					viewBox: '0 0 ' + w + ' ' + h,
				}, els)
			}

			// Uncommitted-changes pseudo row at the top of the graph.
			function WorkTreeCell(props) {
				const { lane, connectorColor } = props
				const laneW = 12
				const padL = 9
				const xOf = (l) => padL + l * laneW
				const laneIdx = typeof lane === 'number' && lane >= 0 ? lane : 0
				const w = (laneIdx + 1) * laneW + padL + 3
				const h = GIT_ROW_H
				const cy = h / 2
				const x = xOf(laneIdx)
				const els = []
				if (connectorColor !== null) {
					els.push(React.createElement('line', {
						key: 'c', x1: x, y1: cy, x2: x, y2: h,
						stroke: connectorColor, strokeWidth: 1.5,
					}))
				}
				els.push(React.createElement('circle', {
					key: 'dot', cx: x, cy, r: 3.5,
					fill: 'none',
					stroke: 'var(--dsw-alias-label-secondary, #78716c)', strokeWidth: 1.2,
					strokeDasharray: '2 2',
				}))
				return React.createElement('svg', {
					className: 'dsh-git-cell',
					width: w, height: h,
					viewBox: '0 0 ' + w + ' ' + h,
				}, els)
			}

			function RefPills(props) {
				const refs = props.refs
				if (!Array.isArray(refs) || refs.length === 0) return null
				return React.createElement(React.Fragment, null, refs.map((ref, i) =>
					React.createElement('span', {
						key: i,
						className: 'dsh-git-pill dsh-git-pill-' + ref.kind,
						title: ref.name,
					}, ref.name),
				))
			}

			function StatusBadge(props) {
				return React.createElement('span', {
					className: 'dsh-git-badge',
					style: { background: statusColor(props.letter) },
				}, props.letter)
			}

			function GitFileRow(props) {
				const file = props.file
				const label = file.oldPath ? file.oldPath + ' → ' + file.path : file.path
				return React.createElement('button', {
					type: 'button',
					className: 'dsh-git-file',
					onClick: () => props.onOpen(file),
					title: label,
				},
					React.createElement(StatusBadge, { letter: file.status }),
					React.createElement('span', { className: 'dsh-git-file-path' }, label),
				)
			}

			// The whole Git Graph view: toolbar (refresh + branch scope), repo info
			// line, the commit lane rows with an expandable per-commit detail, and a
			// diff modal. Data comes entirely from the /_dsh/file-explorer/git-*
			// JSON API.
			function createGitGraphView(t) {
				return function GitGraphView(props) {
				const api = props.api
				const cwd = props.cwd
				const [scope, setScope] = React.useState('all')
				const [log, setLog] = React.useState(null)
				const [status, setStatus] = React.useState(null)
				const [error, setError] = React.useState(null)
				const [loading, setLoading] = React.useState(false)
				const [tick, setTick] = React.useState(0)
				const [selected, setSelected] = React.useState(null) // commit hash or 'WORKING'
				const [details, setDetails] = React.useState({}) // hash -> {message, files} | {error}
				const [diff, setDiff] = React.useState(null)

				React.useEffect(() => {
					if (cwd === undefined) return
					let cancelled = false
					setLoading(true)
					setError(null)
					setLog(null)
					setSelected(null)
					setDetails({})
					setStatus(null)
					api('git-log', { path: cwd, all: scope === 'all', limit: 300 })
						.then((raw) => {
							if (cancelled) return
							if (raw && raw.ok === true) {
								setLog(raw)
							} else {
								setError(raw && typeof raw.error === 'string' ? raw.error : t('git.logFailed'))
							}
						})
						.catch((err) => {
							if (!cancelled) setError(err && typeof err.message === 'string' ? err.message : String(err))
						})
						.finally(() => {
							if (!cancelled) setLoading(false)
						})
					api('git-status', { path: cwd })
						.then((raw) => { if (!cancelled && raw && raw.ok === true) setStatus(raw) })
						.catch(() => { })
					return () => { cancelled = true }
				}, [cwd, scope, tick])

				// Lazy-load the selected commit's changed-file list.
				React.useEffect(() => {
					if (selected === null || selected === 'WORKING') return
					if (details[selected]) return
					let cancelled = false
					api('git-commit', { path: cwd, hash: selected })
						.then((raw) => {
							if (cancelled) return
							if (raw && raw.ok === true) {
								setDetails((prev) => ({ ...prev, [selected]: raw }))
							} else {
								setDetails((prev) => ({ ...prev, [selected]: { error: raw && typeof raw.error === 'string' ? raw.error : t('git.commitFailed') } }))
							}
						})
						.catch((err) => {
							if (!cancelled) setDetails((prev) => ({ ...prev, [selected]: { error: err && typeof err.message === 'string' ? err.message : String(err) } }))
						})
					return () => { cancelled = true }
				}, [selected, cwd])

				if (cwd === undefined) return null

				const reload = () => { setTick((t) => t + 1) }
				const toggle = (key) => setSelected((cur) => (cur === key ? null : key))

				const openDiff = (hash, file) => {
					setDiff({ title: file.path, hash, loading: true, text: null, error: null })
					api('git-diff', { path: cwd, hash, file: file.path })
						.then((raw) => {
							if (raw && raw.ok === true) {
								const note = raw.truncated ? '\n\n' + t('git.diffTruncated') : ''
								setDiff({ title: file.path, hash, loading: false, text: (raw.patch || '') + note, error: null })
							} else {
								setDiff({ title: file.path, hash, loading: false, text: null, error: raw && typeof raw.error === 'string' ? raw.error : t('git.diffFailed') })
							}
						})
						.catch((err) => {
							setDiff({ title: file.path, hash, loading: false, text: null, error: err && typeof err.message === 'string' ? err.message : String(err) })
						})
				}

				const graph = log && Array.isArray(log.commits) ? buildGraphData(log.commits) : null
				const changes = status && Array.isArray(status.entries) ? status.entries : []

				const renderCommitDetail = (hash, d) => {
					if (d === undefined) {
						return React.createElement('div', { className: 'dsh-git-detail' },
							React.createElement('div', { className: 'dsh-git-files-title' }, t('git.loadingChanges')))
					}
					if (d.error) {
						return React.createElement('div', { className: 'dsh-git-detail' },
							React.createElement('div', { className: 'dsh-git-files-title dsh-fe-status-error' }, d.error))
					}
					const files = Array.isArray(d.files) ? d.files : []
					return React.createElement('div', { className: 'dsh-git-detail' },
						React.createElement('div', { className: 'dsh-git-msg' }, d.message || t('git.noMessage')),
						React.createElement('div', { className: 'dsh-git-files-title' },
							files.length === 1 ? t('git.changedFiles.one', { count: files.length }) : t('git.changedFiles.other', { count: files.length })),
						files.length === 0 ? null : files.map((f, i) =>
							React.createElement(GitFileRow, { key: i, file: f, onOpen: (file) => openDiff(hash, file) })),
					)
				}

				const rows = []
				if (loading) {
					rows.push(React.createElement('div', { key: 'loading', className: 'dsh-fe-status' }, t('git.loading')))
				} else if (error) {
					rows.push(React.createElement('div', { key: 'error', className: 'dsh-fe-status dsh-fe-status-error' }, error))
				} else if (graph !== null) {
					if (changes.length > 0) {
						const first = graph.rows.length > 0 ? graph.rows[0] : null
						const connectorColor = first !== null && first.lane === 0
							? LANE_COLORS[first.color % LANE_COLORS.length]
							: null
						rows.push(React.createElement('div', { key: 'worktree' },
							React.createElement('div', {
								className: 'dsh-git-row',
								onClick: () => toggle('WORKING'),
								role: 'button',
								title: t('git.uncommitted'),
							},
								React.createElement(WorkTreeCell, { lane: first !== null ? first.lane : 0, connectorColor }),
								React.createElement('div', { className: 'dsh-git-main' },
									React.createElement('div', { className: 'dsh-git-line1' },
										React.createElement('span', { className: 'dsh-git-subject' }, t('git.uncommitted')),
										React.createElement('span', { className: 'dsh-git-pill dsh-git-pill-branch' }, String(changes.length)),
									),
									React.createElement('div', { className: 'dsh-git-line2' }, t('git.workingTree')),
								),
							),
							selected === 'WORKING'
								? React.createElement('div', { className: 'dsh-git-detail' },
									React.createElement('div', { className: 'dsh-git-files-title' },
										changes.length === 1 ? t('git.changedVsHead.one', { count: changes.length }) : t('git.changedVsHead.other', { count: changes.length })),
									changes.map((f, i) =>
										React.createElement(GitFileRow, { key: i, file: f, onOpen: (file) => openDiff('WORKING', file) })),
								)
								: null,
						))
					}
					graph.rows.forEach((row, idx) => {
						const c = row.commit
						rows.push(React.createElement('div', { key: c.hash + '-' + idx },
							React.createElement('div', {
								className: 'dsh-git-row',
								onClick: () => toggle(c.hash),
								role: 'button',
								title: c.subject,
							},
								React.createElement(GraphSvg, { row, width: graph.width, colorOf: graph.colorOf }),
								React.createElement('div', { className: 'dsh-git-main' },
									React.createElement('div', { className: 'dsh-git-line1' },
										React.createElement(RefPills, { refs: c.refs }),
										React.createElement('span', { className: 'dsh-git-subject' }, c.subject),
									),
									React.createElement('div', { className: 'dsh-git-line2' },
										`${c.author || t('git.authorUnknown')} · ${relTime(c.date, t)} · ${shortHash(c.hash)}`),
								),
							),
							selected === c.hash ? renderCommitDetail(c.hash, details[c.hash]) : null,
						))
					})
					if (rows.length === 0) {
						rows.push(React.createElement('div', { key: 'empty', className: 'dsh-fe-status' }, t('git.noCommitsYet')))
					}
				} else {
					rows.push(React.createElement('div', { key: 'none', className: 'dsh-fe-status' }, t('git.noData')))
				}

				const branchLabel = status
					? (status.branch === null
						? t('git.detachedHead')
						: status.branch + (status.unborn ? t('git.noCommitsYetSuffix') : ''))
					: null
				const upstreamBits = []
				if (status && status.ahead > 0) upstreamBits.push('↑' + status.ahead)
				if (status && status.behind > 0) upstreamBits.push('↓' + status.behind)

				return React.createElement(React.Fragment, null,
					React.createElement('div', { className: 'dsh-git-bar' },
						React.createElement('button', {
							type: 'button',
							className: 'dsh-fe-toolbutton',
							onClick: reload,
							'aria-label': t('git.refreshGraph'),
							title: t('files.refresh'),
						}, svgIcon(refreshIcon, 15)),
						React.createElement('select', {
							className: 'dsh-git-scope',
							value: scope,
							'aria-label': t('git.branchFilter'),
							onChange: (event) => setScope(event.target.value),
						},
							React.createElement('option', { value: 'all' }, t('git.allBranches')),
							React.createElement('option', { value: 'current' }, t('git.currentBranch')),
						),
					),
					branchLabel !== null
						? React.createElement('div', { className: 'dsh-git-info' },
							svgIcon(branchIcon, 12),
							React.createElement('span', { className: 'dsh-git-info-name' }, branchLabel),
							upstreamBits.length > 0 ? React.createElement('span', null, upstreamBits.join(' ')) : null,
							React.createElement('span', null, changes.length === 1 ? t('git.changesCount.one', { count: changes.length }) : t('git.changesCount.other', { count: changes.length })),
						)
						: null,
					React.createElement('div', { className: 'dsh-git-list' }, rows),
					diff !== null
						? React.createElement('div', {
							className: 'dsh-fe-overlay',
							onClick: () => setDiff(null),
						},
							React.createElement('div', {
								className: 'dsh-fe-modal',
								role: 'dialog',
								'aria-label': t('git.diff'),
								onClick: (event) => event.stopPropagation(),
							},
								React.createElement('div', { className: 'dsh-fe-modal-head' },
									React.createElement('div', { className: 'dsh-fe-modal-title' }, diff.title),
									React.createElement('div', { className: 'dsh-fe-modal-meta' },
										diff.hash === 'WORKING' ? t('git.workingTreeLabel') : shortHash(diff.hash)),
									React.createElement('button', {
										type: 'button',
										className: 'dsh-fe-icon',
										onClick: () => setDiff(null),
										'aria-label': t('git.closeDiff'),
									}, svgIcon(closeIcon, 14)),
								),
								React.createElement('div', { className: 'dsh-fe-modal-body' },
									diff.loading ? t('git.loading') : (diff.error || diff.text || t('git.noDiff'))),
							),
						)
						: null,
				)
			}
			}

			function createFileExplorerPage(t) {
				return function FileExplorerPage(props) {
				if (typeof props.useSessions !== 'function') return null

				const sessionId = props.useSessions((state) => {
					const current = state.current
					if (current === undefined) return undefined
					const row = state.byId[current]
					if (!row || row.blank === true) return undefined
					return current
				})
				const cwd = props.useSessions((state) => {
					const current = state.current
					if (current === undefined) return undefined
					const row = state.byId[current]
					return row ? row.cwd : undefined
				})
				const [requestPath, setRequestPath] = React.useState('')
				const [currentPath, setCurrentPath] = React.useState('')
				const [parentPath, setParentPath] = React.useState(null)
				const [entries, setEntries] = React.useState(null)
				const [error, setError] = React.useState(null)
				const [loading, setLoading] = React.useState(false)
				const [reloadTick, setReloadTick] = React.useState(0)
				const [editingPath, setEditingPath] = React.useState(false)
				const [draftPath, setDraftPath] = React.useState('')
				const [preview, setPreview] = React.useState(null)
				const [previewLoading, setPreviewLoading] = React.useState(false)
				const [dirty, setDirty] = React.useState(false)
				const [saveState, setSaveState] = React.useState(null) // 'saving' | 'saved' | { error }
				const dirtyRef = React.useRef(false)
				const [imageScale, setImageScale] = React.useState(1)
				const [imageOffset, setImageOffset] = React.useState({ x: 0, y: 0 })
				const [imageFullscreen, setImageFullscreen] = React.useState(false)
				const [imageDragging, setImageDragging] = React.useState(false)
				const imageDrag = React.useRef(null)
				const [pendingDelete, setPendingDelete] = React.useState(null)

				React.useEffect(() => {
					if (sessionId === undefined) {
						setParentPath(null)
						setRequestPath('')
						return
					}
					setParentPath(null)
					setRequestPath(cwd === undefined ? '' : cwd)
				}, [sessionId, cwd])

				React.useEffect(() => {
					if (sessionId === undefined) {
						setEntries(null)
						setError(null)
						return
					}
					let cancelled = false
					setLoading(true)
					setEntries(null)
					setError(null)
					api('list', { path: requestPath === '' ? null : requestPath })
						.then((raw) => {
							if (cancelled) return
							if (raw && raw.ok === true) {
								setCurrentPath(raw.path)
								setParentPath(raw.parent || null)
								setEntries(raw.entries || [])
							} else {
								setCurrentPath(requestPath)
								setParentPath(null)
								setEntries([])
								setError(raw && typeof raw.error === 'string' ? raw.error : t('files.listFailed'))
							}
						})
						.catch((err) => {
							if (cancelled) return
							setCurrentPath(requestPath)
							setParentPath(null)
							setEntries([])
							setError(err && typeof err.message === 'string' ? err.message : String(err))
						})
						.finally(() => {
							if (!cancelled) setLoading(false)
						})
					return () => { cancelled = true }
				}, [sessionId, requestPath, reloadTick])

				if (sessionId === undefined) return null

				const sorted = (entries || []).slice().sort((a, b) => {
					const aDir = a.type === 'directory' ? 0 : 1
					const bDir = b.type === 'directory' ? 0 : 1
					return aDir - bDir || a.name.localeCompare(b.name)
				})
				const isRoot = parentPath === null || parentPath === currentPath
				const reload = () => { setPendingDelete(null); setReloadTick((tick) => tick + 1) }
				const startEditPath = () => {
					setDraftPath(currentPath)
					setEditingPath(true)
				}
				const commitPath = () => {
					setPendingDelete(null)
					setEditingPath(false)
					const next = draftPath.trim()
					if (next.length === 0) return
					setRequestPath(next)
				}

				const resetImageZoom = () => {
					imageDrag.current = null
					setImageDragging(false)
					setImageScale(1)
					setImageOffset({ x: 0, y: 0 })
				}
				const resetImageView = () => {
					resetImageZoom()
					setImageFullscreen(false)
				}
				const closePreview = () => {
					if (preview && preview.text !== undefined && preview.text !== null && dirtyRef.current) {
						if (!window.confirm(t('files.discardConfirm'))) return
					}
					resetImageView()
					dirtyRef.current = false
					setDirty(false)
					setPreview(null)
				}
				const setImageZoom = (value) => {
					const next = Math.max(0.25, Math.min(4, Math.round(value * 4) / 4))
					setImageScale(next)
					if (next <= 1) setImageOffset({ x: 0, y: 0 })
				}
				const changeImageZoom = (delta) => setImageZoom(imageScale + delta)
				const handleImageWheel = (event) => {
					event.preventDefault()
					changeImageZoom(event.deltaY < 0 ? 0.25 : -0.25)
				}
				const startImageDrag = (event) => {
					if (imageScale <= 1 || event.button !== 0) return
					imageDrag.current = {
						pointerId: event.pointerId,
						startX: event.clientX,
						startY: event.clientY,
						originX: imageOffset.x,
						originY: imageOffset.y,
					}
					try { event.currentTarget.setPointerCapture(event.pointerId) } catch (_e) { }
					setImageDragging(true)
				}
				const moveImageDrag = (event) => {
					const drag = imageDrag.current
					if (!drag || drag.pointerId !== event.pointerId) return
					setImageOffset({
						x: drag.originX + event.clientX - drag.startX,
						y: drag.originY + event.clientY - drag.startY,
					})
				}
				const endImageDrag = (event) => {
					const drag = imageDrag.current
					if (!drag || drag.pointerId !== event.pointerId) return
					imageDrag.current = null
					setImageDragging(false)
					try { event.currentTarget.releasePointerCapture(event.pointerId) } catch (_e) { }
				}
				const handlePreviewKeyDown = (event) => {
					if (event.key !== 'Escape') return
					event.stopPropagation()
					if (imageFullscreen) setImageFullscreen(false)
					else closePreview()
				}

				const saveFile = () => {
					if (!preview || preview.kind === 'image' || preview.text === undefined || preview.text === null) return
					if (saveState === 'saving') return
					setSaveState('saving')
					api('write', { path: preview.path, content: preview.text })
						.then((raw) => {
							if (raw && raw.ok === true) {
								dirtyRef.current = false
								setDirty(false)
								setSaveState('saved')
							} else {
								setSaveState({ error: raw && typeof raw.error === 'string' ? raw.error : t('files.saveFailed') })
							}
						})
						.catch((err) => {
							setSaveState({ error: err && typeof err.message === 'string' ? err.message : String(err) })
						})
				}

				const openPreview = (entry) => {
					setPendingDelete(null)
					resetImageView()
					setPreviewLoading(true)
					dirtyRef.current = false
					setDirty(false)
					setSaveState(null)
					setPreview(null)
					api('read', { path: entry.path })
						.then((raw) => {
							setPreview(raw && raw.ok === true ? raw : { ok: false, error: raw && typeof raw.error === 'string' ? raw.error : t('files.readFailed') })
						})
						.catch((err) => {
							setPreview({ ok: false, error: err && typeof err.message === 'string' ? err.message : String(err) })
						})
						.finally(() => setPreviewLoading(false))
				}

				const downloadFile = (entry) => {
					setPendingDelete(null)
					// Native streaming download: navigate to the Host route, which
					// streams the file with `Content-Disposition: attachment`. The
					// browser handles the download natively — no JSON data URL, no
					// base64, no full-file buffering in page memory.
					try {
						const query = new URLSearchParams({ path: entry.path })
						const link = document.createElement('a')
						link.href = `/_dsh/file-explorer/download?${query.toString()}`
						link.download = entry.name
						document.body.appendChild(link)
						link.click()
						link.remove()
					} catch (err) {
						setError(err && typeof err.message === 'string' ? err.message : String(err))
					}
				}

				const requestDelete = (entry) => {
					if (pendingDelete !== entry.path) {
						setPendingDelete(entry.path)
						return
					}
					setPendingDelete(null)
					api('delete', { path: entry.path })
						.then((raw) => {
							if (!raw || raw.ok !== true) {
								setError(raw && typeof raw.error === 'string' ? raw.error : t('files.deleteFailed'))
								return
							}
							reload()
						})
						.catch((err) => setError(err && typeof err.message === 'string' ? err.message : String(err)))
				}

				const pathControl = editingPath
					? React.createElement('input', {
						key: 'path-input',
						className: 'dsh-fe-path-input',
						value: draftPath,
						autoFocus: true,
						onChange: (event) => setDraftPath(event.target.value),
						onKeyDown: (event) => {
							if (event.key === 'Enter') commitPath()
							if (event.key === 'Escape') setEditingPath(false)
						},
						onBlur: () => setEditingPath(false),
					})
					: React.createElement('button', {
						type: 'button',
						className: 'dsh-fe-path',
						title: currentPath || t('files.workspaceRoot'),
						onClick: startEditPath,
					}, currentPath || t('files.workspaceRoot'))

				const filesView = React.createElement(React.Fragment, null,
					pathControl,
					React.createElement('div', { className: 'dsh-fe-toolbar' },
						React.createElement('button', {
							type: 'button',
							className: 'dsh-fe-toolbutton',
							disabled: isRoot,
							onClick: () => {
								if (parentPath !== null && parentPath !== currentPath) setRequestPath(parentPath)
							},
							'aria-label': t('files.goUp'),
							title: t('files.up'),
						}, svgIcon(upIcon, 15)),
						React.createElement('button', {
							type: 'button',
							className: 'dsh-fe-toolbutton',
							onClick: reload,
							'aria-label': t('files.refreshList'),
							title: t('files.refresh'),
						}, svgIcon(refreshIcon, 15)),
					),
					React.createElement('div', { className: 'dsh-fe-list' },
						loading
							? React.createElement('div', { className: 'dsh-fe-status' }, t('files.loading'))
							: error
								? React.createElement('div', { className: 'dsh-fe-status dsh-fe-status-error' }, error)
								: sorted.length === 0
									? React.createElement('div', { className: 'dsh-fe-status' }, t('files.empty'))
									: sorted.map((entry) => {
										const isDir = entry.type === 'directory'
										return React.createElement('div', {
											key: entry.path,
											className: 'dsh-fe-row',
											onClick: isDir ? () => setRequestPath(entry.path) : undefined,
											title: entry.path || entry.name,
											role: isDir ? 'button' : undefined,
										},
											React.createElement('span', {
												className: isDir ? 'dsh-fe-marker dsh-fe-marker-dir' : 'dsh-fe-marker dsh-fe-marker-file',
											}, svgIcon(isDir ? folderIcon : fileIcon, 16)),
											React.createElement('span', { className: 'dsh-fe-name' }, entry.name),
											React.createElement('span', { className: 'dsh-fe-meta' },
												React.createElement('span', { className: 'dsh-fe-size' }, isDir ? '' : formatSize(entry.size)),
												React.createElement('span', { className: 'dsh-fe-actions' },
													!isDir && React.createElement('button', {
														type: 'button',
														className: 'dsh-fe-action',
														onClick: (event) => { event.stopPropagation(); openPreview(entry) },
														'aria-label': t('files.editFile', { name: entry.name }),
														title: t('files.edit'),
													}, svgIcon(editIcon, 14)),
													!isDir && React.createElement('button', {
														type: 'button',
														className: 'dsh-fe-action',
														onClick: (event) => { event.stopPropagation(); downloadFile(entry) },
														'aria-label': t('files.downloadFile', { name: entry.name }),
														title: t('files.download'),
													}, svgIcon(downloadIcon, 14)),
													React.createElement('button', {
														type: 'button',
														className: pendingDelete === entry.path ? 'dsh-fe-action dsh-fe-action-confirm' : 'dsh-fe-action dsh-fe-action-danger',
														onClick: (event) => { event.stopPropagation(); requestDelete(entry) },
														'aria-label': pendingDelete === entry.path ? t('files.confirmDelete', { name: entry.name }) : t('files.deleteFile', { name: entry.name }),
														title: pendingDelete === entry.path ? t('files.clickAgain') : t('files.delete'),
													}, svgIcon(trashIcon, 14)),
												),
											),
										)
									}),
					),
				)

				return React.createElement(React.Fragment, null,
					React.createElement('div', {
						className: 'dsh-fe-page',
						role: 'region',
						'aria-label': t('files.title'),
					},
						filesView,
					),
					preview &&
						React.createElement('div', {
							className: 'dsh-fe-overlay',
							onClick: closePreview,
						},
							React.createElement('div', {
								className: preview.kind === 'image' && imageFullscreen
									? 'dsh-fe-modal dsh-fe-modal-fullscreen'
									: preview.text !== undefined && preview.text !== null && !preview.tooLarge
										? 'dsh-fe-modal dsh-fe-modal-editor'
										: 'dsh-fe-modal',
								role: 'dialog',
								'aria-label': t('files.previewDialog'),
								'aria-modal': true,
								tabIndex: -1,
								onKeyDown: handlePreviewKeyDown,
								onClick: (event) => event.stopPropagation(),
							},
								React.createElement('div', { className: 'dsh-fe-modal-head' },
									React.createElement('div', { className: 'dsh-fe-modal-title' },
										preview.name || t('files.preview'),
										dirty
											? React.createElement('span', { className: 'dsh-fe-editor-title-dot', title: t('files.dirty') }, '●')
											: null),
									React.createElement('div', { className: 'dsh-fe-modal-meta' }, preview.kind === 'image' ? t('files.imageMeta', { size: formatSize(preview.size) }) : preview.binary ? t('files.binary') : formatSize(preview.size)),
									preview.kind === 'image' && preview.dataUrl
										? React.createElement('div', {
											className: 'dsh-fe-image-tools',
											role: 'toolbar',
											'aria-label': t('files.imageControls'),
										},
											React.createElement('button', {
												type: 'button',
												className: 'dsh-fe-icon dsh-fe-image-tool',
												disabled: imageScale <= 0.25,
												onClick: () => changeImageZoom(-0.25),
												'aria-label': t('files.zoomOut'),
												title: t('files.zoomOut'),
											}, svgIcon(zoomOutIcon, 14)),
											React.createElement('button', {
												type: 'button',
												className: 'dsh-fe-icon dsh-fe-image-tool',
												onClick: resetImageZoom,
												'aria-label': t('files.resetImageZoom'),
												title: t('files.resetZoom'),
											}, React.createElement('span', { className: 'dsh-fe-image-zoom-label' }, `${Math.round(imageScale * 100)}%`)),
											React.createElement('button', {
												type: 'button',
												className: 'dsh-fe-icon dsh-fe-image-tool',
												disabled: imageScale >= 4,
												onClick: () => changeImageZoom(0.25),
												'aria-label': t('files.zoomIn'),
												title: t('files.zoomIn'),
											}, svgIcon(zoomInIcon, 14)),
											React.createElement('button', {
												type: 'button',
												className: 'dsh-fe-icon dsh-fe-image-tool',
												onClick: () => setImageFullscreen((value) => !value),
												'aria-label': imageFullscreen ? t('files.exitFullscreen') : t('files.enterFullscreen'),
												title: imageFullscreen ? t('files.exitFullscreen') : t('files.fullscreen'),
											}, svgIcon(imageFullscreen ? fullscreenExitIcon : fullscreenIcon, 14)),
										)
										: null,
									React.createElement('button', {
										type: 'button',
										className: 'dsh-fe-icon',
										onClick: closePreview,
										'aria-label': t('files.closePreview'),
									}, svgIcon(closeIcon, 14)),
								),
								preview.kind === 'image'
									? React.createElement('div', {
										className: 'dsh-fe-modal-body dsh-fe-modal-body-image',
										onWheel: preview.dataUrl ? handleImageWheel : undefined,
										onPointerDown: preview.dataUrl ? startImageDrag : undefined,
										onPointerMove: preview.dataUrl ? moveImageDrag : undefined,
										onPointerUp: preview.dataUrl ? endImageDrag : undefined,
										onPointerCancel: preview.dataUrl ? endImageDrag : undefined,
									},
										previewLoading
											? t('files.loading')
											: preview.error
												? preview.error
												: preview.dataUrl
													? React.createElement('div', { className: 'dsh-fe-image-stage' },
														React.createElement('img', {
															className: 'dsh-fe-preview-image' + (imageScale > 1 ? ' dsh-fe-preview-image-pannable' : '') + (imageDragging ? ' dsh-fe-preview-image-dragging' : ''),
															style: { transform: `translate3d(${imageOffset.x}px, ${imageOffset.y}px, 0) scale(${imageScale})` },
															src: preview.dataUrl,
															alt: preview.name || t('files.imagePreview'),
															draggable: false,
														})
													)
													: preview.tooLarge ? t('files.imageTooLarge') : t('files.noPreview'),
									)
									: preview.text !== undefined && preview.text !== null && !preview.tooLarge
										? React.createElement('div', { className: 'dsh-fe-modal-body dsh-fe-modal-body-editor' },
											React.createElement(MonacoEditor, {
												name: preview.name || '',
												value: preview.text,
												onChange: (value) => {
													dirtyRef.current = true
													setDirty(true)
													setSaveState(null)
													setPreview((prev) => (prev ? { ...prev, text: value } : prev))
												},
											}),
											React.createElement('div', { className: 'dsh-fe-editor-status' },
												dirty
													? React.createElement('span', { className: 'dsh-fe-editor-status-dirty' }, t('files.dirty'))
													: saveState === 'saving'
														? React.createElement('span', null, t('files.saving'))
														: saveState === 'saved'
															? React.createElement('span', null, t('files.saved'))
															: saveState && saveState.error
																? React.createElement('span', { className: 'dsh-fe-editor-status-error' }, saveState.error)
																: React.createElement('span', null, preview.size != null ? formatSize(preview.size) : ''),
												React.createElement('button', {
													type: 'button',
													className: 'dsh-fe-editor-save',
													disabled: !dirty || saveState === 'saving',
													onClick: saveFile,
													'aria-label': t('files.save'),
												}, t('files.save')),
											),
										)
										: React.createElement('div', {
											className: 'dsh-fe-modal-body',
										},
											previewLoading
												? t('files.loading')
												: preview.error
													? preview.error
													: preview.tooLarge
														? t('files.fileTooLarge')
														: preview.binary ? t('files.binaryNoPreview') : t('files.noPreview'),
										),
							),
						),
				)
			}
			}

			function createFileExplorerGitPage(t) {
				return function FileExplorerGitPage(props) {
				if (typeof props.useSessions !== 'function') return null

				const sessionId = props.useSessions((state) => {
					const current = state.current
					if (current === undefined) return undefined
					const row = state.byId[current]
					if (!row || row.blank === true) return undefined
					return current
				})
				const cwd = props.useSessions((state) => {
					const current = state.current
					if (current === undefined) return undefined
					const row = state.byId[current]
					return row ? row.cwd : undefined
				})

				if (sessionId === undefined) return null
				return React.createElement('div', {
					className: 'dsh-fe-page',
					role: 'region',
					'aria-label': t('git.title'),
				}, React.createElement(GitGraphView, { api, cwd }))
			}
			}

			const GitGraphView = createGitGraphView(t);
			const FileExplorerPage = createFileExplorerPage(t);
			const FileExplorerGitPage = createFileExplorerGitPage(t);

			ctx.effect(() => {
				const disposeFilesPage = rightPanel.registerPage({
					id: 'file-explorer.files',
					title: t('files.title'),
					group: t('workspace'),
					order: 20,
					placement: 'rail',
					icon: (size) => svgIcon(folderIcon, size),
				})
				const disposeGitPage = rightPanel.registerPage({
					id: 'file-explorer.git',
					title: t('git.title'),
					group: t('workspace'),
					order: 21,
					placement: 'rail',
					icon: (size) => svgIcon(branchIcon, size),
				})
				const disposeFilesSlot = slots.inject('right-panel.page', () => slots.register({
					name: 'right-panel.page',
					key: 'file-explorer.files',
				}, FileExplorerPage))
				const disposeGitSlot = slots.inject('right-panel.page', () => slots.register({
					name: 'right-panel.page',
					key: 'file-explorer.git',
				}, FileExplorerGitPage))
				return () => {
					disposeFilesSlot()
					disposeGitSlot()
					disposeFilesPage()
					disposeGitPage()
				}
			})
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});