import { readFile } from "node:fs/promises";

export async function imageContent(
  path: string,
): Promise<{ type: "image"; data: string; mimeType: string }> {
  const data = await readFile(path);
  const mimeType = detectImageMimeType(data);
  if (!mimeType) throw new Error(`unsupported image encoding: ${path}`);
  return { type: "image", data: data.toString("base64"), mimeType };
}

export function detectImageMimeType(data: Buffer): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export async function readImageContents(
  paths: string[],
): Promise<Array<{ type: "image"; data: string; mimeType: string }>> {
  return Promise.all(paths.map((path) => imageContent(path)));
}

