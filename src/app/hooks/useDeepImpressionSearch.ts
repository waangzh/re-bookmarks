import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BookmarkImpressionMeta,
  DeepSearchStage,
  ImpressionSearchResult,
  SearchableBookmark,
} from "../types";
import { runDeepImpressionSearch } from "../services/aiImpressionSearch";

export type DeepImpressionSearchState = {
  /** 本次深度搜索对应的搜索词，用于判断结果是否仍然对应当前输入 */
  query: string;
  stage: DeepSearchStage;
  expandedTerms: string[];
  /** null 表示当前搜索词还没有执行过深度搜索 */
  results: ImpressionSearchResult[] | null;
  /** true 表示结果已经过 Stage 3 精排 */
  reranked: boolean;
  error: string;
};

const IDLE_STATE: DeepImpressionSearchState = {
  query: "",
  stage: "idle",
  expandedTerms: [],
  results: null,
  reranked: false,
  error: "",
};

type Options = {
  bookmarks: SearchableBookmark[];
  semanticIndexMap: Record<string, BookmarkImpressionMeta>;
  existingTopFolders: string[];
};

/**
 * 搜索框共用的深度搜索状态机：负责 AbortController 生命周期、
 * 两阶段渐进式结果与卸载清理。组件只关心渲染。
 */
export function useDeepImpressionSearch(options: Options) {
  const [state, setState] = useState<DeepImpressionSearchState>(IDLE_STATE);
  const abortRef = useRef<AbortController | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    // abort 后不会再有 onStageChange 回调，这里主动结束进行中状态。
    setState((current) => current.stage === "expanding" || current.stage === "expanded_shown"
      ? { ...current, stage: "idle" }
      : current);
  }, []);

  const reset = useCallback(() => {
    cancel();
    setState(IDLE_STATE);
  }, [cancel]);

  const run = useCallback((rawQuery: string) => {
    const query = rawQuery.trim();
    if (!query) return;
    // 新搜索立即取消上一次请求，避免旧结果覆盖新列表。
    cancel();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ query, stage: "expanding", expandedTerms: [], results: null, reranked: false, error: "" });

    const isCurrent = () => abortRef.current === controller && !controller.signal.aborted;

    void runDeepImpressionSearch({
      query,
      bookmarks: optionsRef.current.bookmarks,
      semanticIndexMap: optionsRef.current.semanticIndexMap,
      existingTopFolders: optionsRef.current.existingTopFolders,
      signal: controller.signal,
      callbacks: {
        onStageChange: (stage, expandedTerms) => {
          if (!isCurrent()) return;
          setState((current) => ({
            ...current,
            stage,
            expandedTerms: expandedTerms ?? current.expandedTerms,
          }));
        },
        onResultsUpdate: (results, isFinalReranked) => {
          if (!isCurrent()) return;
          setState((current) => ({ ...current, results, reranked: isFinalReranked }));
        },
        onError: (message) => {
          if (!isCurrent()) return;
          setState((current) => ({ ...current, error: message }));
        },
      },
    }).finally(() => {
      if (abortRef.current === controller) abortRef.current = null;
    });
  }, [cancel]);

  // 搜索词被清空或组件卸载时，中止仍在进行的请求。
  useEffect(() => () => cancel(), [cancel]);

  return {
    state,
    run,
    cancel,
    reset,
    /** 当前搜索词是否已有进行中或已完成的深度搜索结果 */
    hasResult: state.results !== null,
    running: state.stage === "expanding" || state.stage === "expanded_shown",
  };
}
