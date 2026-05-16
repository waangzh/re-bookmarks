import type { BookmarkNode, PreviewTaskCache } from "../types";
import { generateMovePlanPreviewForBookmarks } from "./organizer";
import {
  clearPreviewTask,
  getPreviewTask,
  savePreviewPlan,
  savePreviewTask,
} from "./storage";

export const PREVIEW_TASK_MESSAGE = "remarks:preview-task";

type PreviewTaskMessage =
  | {
      type: typeof PREVIEW_TASK_MESSAGE;
      action: "run";
      taskId: string;
      bookmarks: BookmarkNode[];
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

function createRunningTask(bookmarks: BookmarkNode[]): PreviewTaskCache {
  const now = Date.now();
  return {
    id: `preview-task-${now}`,
    status: "running",
    createdAt: now,
    updatedAt: now,
    bookmarkCount: bookmarks.length,
    selectedBookmarkIds: bookmarks.map((bookmark) => bookmark.id),
  };
}

function isSameRunningTask(task: PreviewTaskCache | null, taskId: string) {
  return task?.id === taskId && task.status === "running";
}

async function completePreviewTask(bookmarks: BookmarkNode[], taskId: string) {
  try {
    const previewResult = await generateMovePlanPreviewForBookmarks(bookmarks);
    const currentTask = await getPreviewTask();
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
        movePlan: previewResult.movePlans,
        tokenUsage: previewResult.tokenUsage,
      }),
    ]);
  } catch (error) {
    const currentTask = await getPreviewTask();
    if (!isSameRunningTask(currentTask, taskId)) return;

    await savePreviewTask({
      ...currentTask,
      status: "failed",
      updatedAt: Date.now(),
      error: error instanceof Error ? error.message : "生成分类失败",
    });
  }
}

export async function launchPreviewTask(bookmarks: BookmarkNode[]) {
  const task = createRunningTask(bookmarks);
  await savePreviewTask(task);
  void completePreviewTask(bookmarks, task.id);
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

export async function startPreviewTask(bookmarks: BookmarkNode[]) {
  const task = createRunningTask(bookmarks);
  await savePreviewTask(task);

  if (!hasRuntimeMessaging()) {
    void completePreviewTask(bookmarks, task.id);
    return task;
  }

  chrome.runtime.sendMessage(
    {
      type: PREVIEW_TASK_MESSAGE,
      action: "run",
      taskId: task.id,
      bookmarks,
    },
    () => {
      if (chrome.runtime.lastError) {
        void completePreviewTask(bookmarks, task.id);
      }
    }
  );

  return task;
}

export async function requestClearPreviewTask() {
  if (!hasRuntimeMessaging()) {
    await clearPreviewTask();
    return null;
  }

  try {
    return await sendPreviewTaskMessage({
      type: PREVIEW_TASK_MESSAGE,
      action: "clear",
    });
  } catch {
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
    await completePreviewTask(message.bookmarks, message.taskId);
    return getPreviewTask();
  }
  if (message.action === "clear") {
    await clearPreviewTask();
    return null;
  }
  return getPreviewTask();
}

export { getPreviewTask };
