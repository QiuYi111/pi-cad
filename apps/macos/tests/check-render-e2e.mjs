import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
assert(root, 'render artifact directory required');
const report = JSON.parse(readFileSync(join(root, 'report.json'), 'utf8'));
assert.equal(report.completed, true, 'native render run did not finish');
assert.equal(report.server, 'local protocol fixture');
const expected = ['login-minimum', 'projects-minimum', 'settings-minimum', 'settings-full',
  'workbench-minimum', 'workbench-default', 'canvas-minimum', 'model-preview', 'analysis-form',
  'engineering-results', 'workflows-minimum', 'traces-minimum'];
assert.equal(new Set(report.screens.map(s => s.name)).size, report.screens.length, 'duplicate screenshot names');
for (const name of expected) assert(report.screens.some(s => s.name === name), `missing native screen ${name}`);
function dimensions(name) {
  const png = readFileSync(join(root, name + '.png'));
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'not a PNG');
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}
for (const screen of report.screens) {
  assert.deepEqual(screen.missing, [], `text hidden in ${screen.name}`);
  assert.deepEqual(screen.missingNavigation, [], `navigation wraps in ${screen.name}`);
  assert.deepEqual(dimensions(screen.name), [screen.pixelsWide, screen.pixelsHigh]);
  if (screen.name.endsWith('-minimum')) assert.deepEqual([screen.width, screen.height], [920, 620]);
  if (screen.scene.geometryNodes) {
    assert(screen.scene.contrastSamples > 20 && screen.scene.backgroundSamples > 200, 'blank model image');
    assert.deepEqual(dimensions(screen.name + '-scene'), [screen.scene.pixelsWide, screen.scene.pixelsHigh]);
  }
}
assert(report.screens.find(s => s.name === 'model-preview').scene.geometryNodes > 0);
console.log(`PASS: independent native artifact check (${report.screens.length} screens, actual PNG dimensions and SceneKit evidence)`);
