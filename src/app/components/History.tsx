import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { ArrowLeft, ExternalLink, TrendingUp, Clock, AlertCircle, Search, Globe2 } from "lucide-react";
import type { FrequentBookmark } from "../types";
import { getBookmarkFaviconUrl } from "../services/bookmarks";
import { getFrequentBookmarks, hasHistoryPermission, requestHistoryPermission } from "../services/history";
import { useAppStore } from "../store/useAppStore";
import { CollapsibleSection } from "./CollapsibleSection";

function HistoryFavicon({ title, url }: { title: string; url: string }) {
  const [failed, setFailed] = useState(false);
  const faviconUrl = !failed ? getBookmarkFaviconUrl(url) : "";

  return (
    <span className="extension-favicon" aria-hidden="true" title={title}>
      <Globe2 className="extension-favicon__fallback" />
      {faviconUrl && (
        <img
          src={faviconUrl}
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

export function History() {
  const { settings, loadSettings, saveSettings } = useAppStore();
  const [enabled, setEnabled] = useState(false);
  const [bookmarks, setBookmarks] = useState<FrequentBookmark[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    let alive = true;
    hasHistoryPermission().then((granted) => {
      if (!alive) return;
      setEnabled(settings.enableHistory && granted);
    });
    return () => {
      alive = false;
    };
  }, [settings.enableHistory]);

  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    getFrequentBookmarks()
      .then(setBookmarks)
      .finally(() => setLoading(false));
  }, [enabled]);

  const handleEnable = async () => {
    const granted = await requestHistoryPermission();
    if (!granted) {
      setMessage("未授予浏览历史权限");
      return;
    }
    await saveSettings({ ...settings, enableHistory: true });
    setEnabled(true);
  };

  const formatTime = (timestamp: number) => {
    const diff = Date.now() - timestamp;
    const hours = Math.floor(diff / 3600000);
    if (hours < 1) return "刚刚访问";
    if (hours < 24) return `${hours} 小时前`;
    return `${Math.floor(hours / 24)} 天前`;
  };

  const filteredBookmarks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return bookmarks;

    return bookmarks.filter((bookmark) =>
      [
        bookmark.title,
        bookmark.url,
        bookmark.currentFolder,
        bookmark.suggestedFolder,
      ]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(query))
    );
  }, [bookmarks, searchQuery]);

  const formatDomain = (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  };

  return (
    <div className="extension-page">
      <div className="extension-page__inner">
        <div className="extension-page__header">
          <div className="extension-page__heading">
            <Link to="/" className="extension-page__back" aria-label="返回">
              <ArrowLeft className="extension-page__back-icon" />
            </Link>
            <div>
              <h1 className="extension-page__title">常访问书签</h1>
              <p className="extension-page__subtitle">按本地访问频率整理</p>
            </div>
          </div>
        </div>

        {!enabled ? (
          <section className="extension-section extension-section--center">
            <AlertCircle className="extension-empty__icon extension-empty__icon--amber" />
            <h2>功能未启用</h2>
            <p>启用后可以查看您经常访问的已收藏网址，帮助更好地整理和管理。</p>
            <div className="extension-notice extension-notice--amber extension-notice--left">
              <p className="extension-notice__label">需要浏览历史权限</p>
              <ul className="extension-copy-list">
                <li>· 仅统计已收藏网址的访问次数</li>
                <li>· 浏览历史不会发送给 AI</li>
                <li>· 所有数据仅在本地处理</li>
              </ul>
            </div>
            {message && <p>{message}</p>}
            <button onClick={handleEnable} className="extension-page__wide-primary">
              启用功能
            </button>
          </section>
        ) : (
          <>
            <div className="extension-notice extension-notice--blue history-summary-notice">
              <p>{loading ? "正在统计本地访问记录..." : `根据访问记录，找到 ${bookmarks.length} 个经常访问的书签。`}</p>
            </div>

            <div className="extension-search-field">
              <Search className="extension-search-field__icon" />
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="搜索标题、网址或文件夹..."
                className="extension-control extension-control--search"
              />
            </div>

            <div className="history-card-list">
              {filteredBookmarks.length === 0 && !loading ? (
                <div className="extension-empty extension-empty--compact">
                  {searchQuery ? "未找到匹配的常访问书签" : "暂无常访问书签数据"}
                </div>
              ) : (
                filteredBookmarks.map((bookmark) => (
                  <article key={bookmark.id} className="history-card">
                    <div className="history-card__topline">
                      <div className="history-card__identity">
                        <HistoryFavicon title={bookmark.title} url={bookmark.url} />
                        <h3>{bookmark.title}</h3>
                      </div>
                      <a
                        href={bookmark.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="history-card__external"
                        aria-label="打开书签"
                      >
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>

                    <div className="history-card__summary">
                      <div className="history-card__meta">
                        <span>
                          <Clock className="w-3 h-3" />
                          {formatTime(bookmark.lastVisit)}
                        </span>
                        <span>
                          <TrendingUp className="w-3 h-3" />
                          {bookmark.visitCount} 次
                        </span>
                        <span>{formatDomain(bookmark.url)}</span>
                      </div>

                      <div className="history-card__tags">
                        {bookmark.currentFolder && <span className="history-tag history-tag--blue">{bookmark.currentFolder}</span>}
                        {bookmark.suggestedFolder && <span className="history-tag history-tag--amber">{bookmark.suggestedFolder}</span>}
                        {bookmark.confidence ? (
                          <span className="history-tag">置信度 {Math.round(bookmark.confidence * 100)}%</span>
                        ) : null}
                      </div>
                    </div>

                  </article>
                ))
              )}
            </div>

            <CollapsibleSection title="统计说明" hint="访问频率和整理建议的计算范围">
              <ul className="extension-copy-list">
                <li>· 仅统计已收藏网址的访问记录</li>
                <li>· 建议来自本地规则，不会自动移动书签</li>
              </ul>
            </CollapsibleSection>
          </>
        )}
      </div>
    </div>
  );
}
