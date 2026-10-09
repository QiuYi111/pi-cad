import WebSocket, { type RawData } from "ws";
import { decodeFrame, encodeFrame, type ClientMessage, type GatewayMessage } from "@reify/cloud-protocol";

// Minimal bridge client for tests: queues control messages and collects binary output per channel.
export class TestClient {
  private readonly messages: GatewayMessage[] = [];
  private readonly output = new Map<number, Buffer[]>();

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        const frame = decodeFrame(data as Buffer);
        this.output.set(frame.ch, [...(this.output.get(frame.ch) ?? []), Buffer.from(frame.data)]);
      } else {
        this.messages.push(JSON.parse(data.toString()) as GatewayMessage);
      }
    });
  }

  static connect(url: string, token: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { "x-reify-gateway-token": token } });
      ws.once("open", () => resolve(new TestClient(ws)));
      ws.once("unexpected-response", (_request, response) => reject(new Error(`HTTP ${response.statusCode}`)));
      ws.once("error", reject);
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  sendBytes(ch: number, data: Uint8Array | string): void {
    this.ws.send(encodeFrame(ch, typeof data === "string" ? Buffer.from(data) : data));
  }

  bytes(ch: number): string {
    return Buffer.concat(this.output.get(ch) ?? []).toString("utf8");
  }

  // Waits for the next control message of `type` (on channel `ch`, when given).
  async waitFor<K extends GatewayMessage["type"]>(type: K, ch?: number, timeoutMs = 5000): Promise<Extract<GatewayMessage, { type: K }>> {
    return poll(() => {
      const index = this.messages.findIndex((msg) => msg.type === type && (ch === undefined || ("ch" in msg && msg.ch === ch)));
      return index < 0 ? undefined : (this.messages.splice(index, 1)[0] as Extract<GatewayMessage, { type: K }>);
    }, timeoutMs, `${type} message`);
  }

  waitForExit(ch: number) {
    return this.waitFor("exit", ch);
  }

  async waitForBytes(ch: number, text: string, timeoutMs = 5000): Promise<void> {
    await poll(() => (this.bytes(ch).includes(text) ? true : undefined), timeoutMs, `bytes "${text}" on channel ${ch}`);
  }

  close(): void {
    this.ws.close();
  }
}

async function poll<T>(check: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
