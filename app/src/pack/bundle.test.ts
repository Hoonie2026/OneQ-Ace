import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { unbundle } from './bundle';

describe('묶음 파일(ADR 021 8절)', () => {
  it('안의 팩 목록만 먼저 주고, 꺼낼 때 하나씩 푼다', async () => {
    const packA = zipSync({ 'manifest.json': strToU8('{"a":1}') });
    const packB = zipSync({ 'manifest.json': strToU8('{"b":2}') });
    const bundle = zipSync({ 'oneq-X-2020-2.zip': packB, 'oneq-X-2020-1.zip': packA }, { level: 0 });
    const entries = unbundle(bundle)!;
    expect(entries.map((e) => e.name)).toEqual(['oneq-X-2020-1.zip', 'oneq-X-2020-2.zip']);
    const b = new Uint8Array(await entries[1].load().arrayBuffer());
    expect(b).toEqual(packB);
  });

  it('문제팩 자체는 묶음이 아님', () => {
    expect(unbundle(zipSync({ 'manifest.json': strToU8('{}'), 'x.zip': new Uint8Array(1) }))).toBeNull();
  });
});
