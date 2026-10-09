// Trash retention in the gateway file layer (plan 5.2). No database: the gateway is a scripted fake.
import { describe, expect, it } from 'vitest';
import { createGatewayFs, trashEntryTime } from '../src/workspace/gateway.js';
import { FakeGateway } from './helpers/fakes.js';

const PROJECT = '0b8f1c52-7d3e-4a1b-9c2d-5e6f7a8b9c0d';
const stampOf = (iso: string) => new Date(iso).toISOString().replace(/[-:.]/g, '');

// Answers the directory listing and records every delete. Only the two argv shapes the code uses are scripted.
class ScriptedGateway extends FakeGateway {
  constructor(private readonly entries: string[] | null, private readonly failRm = false) {
    super();
  }
  readonly removed: string[] = [];

  override async exec(_userId: string, _name: string, args: string[]) {
    if (args[0] === 'sh') {
      const out = this.entries === null ? '' : this.entries.join('\n') + '\n';
      return { stdout: out, stderr: '', code: 0 };
    }
    if (args[0] === 'rm') {
      this.removed.push(args[args.length - 1]);
      return { stdout: '', stderr: this.failRm ? 'busy' : '', code: this.failRm ? 1 : 0 };
    }
    throw new Error(`unexpected argv ${args.join(' ')}`);
  }
}

describe('trash entry names', () => {
  it('reads the stamp that trashProject writes, with and without the -state suffix', () => {
    const at = '2026-10-09T05:12:34.123Z';
    expect(trashEntryTime(`${PROJECT}-${stampOf(at)}`)).toEqual(new Date(at));
    expect(trashEntryTime(`${PROJECT}-${stampOf(at)}-state`)).toEqual(new Date(at));
  });

  it('returns null for anything else, so such entries are never deleted', () => {
    for (const name of ['', '..', 'notes.txt', PROJECT, `${PROJECT}-2026-10-09`, `${PROJECT}-${stampOf('2026-10-09T00:00:00Z')}-x`]) {
      expect(trashEntryTime(name)).toBeNull();
    }
  });
});

describe('purgeTrash', () => {
  const cutoff = new Date('2026-09-09T00:00:00Z'); // 30 days before "now"

  it('deletes only recognised entries strictly older than the cutoff', async () => {
    const old = `${PROJECT}-${stampOf('2026-09-08T23:59:59.999Z')}`;
    const oldState = `${old}-state`;
    const atCutoff = `${PROJECT}-${stampOf('2026-09-09T00:00:00.000Z')}`;
    const recent = `${PROJECT}-${stampOf('2026-10-01T10:00:00Z')}`;
    const gw = new ScriptedGateway([old, oldState, atCutoff, recent, 'stray.txt']);

    const removed = await createGatewayFs(gw).purgeTrash('u1', 'ws-abc123', cutoff);

    expect(removed).toBe(2);
    expect(gw.removed).toEqual([`/workspace/.trash/${old}`, `/workspace/.trash/${oldState}`]);
  });

  it('does nothing when the trash folder is missing or empty', async () => {
    const none = new ScriptedGateway(null);
    expect(await createGatewayFs(none).purgeTrash('u1', 'ws-abc123', cutoff)).toBe(0);
    expect(none.removed).toEqual([]);
  });

  it('throws when a delete fails, so the controller logs it', async () => {
    const gw = new ScriptedGateway([`${PROJECT}-${stampOf('2026-01-01T00:00:00Z')}`], true);
    await expect(createGatewayFs(gw).purgeTrash('u1', 'ws-abc123', cutoff)).rejects.toThrow('purge trash failed');
  });
});
