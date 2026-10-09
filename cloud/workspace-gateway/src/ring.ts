// Keeps the most recent `capacity` bytes pushed into it.
export class RingBuffer {
  private chunks: Uint8Array[] = [];
  private size = 0;

  constructor(private readonly capacity: number) {}

  push(data: Uint8Array): void {
    const kept = data.length > this.capacity ? data.slice(data.length - this.capacity) : data.slice();
    this.chunks.push(kept);
    this.size += kept.length;
    while (this.size > this.capacity) {
      const excess = this.size - this.capacity;
      const head = this.chunks[0]!;
      if (head.length <= excess) {
        this.chunks.shift();
        this.size -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.size -= excess;
      }
    }
  }

  snapshot(): Uint8Array[] {
    return [...this.chunks];
  }
}
