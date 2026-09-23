import type { BookmarkNode, OrganizeMode, PreviewTaskCache } from "../types";
import { generateMovePlanPreviewForBookmarks } from "./organizer";
import {
  clearPreviewTask,
  getBookmarkWhitelist,
  getPreviewTask as getStoredPreviewTask,
  savePreviewPlan,
  savePreviewTask,
} from "./storage";
import { whitelistFingerprint } from "./whitelist";

export const PREVIEW_TASK_MESSAGE = "remarks:preview-task";
const QUICK_TASK_TIMEOUT_MS = 30 * 60 * 1000;
const DEEP_TASK_TIMEOUT_MS = 90 * 60 * 1000;
const STALE_TASK_ERROR = "上次生成任务已超时，请重新开始";
const runningTaskControllers = new Map<string, AbortController>();

type PreviewTaskMessage =
  | {
      type: typeof PREVIEW_TASK_MESSAGE;
      action: "run";
      taskId: string;
      bookmarks: BookmarkNode[];
      organizeMode?: OrganizeMode;
      model?: string;
    }
  | {
      type: typeof PREVIEW_TASK_MESSAGE;
      action: "clear";
    }
  | {
      type: typeof PREVIEW_TASK_MESSAGE;
      action: "get";
    };

type PreviewTaskResponse = {
  task?: PreviewTaskCache | null;
  error?: string;
};

function hasRuntimeMessaging() {
  return typeof chrome !== "undefined" && Boolean(chrome.runtime?.sendMessage);
}

function createTaskId() {
  const randomId = globalThis.crypto?.randomUUID?.();
  return "preview-task-" + Date.now() + "-" + (randomId ?? Math.random().toString(36).slice(2));
}

function createRunningTask(bookmarks: BookmarkNode[], organizeMode: OrganizeMode, model: string | undefined, fingerprint: string): PreviewTaskCache {
  const now = Date.now();
  return {
    id: createTaskId(),
    status: "running",
    createdAt: now,
    updatedAt: now,
    bookmarkCount: bookmarks.length,
    selectedBookmarkIds: bookmarks.map((bookmark) => bookmark.id),
    whitelistFingerprint: fingerprint,
    organizeMode,
    model,
    progress: {
      phase: "queued",
      completedBatches: 0,
      totalBatches: 0,
      processedBookmarks: 0,
      totalBookmarks: bookmarks.length,
      startedAt: now,
      updatedAt: now,
    },
  };
}

function isSameRunningTask(task: PreviewTaskCache | null, taskId: string): task is PreviewTaskCache {
  return task?.id === taskId && task.status === "running";
}

function getTaskTimeoutMs(task: PreviewTaskCache) {
  return task.organizeMode === "deep" ? DEEP_TASK_TIMEOUT_MS : QUICK_TASK_TIMEOUT_MS;
}

function isStaleRunningTask(task: PreviewTaskCache, now = Date.now()) {
  if (task.status !== "running") return false;
  const lastActiveAt = task.updatedAt || task.createdAt;
  return now - lastActiveAt > getTaskTimeoutMs(task);
}

async function getRawPreviewTask() {
  return getStoredPreviewTask();
}

function createTaskController(taskId: string) {
  const currentController = runningTaskControllers.get(taskId);
  if (currentController) return currentController;

  const controller = new AbortController();
  runningTaskControllers.set(taskId, controller);
  return controller;
}

function abortPreviewTask(taskId?: string) {
  if (taskId) {
    runningTaskControllers.get(taskId)?.abort();
    runningTaskControllers.delete(taskId);
    return;
  }

  for (const controller of runningTaskControllers.values()) {
    controller.abort();
  }
  runningTaskControllers.clear();
}

export async function getPreviewTask() {
  const task = await getRawPreviewTask();
  if (task && task.whitelistFingerprint !== whitelistFingerprint(await getBookmarkWhitelist())) {
    await clearPreviewTask();
    return null;
  }
  if (!task || !isStaleRunningTask(task)) return task;

  const failedTask: PreviewTaskCache = {
    ...task,
    status: "failed",
    updatedAt: Date.now(),
    error: STALE_TASK_ERROR,
  };
  await savePreviewTask(failedTask);
  return failedTask;
}

async function completePreviewTask(
  bookmarks: BookmarkNode[],
  taskId: string,
  organizeMode: OrganizeMode,
  model?: string,
  signal?: AbortSignal
) {
  try {
    const previewResult = await generateMovePlanPreviewForBookmarks(bookmarks, organizeMode, {
      signal,
      model,
      progressStartedAt: Date.now(),
      onProgress: async (progress) => {
        const currentTask = await getRawPreviewTask();
        if (!isSameRunningTask(currentTask, taskId)) return;
        await savePreviewTask({
          ...currentTask,
          updatedAt: progress.updatedAt,
          progress,
        });
      },
    });
    const currentTask = await getRawPreviewTask();
    if (!isSameRunningTask(currentTask, taskId)) return;
    if (currentTask.whitelistFingerprint !== whitelistFingerprint(await getBookmarkWhitelist())) {
      await clearPreviewTask();
      return;
    }

    const completedTask: PreviewTaskCache = {
      ...currentTask,
      status: "completed",
      updatedAt: Date.now(),
      movePlan: previewResult.movePlans,
      tokenUsage: previewResult.tokenUsage,
    };

    await Promise.all([
      savePreviewTask(completedTask),
      savePreviewPlan({
        id: `preview-${Date.now()}`,
        createdAt: Date.now(),
        bookmarkCount: previewResult.movePlans.length,
        whitelistFingerprint: currentTask.whitelistFingerprint,
        organizeMode,
        model,
        movePlan: previewResult.movePlans,
        tokenUsage: previewResult.tokenUsage,
      }),
    ]);
  } catch (error) {
    const currentTask = await getRawPreviewTask();
    if (!isSameRunningTask(currentTask, taskId)) return;

    await savePreviewTask({
      ...currentTask,
      status: "failed",
      updatedAt: Date.now(),
      error: error instanceof Error ? error.message : "生成分类失败",
    });
  } finally {
    if (runningTaskControllers.get(taskId)?.signal === signal) {
      runningTaskControllers.delete(taskId);
    }
  }
}

async function getOrCreatePreviewTask(
  bookmarks: BookmarkNode[],
  organizeMode: OrganizeMode,
  model?: string
) {
  const existingTask = await getPreviewTask();
  if (existingTask?.status === "running") return { task: existingTask, created: false };

  const fingerprint = whitelistFingerprint(await getBookmarkWhitelist());
  const task = createRunningTask(bookmarks, organizeMode, model, fingerprint);
  await savePreviewTask(task);
  return { task, created: true };
}

export async function launchPreviewTask(bookmarks: BookmarkNode[]) {
  const { task, created } = await getOrCreatePreviewTask(bookmarks, "quick");
  if (!created) return task;

  const claimedTask = { ...task, executionOwner: "page" as const, updatedAt: Date.now() };
  await savePreviewTask(claimedTask);
  const controller = createTaskController(task.id);
  void completePreviewTask(bookmarks, task.id, "quick", undefined, controller.signal);
  return claimedTask;
}

function sendPreviewTaskMessage(message: PreviewTaskMessage) {
  return new Promise<PreviewTaskCache | null>((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: PreviewTaskResponse | undefined) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response?.task ?? null);
    });
  });
}

async function startTaskInPage(task: PreviewTaskCache, bookmarks: BookmarkNode[]) {
  const currentTask = await getRawPreviewTask();
  if (!isSameRunningTask(currentTask, task.id)) return currentTask;
  if (currentTask.executionOwner === "background") return currentTask;

  const claimedTask = { ...currentTask, executionOwner: "page" as const, updatedAt: Date.now() };
  await savePreviewTask(claimedTask);
  const controller = createTaskController(task.id);
  void completePreviewTask(
    bookmarks,
    task.id,
    task.organizeMode ?? "quick",
    task.model,
    controller.signal
  );
  return claimedTask;
}

async function sendRunMessage(task: PreviewTaskCache, bookmarks: BookmarkNode[]) {
  if (!hasRuntimeMessaging()) return startTaskInPage(task, bookmarks);

  try {
    return await sendPreviewTaskMessage({
      type: PREVIEW_TASK_MESSAGE,
      action: "run",
      taskId: task.id,
      bookmarks,
      organizeMode: task.organizeMode,
      model: task.model,
    });
  } catch {
    return startTaskInPage(task, bookmarks);
  }
}

export async function startPreviewTask(bookmarks: BookmarkNode[], organizeMode: OrganizeMode = "quick", model?: string) {
  const { task, created } = await getOrCreatePreviewTask(bookmarks, organizeMode, model);
  if (!created) {
    void sendRunMessage(task, bookmarks);
    return task;
  }

  return (await sendRunMessage(task, bookmarks)) ?? task;
}

export async function resumePreviewTask(task: PreviewTaskCache, bookmarks: BookmarkNode[]) {
  if (task.status !== "running") return task;
  return (await sendRunMessage(task, bookmarks)) ?? task;
}

export async function requestClearPreviewTask() {
  if (!hasRuntimeMessaging()) {
    abortPreviewTask();
    await clearPreviewTask();
    return null;
  }

  try {
    return await sendPreviewTaskMessage({
      type: PREVIEW_TASK_MESSAGE,
      action: "clear",
    });
  } catch {
    abortPreviewTask();
    await clearPreviewTask();
    return null;
  }
}

export function isPreviewTaskMessage(message: unknown): message is PreviewTaskMessage {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { type?: string }).type === PREVIEW_TASK_MESSAGE
  );
}

export async function handlePreviewTaskMessage(message: PreviewTaskMessage) {
  if (message.action === "run") {
    const currentTask = await getRawPreviewTask();
    if (!isSameRunningTask(currentTask, message.taskId)) return currentTask;
    if (currentTask.executionOwner === "page") return currentTask;
    if (currentTask.executionOwner === "background" && runningTaskControllers.has(message.taskId)) {
      return currentTask;
    }

    const claimedTask: PreviewTaskCache = {
      ...currentTask,
      executionOwner: "background",
      updatedAt: Date.now(),
    };
    await savePreviewTask(claimedTask);
    const controller = createTaskController(message.taskId);
    void completePreviewTask(
      message.bookmarks,
      message.taskId,
      message.organizeMode ?? claimedTask.organizeMode ?? "quick",
      message.model ?? claimedTask.model,
      controller.signal
    );
    return claimedTask;
  }
  if (message.action === "clear") {
    abortPreviewTask();
    await clearPreviewTask();
    return null;
  }
  return getPreviewTask();
}
