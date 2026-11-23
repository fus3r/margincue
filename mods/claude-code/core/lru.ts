/** A small least-recently-used map: `get` refreshes, `set` evicts the oldest past `capacity`. */
export class Lru<V> {
  private readonly entries = new Map<string, V>()
  capacity: number

  constructor(capacity: number) {
    this.capacity = capacity
  }

  get(key: string): V | undefined {
    if (!this.entries.has(key)) return undefined
    const value = this.entries.get(key) as V
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  set(key: string, value: V): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > Math.max(0, this.capacity)) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}
