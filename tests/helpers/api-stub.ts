import { afterEach } from "node:test";

const activeRestores: Array<() => void> = [];

afterEach(() => {
  while (activeRestores.length) activeRestores.pop()?.();
});

export function captureApiSnapshot<T extends object>(api: T): () => void {
  const descriptors = Object.getOwnPropertyDescriptors(api);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    const index = activeRestores.indexOf(restore);
    if (index >= 0) activeRestores.splice(index, 1);
    for (const key of Reflect.ownKeys(api)) {
      if (!(key in descriptors)) Reflect.deleteProperty(api, key);
    }
    Object.defineProperties(api, descriptors);
  };
  activeRestores.push(restore);
  return restore;
}
