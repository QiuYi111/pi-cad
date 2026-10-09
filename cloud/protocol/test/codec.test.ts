import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame } from "../src/index.js";

describe("binary frame codec", () => {
  it("round trips channel and payload", () => {
    const data = new Uint8Array([0, 1, 2, 255, 10]);
    const frame = encodeFrame(0x01020304, data);
    expect(frame.length).toBe(4 + data.length);
    expect([...frame.subarray(0, 4)]).toEqual([1, 2, 3, 4]);
    const decoded = decodeFrame(frame);
    expect(decoded.ch).toBe(0x01020304);
    expect([...decoded.data]).toEqual([...data]);
  });

  it("handles empty payloads and the largest channel", () => {
    const decoded = decodeFrame(encodeFrame(0xffffffff, new Uint8Array()));
    expect(decoded.ch).toBe(0xffffffff);
    expect(decoded.data.length).toBe(0);
  });

  it("rejects frames without a full header and invalid channels", () => {
    expect(() => decodeFrame(new Uint8Array([0, 0, 1]))).toThrow(RangeError);
    expect(() => encodeFrame(-1, new Uint8Array())).toThrow(RangeError);
    expect(() => encodeFrame(1.5, new Uint8Array())).toThrow(RangeError);
  });
});
