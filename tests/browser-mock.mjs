export function setupBrowser({ failBackup = false, failBackupAfter = Infinity, failMoveId, tree } = {}) {
  const bookmark = (id, title) => ({ id, parentId: "source", title, url: "https://" + id + ".test/", index: 0 });
  const currentTree = tree ?? [{ id: "0", title: "", children: [{ id: "root", parentId: "0", title: "书签栏", children: [
    { id: "dev", parentId: "root", title: "开发", children: [
      { id: "source", parentId: "dev", title: "资料", children: [bookmark("a", "中文资料"), bookmark("b", "工具文档")] },
      { id: "target", parentId: "dev", title: "工具", children: [] },
    ] },
  ] }] }];
  const values = {};
  const moves = [];
  let backupWrites = 0;
  const events = () => { const listeners = new Set(); return { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn), emit: (...args) => listeners.forEach((fn) => fn(...args)) }; };
  const find = (id, nodes = currentTree) => {
    for (const node of nodes) { if (node.id === id) return node; const child = find(id, node.children ?? []); if (child) return child; }
    return undefined;
  };
  const runtime = { lastError: undefined, getURL: (path) => "https://extension.test/" + path };
  const complete = (callback, error, result) => { runtime.lastError = error ? { message: error } : undefined; callback?.(result); runtime.lastError = undefined; };
  globalThis.chrome = {
    runtime,
    storage: { onChanged: events(), local: {
      get: (key, cb) => cb({ [key]: values[key] }),
      set: (data, cb) => { if (data["remarks.lastBackup"] && (failBackup || ++backupWrites > failBackupAfter)) return complete(cb, "备份写入失败"); Object.assign(values, structuredClone(data)); complete(cb); },
      remove: (key, cb) => { delete values[key]; complete(cb); },
    } },
    bookmarks: {
      onCreated: events(), onRemoved: events(), onChanged: events(), onMoved: events(),
      getTree: (cb) => cb(structuredClone(currentTree)),
      get: (id, cb) => cb(find(id) ? [structuredClone(find(id))] : []),
      getChildren: (id, cb) => cb(structuredClone(find(id)?.children ?? [])),
      create: (data, cb) => { const node = { id: "new-" + Date.now() + "-" + Math.random(), ...data, children: data.url ? undefined : [] }; find(data.parentId).children.push(node); complete(cb, null, structuredClone(node)); },
      move: (id, data, cb) => {
        if (id === failMoveId) return complete(cb, "模拟单项移动失败");
        const node = find(id); const parent = find(node?.parentId);
        if (!node || !find(data.parentId ?? node.parentId)) return complete(cb, "书签不存在");
        if (data.parentId && data.parentId !== node.parentId) moves.push(id);
        parent.children = parent.children.filter((item) => item.id !== id);
        node.parentId = data.parentId ?? node.parentId;
        find(node.parentId).children.splice(data.index ?? find(node.parentId).children.length, 0, node);
        complete(cb, null, structuredClone(node));
      },
      remove: (id, cb) => { const node = find(id); const parent = find(node?.parentId); if (parent) parent.children = parent.children.filter((item) => item.id !== id); complete(cb); },
      update: (id, data, cb) => { Object.assign(find(id), data); complete(cb, null, structuredClone(find(id))); },
    },
    permissions: { contains: (_data, cb) => cb(false) },
    tabs: { query: (_data, cb) => cb([{ title: "当前资料", url: "https://current.test/" }]) },
  };
  return { values, moves, find, tree: currentTree };
}
