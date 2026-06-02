import type { BookmarkForAI, BookmarkNode } from "../types";

const METADATA_FETCH_CONCURRENCY = 4;
const METADATA_FETCH_TIMEOUT_MS = 6000;
const METADATA_MAX_BYTES = 128 * 1024;

type PageMetadata = NonNullable<BookmarkForAI["metadata"]>;

function unavailable(reason: string, httpStatus?: number, finalUrl?: string): PageMetadata {
  return {
    available: false,
    reason,
    httpStatus,
    finalUrl,
  };
}

function isHttpUrl(url?: string) {
  return Boolean(url && /^https?:\/\//i.test(url));
}

function isHtmlContentType(contentType: string | null) {
  if (!contentType) return true;
  return /(?:text\/html|application\/xhtml\+xml)/i.test(contentType);
}

function cleanText(value: string | null | undefined, maxLength = 240) {
  return value?.replace(/\s+/g, " ").trim().slice(0, maxLength) || undefined;
}

function decodeHtmlEntities(value: string) {
  const namedEntities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " ",
  };

  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) {
      const codePoint = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (lower.startsWith("#")) {
      const codePoint = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return namedEntities[lower] ?? match;
  });
}

function extractAttribute(tag: string, name: string) {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return decodeHtmlEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

function extractTitle(html: string) {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return cleanText(match?.[1] ? decodeHtmlEntities(match[1].replace(/<[^>]*>/g, "")) : undefined);
}

function extractMetaContent(html: string, attributeName: "name" | "property", attributeValue: string) {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  const lowerValue = attributeValue.toLowerCase();

  for (const tag of metaTags) {
    if (extractAttribute(tag, attributeName).toLowerCase() !== lowerValue) continue;
    const content = cleanText(decodeHtmlEntities(extractAttribute(tag, "content")));
    if (content) return content;
  }

  return undefined;
}

function isLikelyLoginPage(metadata: PageMetadata) {
  const text = [
    metadata.finalUrl,
    metadata.title,
    metadata.ogTitle,
    metadata.description,
    metadata.ogDescription,
  ].filter(Boolean).join(" ").toLowerCase();

  return /(?:\/login|\/signin|\/auth|sign in|log in|login|account)/i.test(text);
}

async function readResponsePrefix(response: Response) {
  if (!response.body?.getReader) {
    return (await response.text()).slice(0, METADATA_MAX_BYTES);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let html = "";

  try {
    while (received < METADATA_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;

      received += value.byteLength;
      html += decoder.decode(value, { stream: true });

      if (received >= METADATA_MAX_BYTES) {
        await reader.cancel();
        break;
      }
    }

    html += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  return html;
}

async function fetchOneMetadata(bookmark: Pick<BookmarkNode, "url">): Promise<PageMetadata> {
  if (!isHttpUrl(bookmark.url)) return unavailable("metadata: only http/https pages are supported");

  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), METADATA_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(bookmark.url ?? "", {
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });
    const finalUrl = response.url && response.url !== bookmark.url ? response.url : undefined;

    if (!response.ok) {
      return unavailable(`HTTP ${response.status}`, response.status, finalUrl);
    }

    if (!isHtmlContentType(response.headers.get("content-type"))) {
      return unavailable("metadata: non-HTML page", response.status, finalUrl);
    }

    const html = await readResponsePrefix(response);
    if (!html.trim()) return unavailable("metadata: empty page content", response.status, finalUrl);

    const metadata: PageMetadata = {
      available: true,
      title: extractTitle(html),
      description: extractMetaContent(html, "name", "description"),
      ogTitle: extractMetaContent(html, "property", "og:title"),
      ogDescription: extractMetaContent(html, "property", "og:description"),
      ogSiteName: extractMetaContent(html, "property", "og:site_name"),
      finalUrl,
      httpStatus: response.status,
    };

    const hasMeaningfulMetadata = Boolean(
      metadata.title ||
      metadata.description ||
      metadata.ogTitle ||
      metadata.ogDescription ||
      metadata.ogSiteName
    );
    if (!hasMeaningfulMetadata) return unavailable("metadata: no useful page metadata found", response.status, finalUrl);
    if (isLikelyLoginPage(metadata)) return unavailable("metadata: login page or authenticated content", response.status, finalUrl);

    return metadata;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return unavailable("metadata: fetch timeout");
    }
    return unavailable(error instanceof Error && error.message ? error.message : "metadata: fetch failed");
  } finally {
    globalThis.clearTimeout(timer);
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
) {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker())
  );

  return results;
}

export async function enrichBookmarksWithPageMetadata<T extends BookmarkForAI>(
  bookmarks: T[],
  sourceBookmarks: Array<Pick<BookmarkNode, "id" | "url">>
) {
  const sourceById = new Map(sourceBookmarks.map((bookmark) => [bookmark.id, bookmark]));

  return mapWithConcurrency(bookmarks, METADATA_FETCH_CONCURRENCY, async (bookmark) => ({
    ...bookmark,
    metadata: await fetchOneMetadata(sourceById.get(bookmark.id) ?? {}),
  }));
}
