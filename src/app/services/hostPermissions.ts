declare const __REMARKS_BROWSER_TARGET__: "chromium" | "firefox";

const ALL_HOSTS = ["<all_urls>"];

export const HOST_PERMISSION_REQUIRED_MESSAGE = "未授予网站访问权限，无法连接 AI 服务、读取网页元数据或检测链接。";

function requiresRuntimeHostPermission() {
  return __REMARKS_BROWSER_TARGET__ === "firefox";
}

function hasPermissionsApi() {
  return typeof chrome !== "undefined" && Boolean(chrome.permissions);
}

export async function hasRequiredHostPermission() {
  if (!requiresRuntimeHostPermission()) return true;
  if (!hasPermissionsApi()) return false;

  return new Promise<boolean>((resolve) => {
    chrome.permissions.contains({ origins: ALL_HOSTS }, (granted) => {
      resolve(!chrome.runtime.lastError && granted);
    });
  });
}

export function requestRequiredHostPermission(): Promise<boolean> {
  if (!requiresRuntimeHostPermission()) return Promise.resolve(true);
  if (!hasPermissionsApi()) return Promise.resolve(false);

  // Firefox requires this call to remain directly within the user gesture.
  // Do not await permissions.contains() before opening the request prompt.
  return new Promise<boolean>((resolve) => {
    chrome.permissions.request({ origins: ALL_HOSTS }, (granted) => {
      resolve(!chrome.runtime.lastError && granted);
    });
  });
}

export async function ensureRequiredHostPermission() {
  const granted = await requestRequiredHostPermission();
  if (!granted) throw new Error(HOST_PERMISSION_REQUIRED_MESSAGE);
  return true;
}
