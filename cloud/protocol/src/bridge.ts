// Bridge protocol between desktop / platform API (client) and the workspace gateway.
// One WebSocket, multiplexed by channel number. Text frames carry JSON control
// messages; binary frames carry data as [uint32 BE channel][payload].
//
// Binary frames have no control message of their own: stdin bytes go to the
// spawn bound to `ch`, file_put bytes go to the upload in progress on `ch`, and
// file_get bytes arrive on the channel that requested them. Spawn output uses
// `ch` for stdout and `ch + 1` for stderr.

export type ClientMessage =
  | { type: "exec"; ch: number; args: string[]; input?: string; timeoutMs?: number }
  | { type: "spawn"; ch: number; args: string[]; env?: Record<string, string>; cwd?: string }
  | { type: "stdin_end"; ch: number }
  | { type: "kill"; ch: number; signal?: string }
  | { type: "attach"; ch: number; spawnId: string }
  | { type: "file_get"; ch: number; path: string }
  | { type: "file_put_begin"; ch: number; path: string; size: number; sha256: string }
  | { type: "file_put_end"; ch: number }
  | { type: "ping" }
  | { type: "shutdown" };

export type GatewayMessage =
  | { type: "exec_result"; ch: number; stdout: string; stderr: string; code: number | null }
  | { type: "spawned"; ch: number; spawnId: string; pid: number | undefined }
  | { type: "exit"; ch: number; code: number | null; signal: string | null }
  | { type: "file_end"; ch: number; size: number; sha256: string }
  | { type: "file_put_done"; ch: number; path: string; size: number; sha256: string }
  | { type: "pong" }
  | { type: "error"; ch?: number; code: ErrorCode | string; message: string }
  | ActivityMessage;

export type ActivityReport = { active: boolean; reason: string };
export type ActivityMessage = { type: "activity" } & ActivityReport;

export type ErrorCode =
  | "bad_request"
  | "outside_workspace"
  | "read_only"
  | "not_found"
  | "no_such_spawn"
  | "channel_busy"
  | "checksum_mismatch"
  | "size_mismatch"
  | "failed";

export type Message = ClientMessage | GatewayMessage;

export const CHANNEL_HEADER_BYTES = 4;

export function encodeFrame(ch: number, data: Uint8Array): Uint8Array {
  if (!Number.isInteger(ch) || ch < 0 || ch > 0xffffffff) throw new RangeError(`invalid channel ${ch}`);
  const frame = new Uint8Array(CHANNEL_HEADER_BYTES + data.length);
  new DataView(frame.buffer).setUint32(0, ch, false);
  frame.set(data, CHANNEL_HEADER_BYTES);
  return frame;
}

export function decodeFrame(frame: Uint8Array): { ch: number; data: Uint8Array } {
  if (frame.length < CHANNEL_HEADER_BYTES) throw new RangeError("binary frame shorter than channel header");
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return { ch: view.getUint32(0, false), data: frame.subarray(CHANNEL_HEADER_BYTES) };
}
