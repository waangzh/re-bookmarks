(() => {
  const hostId = "remarks-floating-host";
  const openMessage = "remarks:open-floating-ui";
  const popupCandidates = ["popup/index.html", "dist/popup/index.html"];

  async function resolvePopupUrl() {
    for (const candidate of popupCandidates) {
      const url = chrome.runtime.getURL(candidate);
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (response.ok) return url;
      } catch {
        // Continue trying the next path. The extension can be loaded from either project root or dist.
      }
    }

    return chrome.runtime.getURL("popup/index.html");
  }

  function createFloatingUi() {
    const existing = document.getElementById(hostId);
    if (existing) return existing;

    const host = document.createElement("div");
    host.id = hostId;
    const shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        position: fixed;
        right: 18px;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      }

      .remarks-floating {
        display: none;
      }

      .remarks-floating.is-open {
        display: block;
      }

      .remarks-floating__panel {
        width: 360px;
        max-width: calc(100vw - 32px);
        height: 520px;
        max-height: calc(100vh - 36px);
        overflow: hidden;
        border: 1px solid rgba(148, 163, 184, 0.42);
        border-radius: 14px;
        background: #f8fafc;
        box-shadow: 0 24px 60px rgba(15, 23, 42, 0.24);
      }

      .remarks-floating__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: 42px;
        padding: 0 10px 0 14px;
        border-bottom: 1px solid rgba(226, 232, 240, 0.9);
        background: #ffffff;
        color: #0f172a;
        cursor: grab;
        user-select: none;
      }

      .remarks-floating__header:active {
        cursor: grabbing;
      }

      .remarks-floating__title {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font: 650 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      }

      .remarks-floating__mark {
        display: grid;
        place-items: center;
        width: 22px;
        height: 22px;
        border-radius: 7px;
        background: #2563eb;
        color: #ffffff;
        font-size: 12px;
      }

      .remarks-floating__close {
        display: grid;
        place-items: center;
        width: 28px;
        height: 28px;
        border: 0;
        border-radius: 7px;
        background: transparent;
        color: #64748b;
        cursor: pointer;
        font: 500 18px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      }

      .remarks-floating__close:hover {
        background: #f1f5f9;
        color: #0f172a;
      }

      .remarks-floating__iframe {
        width: 100%;
        height: calc(100% - 42px);
        border: 0;
        background: #f8fafc;
      }

      @media (max-width: 420px) {
        :host {
          right: 10px;
        }

        .remarks-floating__panel {
          width: calc(100vw - 20px);
          max-height: calc(100vh - 20px);
        }
      }
    `;

    const shell = document.createElement("div");
    shell.className = "remarks-floating";

    const panel = document.createElement("div");
    panel.className = "remarks-floating__panel";

    const header = document.createElement("div");
    header.className = "remarks-floating__header";

    const title = document.createElement("div");
    title.className = "remarks-floating__title";
    title.innerHTML = `<span class="remarks-floating__mark">R</span><span>ReMarks</span>`;

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "remarks-floating__close";
    closeButton.setAttribute("aria-label", "关闭 ReMarks");
    closeButton.textContent = "×";

    const iframe = document.createElement("iframe");
    iframe.className = "remarks-floating__iframe";
    iframe.title = "ReMarks";
    void resolvePopupUrl().then((url) => {
      iframe.src = url;
    });

    const setOpen = (open: boolean) => {
      shell.classList.toggle("is-open", open);
      if (open) {
        requestAnimationFrame(() => centerPanelVertically(host));
      }
    };

    closeButton.addEventListener("click", () => {
      setOpen(false);
    });

    enablePanelDrag(host, header, iframe);

    header.append(title, closeButton);
    panel.append(header, iframe);
    shell.append(panel);
    shadow.append(style, shell);
    document.documentElement.append(host);

    return host;
  }

  function centerPanelVertically(host: HTMLElement) {
    const rect = host.getBoundingClientRect();
    const margin = 8;
    const panelHeight = rect.height;
    const viewportHeight = window.innerHeight;

    // 计算垂直居中位置，确保不超出视口
    const idealTop = (viewportHeight - panelHeight) / 2;
    const top = Math.max(margin, Math.min(idealTop, viewportHeight - panelHeight - margin));

    host.style.top = `${top}px`;
    host.style.right = "18px";
    host.style.left = "auto";
    host.style.bottom = "auto";
  }

  function keepPanelInViewport(host: HTMLElement) {
    const rect = host.getBoundingClientRect();
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    const left = Math.min(Math.max(rect.left, margin), maxLeft);
    const top = Math.min(Math.max(rect.top, margin), maxTop);

    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    host.style.right = "auto";
    host.style.bottom = "auto";
  }

  function updatePanelHeight(host: HTMLElement, panel: HTMLElement, contentHeight: number) {
    const headerHeight = 42;
    const margin = window.innerWidth <= 420 ? 20 : 36;
    const minPanelHeight = 220;
    const maxPanelHeight = Math.max(minPanelHeight, window.innerHeight - margin);
    const nextHeight = Math.min(Math.max(Math.ceil(contentHeight) + headerHeight, minPanelHeight), maxPanelHeight);

    panel.style.height = `${nextHeight}px`;
    keepPanelInViewport(host);
  }

  function enablePanelDrag(host: HTMLElement, handle: HTMLElement, iframe: HTMLIFrameElement) {
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let dragging = false;

    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      const rect = host.getBoundingClientRect();
      const margin = 8;
      const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
      const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
      const nextLeft = Math.min(Math.max(startLeft + event.clientX - startX, margin), maxLeft);
      const nextTop = Math.min(Math.max(startTop + event.clientY - startY, margin), maxTop);

      host.style.left = `${nextLeft}px`;
      host.style.top = `${nextTop}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
    };

    const onPointerUp = () => {
      dragging = false;
      iframe.style.pointerEvents = "";
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    handle.addEventListener("pointerdown", (event) => {
      if (event.target instanceof HTMLButtonElement) return;
      const rect = host.getBoundingClientRect();
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      iframe.style.pointerEvents = "none";
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    });
  }

  const host = createFloatingUi();
  const shell = host.shadowRoot?.querySelector(".remarks-floating");
  const panel = host.shadowRoot?.querySelector(".remarks-floating__panel");
  const iframe = host.shadowRoot?.querySelector(".remarks-floating__iframe");

  window.addEventListener("message", (event) => {
    if (!(iframe instanceof HTMLIFrameElement) || event.source !== iframe.contentWindow) return;
    if (event.data?.type !== "remarks:resize" || typeof event.data.height !== "number") return;
    if (!(panel instanceof HTMLElement)) return;

    updatePanelHeight(host, panel, event.data.height);
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== openMessage || !(shell instanceof HTMLElement)) return;
    shell.classList.add("is-open");
    centerPanelVertically(host);
  });
})();
