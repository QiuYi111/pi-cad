// Validate the CAD bytes exported through the native save dialog.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const [stepPath, stlPath] = process.argv.slice(2);
assert(stepPath && stlPath, 'Usage: node check-cloud-files.mjs <STEP> <STL>');
const step = await readFile(stepPath), stl = await readFile(stlPath);
assert(step.toString('utf8').includes('ISO-10303-21;'), 'STEP header missing');
assert(step.toString('utf8').includes('END-ISO-10303-21;'), 'STEP is incomplete');
assert(step.length > 1000, 'STEP contains no useful model');
const vertices = [];
if (stl.length >= 84 && stl.length === 84 + stl.readUInt32LE(80) * 50) {
  for (let i = 0; i < stl.readUInt32LE(80); i++) {
    for (let j = 0; j < 3; j++) {
      const offset = 84 + i * 50 + 12 + j * 12;
      vertices.push([0, 4, 8].map(k => stl.readFloatLE(offset + k)));
    }
  }
} else {
  for (const line of stl.toString('utf8').split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === 'vertex') vertices.push(fields.slice(1).map(Number));
  }
}
assert(vertices.length >= 36 && vertices.length % 3 === 0, 'STL triangles missing');
assert(vertices.every(v => v.length === 3 && v.every(Number.isFinite)), 'STL coordinates invalid');
const dimensions = [0, 1, 2].map(axis => Math.max(...vertices.map(v => v[axis])) - Math.min(...vertices.map(v => v[axis])));
for (let i = 0; i < 3; i++) assert(Math.abs(dimensions[i] - [20, 10, 5][i]) < 0.001, 'Wrong model dimensions: ' + dimensions);
let signedVolume = 0;
for (let i = 0; i < vertices.length; i += 3) {
  const [a, b, c] = vertices.slice(i, i + 3);
  signedVolume += (a[0] * (b[1]*c[2]-b[2]*c[1]) + a[1] * (b[2]*c[0]-b[0]*c[2]) + a[2] * (b[0]*c[1]-b[1]*c[0])) / 6;
}
const volume = Math.abs(signedVolume);
assert(Math.abs(volume - 1000) < 0.01, 'Wrong model volume: ' + volume);
const summary = (path, bytes) => ({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
console.log(JSON.stringify({ result: 'PASS', dimensions, volume, triangles: vertices.length / 3, step: summary(stepPath, step), stl: summary(stlPath, stl) }, null, 2));
