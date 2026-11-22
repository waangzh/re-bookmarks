export const PENDING_ANALYSIS_STATUS_MESSAGE = "remarks:getPendingAnalysisStatus";
export const PENDING_ANALYSIS_UPDATED_MESSAGE = "remarks:pendingAnalysisUpdated";
export const OPEN_SIDE_PANEL_MESSAGE = "remarks:openSidePanel";

type FirefoxSidebarAction = {
  open: () => Promise<void>;
};

function getFirefoxSidebarAction(): FirefoxSidebarAction | undefined {
  return (globalThis as typeof globalThis & { browser?: { sidebarAction?: FirefoxSidebarAction } }).browser?.sidebarAction;
}

export function isPendingAnalysisStatusMessage(message: unknown): message is { type: typeof PENDING_ANALYSIS_STATUS_MESSAGE } {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === PENDING_ANALYSIS_STATUS_MESSAGE
  );
}

export function isPendingAnalysisUpdatedMessage(message: unknown): message is { type: typeof PENDING_ANALYSIS_UPDATED_MESSAGE } {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === PENDING_ANALYSIS_UPDATED_MESSAGE
  );
}

export function isOpenSidePanelMessage(
  message: unknown
): message is { type: typeof OPEN_SIDE_PANEL_MESSAGE; windowId?: number } {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === OPEN_SIDE_PANEL_MESSAGE
  );
}

export function canOpenExtensionSidebar(): boolean {
  if (typeof chrome !== "undefined" && Boolean(chrome.sidePanel?.open)) return true;
  return Boolean(getFirefoxSidebarAction()?.open);
}

/**
 * 在用户手势上下文中打开扩展侧边栏，供 Popup 主入口一键切换完整面板。
 */
export async function openExtensionSidebar(windowId?: number): Promise<void> {
  const firefoxSidebar = getFirefoxSidebarAction();
  if (firefoxSidebar?.open) {
    await firefoxSidebar.open();
    return;
  }

  if (typeof chrome !== "undefined" && chrome.sidePanel?.open) {
    if (typeof windowId === "number" && windowId > 0) {
      await chrome.sidePanel.open({ windowId });
      return;
    }
    if (chrome.tabs?.query) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (typeof tab?.windowId === "number" && tab.windowId > 0) {
        await chrome.sidePanel.open({ windowId: tab.windowId });
        return;
      }
    }
  }

  throw new Error("当前浏览器暂不支持从弹窗直接打开侧边栏");
}

/**
 * 查询后台正在执行新书签归档分析的书签 ID 列表；后台未就绪或非扩展环境时返回空数组。
 */
export async function getPendingAnalysisBookmarkIds(): Promise<string[]> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return [];
  try {
    const response = (await chrome.runtime.sendMessage({
      type: PENDING_ANALYSIS_STATUS_MESSAGE,
    })) as { bookmarkIds?: unknown } | undefined;
    if (!Array.isArray(response?.bookmarkIds)) return [];
    return response.bookmarkIds.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    return [];
  }
}
