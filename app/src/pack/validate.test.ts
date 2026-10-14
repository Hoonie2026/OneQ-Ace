import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { validateFiles, validatePackZip } from './validate';

const FIX = resolve(__dirname, '../../../shared/fixtures');

type Op = { op: string; file: string; pointer?: string; value?: unknown; text?: string };
type Case = { name: string; ops: Op[]; expect: string[]; rehash?: boolean };

function loadValid(): Record<string, Uint8Array> {
  const root = join(FIX, 'valid-pack');
  const out: Record<string, Uint8Array> = {};
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(root, p).split(sep).join('/')] = new Uint8Array(readFileSync(p));
    }
  };
  walk(root);
  return out;
}

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o, null, 1));
const dec = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));

// preprocessor/tests/fixture_ops.py 와 같은 규칙
function applyCase(src: Record<string, Uint8Array>, c: Case): Record<string, Uint8Array> {
  const files = { ...src };
  const edited = new Set<string>();
  for (const op of c.ops) {
    if (op.op === 'set' || op.op === 'delete') {
      const doc = dec(files[op.file]);
      const parts = op.pointer!.split('/').slice(1);
      let cur: any = doc;
      for (const p of parts.slice(0, -1)) cur = cur[Array.isArray(cur) ? Number(p) : p];
      const last = parts[parts.length - 1];
      const key = Array.isArray(cur) ? Number(last) : last;
      if (op.op === 'set') cur[key] = structuredClone(op.value);
      else if (Array.isArray(cur)) cur.splice(key as number, 1);
      else delete cur[key];
      files[op.file] = enc(doc);
      edited.add(op.file);
    } else if (op.op === 'removeFile') delete files[op.file];
    else if (op.op === 'addFile' || op.op === 'replaceText') files[op.file] = new TextEncoder().encode(op.text!);
    else if (op.op === 'corrupt') files[op.file] = new Uint8Array([...files[op.file], 0]);
    else throw new Error(op.op);
  }
  edited.delete('manifest.json');
  if (c.rehash !== false && edited.size && files['manifest.json']) {
    const m = dec(files['manifest.json']);
    for (const e of m.files ?? []) {
      if (edited.has(e.path)) {
        e.sha256 = createHash('sha256').update(files[e.path]).digest('hex');
        e.bytes = files[e.path].length;
      }
    }
    files['manifest.json'] = enc(m);
  }
  return files;
}

const cases: Case[] = JSON.parse(readFileSync(join(FIX, 'cases.json'), 'utf-8')).cases;

describe('공용 검증 시험(shared/fixtures/cases.json)', () => {
  for (const c of cases) {
    it(c.name, async () => {
      const r = await validateFiles(applyCase(loadValid(), c));
      const codes = r.ok ? [] : [...new Set(r.issues.map((i) => i.code))].sort();
      expect(codes, r.ok ? '' : JSON.stringify(r.issues)).toEqual([...c.expect].sort());
    });
  }
});

describe('zip 입력', () => {
  it('정상 팩 zip을 통과시킨다', async () => {
    const r = await validatePackZip(zipSync(loadValid()));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.questions).toHaveLength(3);
  });
  it('zip이 아니면 ZIP 오류', async () => {
    const r = await validatePackZip(new TextEncoder().encode('not a zip'));
    expect(r.ok ? [] : r.issues.map((i) => i.code)).toEqual(['ZIP']);
  });
  // 실제 기출 샘플팩(저장소에 커밋하지 않음)이 있으면 함께 검사
  const real = process.env.ONEQ_SAMPLE_PACK;
  it.skipIf(!real || !existsSync(real))('실제 샘플팩', async () => {
    const r = await validatePackZip(new Uint8Array(readFileSync(real!)));
    expect(r.ok ? [] : r.issues).toEqual([]);
  });
});
