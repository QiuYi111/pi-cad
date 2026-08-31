import type { Shapes } from "three-cad-viewer";
import type { MeshDocument, MeshPart } from "@shared/contracts";

function geometryData(part: MeshPart) {
  const normals = new Array(part.positions.length).fill(0);
  const faces: Array<[number, number, number]> = [];
  const adjacency = new Map<string, number[]>();
  for (let offset = 0; offset < part.indices.length; offset += 3) {
    const a = part.indices[offset]!, b = part.indices[offset + 1]!, c = part.indices[offset + 2]!;
    const ax = part.positions[a * 3]!, ay = part.positions[a * 3 + 1]!, az = part.positions[a * 3 + 2]!;
    const ux = part.positions[b * 3]! - ax, uy = part.positions[b * 3 + 1]! - ay, uz = part.positions[b * 3 + 2]! - az;
    const vx = part.positions[c * 3]! - ax, vy = part.positions[c * 3 + 1]! - ay, vz = part.positions[c * 3 + 2]! - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    const face: [number, number, number] = [nx / length, ny / length, nz / length];
    const faceIndex = faces.push(face) - 1;
    for (const vertex of [a, b, c]) { normals[vertex * 3] += nx; normals[vertex * 3 + 1] += ny; normals[vertex * 3 + 2] += nz; }
    for (const [from, to] of [[a, b], [b, c], [c, a]] as Array<[number, number]>) {
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      const entries = adjacency.get(key) ?? []; entries.push(faceIndex); adjacency.set(key, entries);
    }
  }
  for (let offset = 0; offset < normals.length; offset += 3) {
    const length = Math.hypot(normals[offset]!, normals[offset + 1]!, normals[offset + 2]!) || 1;
    normals[offset] /= length; normals[offset + 1] /= length; normals[offset + 2] /= length;
  }
  const edges: number[] = [];
  const crease = Math.cos(24 * Math.PI / 180);
  for (const [key, linked] of adjacency) {
    if (linked.length === 2) {
      const left = faces[linked[0]!]!, right = faces[linked[1]!]!;
      if (left[0] * right[0] + left[1] * right[1] + left[2] * right[2] >= crease) continue;
    }
    const [a, b] = key.split(":").map(Number);
    edges.push(...part.positions.slice(a! * 3, a! * 3 + 3), ...part.positions.slice(b! * 3, b! * 3 + 3));
  }
  return { normals, edges };
}

export function toThreeCadShapes(document: MeshDocument): Shapes {
  const rootName = document.source.split(/[\\/]/).at(-1) || "Model";
  return {
    version: 3, id: "/Model", name: rootName,
    parts: document.parts.map((part, index) => {
      const derived = geometryData(part);
      return {
        version: 3, id: `/Model/${index}-${part.name}`, name: part.name,
        type: "shapes" as const, subtype: "solid" as const, state: [1, 1] as const, color: part.color,
        alpha: 1, texture: null, renderback: false, accuracy: null,
        loc: [[0, 0, 0], [0, 0, 0, 1]] as const,
        shape: {
          vertices: part.positions, triangles: part.indices, normals: derived.normals, edges: derived.edges,
          obj_vertices: part.positions, face_types: new Array(part.indices.length / 3).fill(0),
          edge_types: new Array(derived.edges.length / 6).fill(0),
          triangles_per_face: new Array(part.indices.length / 3).fill(1),
          segments_per_edge: new Array(derived.edges.length / 6).fill(1),
        },
      };
    }),
    loc: [[0, 0, 0], [0, 0, 0, 1]] as const, normal_len: 0,
    bb: {
      xmin: document.bounds.min[0], ymin: document.bounds.min[1], zmin: document.bounds.min[2],
      xmax: document.bounds.max[0], ymax: document.bounds.max[1], zmax: document.bounds.max[2],
    },
  };
}
