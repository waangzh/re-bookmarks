const queues = new Map<string, Promise<void>>();

// 页面与后台属于同一个扩展 origin；支持 Web Locks 时共享读改写锁。
// 不支持 Web Locks 的环境保留本实例串行化，不能宣称跨上下文原子性。
export function withStorageMutation<T>(name: string, mutation: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => globalThis.navigator?.locks?.request
    ? await globalThis.navigator.locks.request("remarks-storage-" + name, mutation)
    : await mutation();
  const operation = (queues.get(name) ?? Promise.resolve()).then(run);
  const tail = operation.then(() => undefined, () => undefined);
  queues.set(name, tail);
  void tail.then(() => { if (queues.get(name) === tail) queues.delete(name); });
  return operation;
}
