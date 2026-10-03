import { EventEmitter } from 'node:events';
import { JsonStore } from '../core/fileStore';

interface CollectionFile<T> {
  version: 1;
  items: T[];
}

/** An encrypted, persisted list of records with string ids (tasks, profiles). */
export class Collection<T extends { id: string }> extends EventEmitter {
  private readonly store: JsonStore<CollectionFile<T>>;

  constructor(path: string, normalizeItem: (raw: unknown) => T | null, onError: (message: string) => void) {
    super();
    this.store = new JsonStore<CollectionFile<T>>({
      path,
      defaults: () => ({ version: 1, items: [] }),
      encrypt: true,
      normalize: (raw) => {
        const items = raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)
          ? ((raw as { items: unknown[] }).items)
          : [];
        return { version: 1, items: items.map(normalizeItem).filter((item): item is T => item !== null) };
      },
      onError,
    });
  }

  list(): T[] {
    return this.store.get().items;
  }

  get(id: string): T | undefined {
    return this.store.get().items.find((item) => item.id === id);
  }

  insert(item: T): T {
    this.store.update((file) => ({ ...file, items: [...file.items, item] }));
    this.emit('changed', this.list());
    return item;
  }

  replace(item: T): T {
    this.store.update((file) => ({ ...file, items: file.items.map((it) => (it.id === item.id ? item : it)) }));
    this.emit('changed', this.list());
    return item;
  }

  remove(ids: string[]): number {
    const set = new Set(ids);
    const before = this.list().length;
    this.store.update((file) => ({ ...file, items: file.items.filter((it) => !set.has(it.id)) }));
    const removed = before - this.list().length;
    if (removed > 0) this.emit('changed', this.list());
    return removed;
  }

  flush(): void {
    this.store.flushSync();
  }
}
