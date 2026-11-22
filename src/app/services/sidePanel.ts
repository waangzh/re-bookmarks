export const PENDING_ANALYSIS_STATUS_MESSAGE = "remarks:getPendingAnalysisStatus";
export const PENDING_ANALYSIS_UPDATED_MESSAGE = "remarks:pendingAnalysisUpdated";
export const OPEN_SIDE_PANEL_MESSAGE = "remarks:openSidePanel";
export const PENDING_SIDEBAR_ROUTE_STORAGE_KEY = "remarks.pendingSidebarRoute";
const PENDING_SIDEBAR_ROUTE_TTL_MS = 30_000;

export type PendingSidebarRoute = {
  to: string;
  createdAt: number;
};

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

export function isValidSidebarRouteTarget(to: unknown): to is string {
  return typeof to === "string" && to.startsWith("/");
}

export function readFreshPendingSidebarRoute(raw: unknown, now = Date.now()): string | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as { to?: unknown; createdAt?: unknown };
  if (!isValidSidebarRouteTarget(candidate.to) || typeof candidate.createdAt !== "number") return null;
  if (candidate.createdAt > now + 5_000 || now - candidate.createdAt > PENDING_SIDEBAR_ROUTE_TTL_MS) return null;
  return candidate.to;
}

export function queuePendingSidebarRoute(to: string): Promise<void> {
  if (!isValidSidebarRouteTarget(to) || typeof chrome === "undefined" || !chrome.storage?.local) {
    return Promise.resolve();
  }
  const payload: PendingSidebarRoute = { to, createdAt: Date.now() };
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [PENDING_SIDEBAR_ROUTE_STORAGE_KEY]: payload }, () => {
      if (chrome.runtime?.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

export function clearPendingSidebarRoute(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    chrome.storage.local.remove(PENDING_SIDEBAR_ROUTE_STORAGE_KEY, () => {
      resolve();
    });
  });
}

export function consumePendingSidebarRoute(): Promise<string | null> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    chrome.storage.local.get(PENDING_SIDEBAR_ROUTE_STORAGE_KEY, (result) => {
      if (chrome.runtime?.lastError) {
        resolve(null);
        return;
      }
      const target = readFreshPendingSidebarRoute(result[PENDING_SIDEBAR_ROUTE_STORAGE_KEY]);
      chrome.storage.local.remove(PENDING_SIDEBAR_ROUTE_STORAGE_KEY, () => {
        resolve(target);
      });
    });
  });
}

export function canOpenExtensionSidebar(): boolean {
  if (typeof chrome !== "undefined" && Boolean(chrome.sidePanel?.open)) return true;
  return Boolean(getFirefoxSidebarAction()?.open);
}

async function openExtensionSidebarNative(windowId?: number): Promise<void> {
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
 * 在用户手势上下文中打开扩展侧边栏；如传入目标路由，则在打开后由侧边栏直达对应页面。
 */
export async function openExtensionSidebar(windowId?: number, targetTo?: string): Promise<void> {
  // 必须同步发起存储写入或清理，避免 await 打断 Firefox / Chromium 的用户手势上下文
  const routeSyncPromise =
    targetTo && isValidSidebarRouteTarget(targetTo)
      ? queuePendingSidebarRoute(targetTo)
      : clearPendingSidebarRoute();

  try {
    await openExtensionSidebarNative(windowId);
    await routeSyncPromise;
  } catch (error) {
    await clearPendingSidebarRoute().catch(() => undefined);
    throw error;
  }
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
