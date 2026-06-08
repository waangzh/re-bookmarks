import type { BookmarkNode, OrganizeMode, PreviewTaskCache } from "../types";
import { generateMovePlanPreviewForBookmarks } from "./organizer";
import {
  clearPreviewTask,
  getPreviewTask as getStoredPreviewTask,
  savePreviewPlan,
  savePreviewTask,
} from "./storage";

export const PREVIEW_TASK_MESSAGE = "remarks:preview-task";
const QUICK_TASK_TIMEOUT_MS = 30 * 60 * 1000;
const DEEP_TASK_TIMEOUT_MS = 90 * 60 * 1000;
const STALLED_TASK_TIMEOUT_MS = 3 * 60 * 1000;
const STALE_TASK_ERROR = "上次生成任务已超时，请重新开始";
const runningTaskControllers = new Map<string, AbortController>();

type PreviewTaskMessage =
  | {
      type: typeof PREVIEW_TASK_MESSAGE;
      action: "run";
      taskId: string;
      bookmarks: BookmarkNode[];
      organizeMode?: OrganizeMode;
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

function createRunningTask(bookmarks: BookmarkNode[], organizeMode: OrganizeMode): PreviewTaskCache {
  const now = Date.now();
  return {
    id: `preview-task-${now}`,
    status: "running",
    createdAt: now,
    updatedAt: now,
    bookmarkCount: bookmarks.length,
    selectedBookmarkIds: bookmarks.map((bookmark) => bookmark.id),
    organizeMode,
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

function isSameRunningTask(task: PreviewTaskCache | null, taskId: string) {
  return task?.id === taskId && task.status === "running";
}

function getTaskTimeoutMs(task: PreviewTaskCache) {
  return task.organizeMode === "deep" ? DEEP_TASK_TIMEOUT_MS : QUICK_TASK_TIMEOUT_MS;
}

function isStaleRunningTask(task: PreviewTaskCache, now = Date.now()) {
  if (task.status !== "running") return false;
  const lastActiveAt = task.updatedAt || task.createdAt;
  return now - lastActiveAt > Math.min(getTaskTimeoutMs(task), STALLED_TASK_TIMEOUT_MS);
}

async function getRawPreviewTask() {
  return getStoredPreviewTask();
}

function createTaskController(taskId: string) {
  abortPreviewTask(taskId);
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
  signal?: AbortSignal
) {
  try {
    const previewResult = await generateMovePlanPreviewForBookmarks(bookmarks, organizeMode, {
      signal,
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
        organizeMode,
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

export async function launchPreviewTask(bookmarks: BookmarkNode[]) {
  const task = createRunningTask(bookmarks, "quick");
  await savePreviewTask(task);
  const controller = createTaskController(task.id);
  void completePreviewTask(bookmarks, task.id, "quick", controller.signal);
  return task;
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

export async function startPreviewTask(bookmarks: BookmarkNode[], organizeMode: OrganizeMode = "quick") {
  const task = createRunningTask(bookmarks, organizeMode);
  await savePreviewTask(task);

  if (!hasRuntimeMessaging()) {
    const controller = createTaskController(task.id);
    void completePreviewTask(bookmarks, task.id, organizeMode, controller.signal);
    return task;
  }

  chrome.runtime.sendMessage(
    {
      type: PREVIEW_TASK_MESSAGE,
      action: "run",
      taskId: task.id,
      bookmarks,
      organizeMode,
    },
    () => {
      if (chrome.runtime.lastError) {
        const controller = createTaskController(task.id);
        void completePreviewTask(bookmarks, task.id, organizeMode, controller.signal);
      }
    }
  );

  return task;
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
    const controller = createTaskController(message.taskId);
    await completePreviewTask(message.bookmarks, message.taskId, message.organizeMode ?? "quick", controller.signal);
    return getPreviewTask();
  }
  if (message.action === "clear") {
    abortPreviewTask();
    await clearPreviewTask();
    return null;
  }
  return getPreviewTask();
}
