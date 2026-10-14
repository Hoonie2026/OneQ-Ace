/** 시험용 문제팩 zip 생성기(검증기를 통과하는 최소 팩). vitest·Playwright 공용 */
import { zipSync } from 'fflate';

export interface FakeQ {
  hash: string; // contentHash 뒤 16자리를 만들 씨앗
  answer?: number;
  subjectNo?: number;
}

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const hex = async (b: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource)), (x) => x.toString(16).padStart(2, '0')).join('');
const pad3 = (n: number) => String(n).padStart(3, '0');

export async function hash16(seed: string): Promise<string> {
  return (await hex(new TextEncoder().encode(seed))).slice(0, 16);
}

/** 8×8 흰색 WebP — 브라우저가 실제로 그릴 수 있는 이미지 */
const WEBP_1PX = Uint8Array.from(
  atob('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoIAAgAAUAmJaQAA3AA/vz0AAA='),
  (c) => c.charCodeAt(0),
);

export async function makePack(opts: { code?: string; year?: number; round?: number; version?: number; questions: FakeQ[] }): Promise<Uint8Array> {
  const code = opts.code ?? 'TEST';
  const year = opts.year ?? 2022;
  const round = opts.round ?? 1;
  const packId = `${code}-${year}-${round}`;
  const subjectsUsed = [...new Set(opts.questions.map((q) => q.subjectNo ?? 1))].sort();
  const files: Record<string, Uint8Array> = {};
  const counters = new Map<number, number>();
  const questions = [];
  for (const [i, q] of opts.questions.entries()) {
    const s = q.subjectNo ?? 1;
    counters.set(s, (counters.get(s) ?? 0) + 1);
    const img = `images/${pad3(i + 1)}.webp`;
    files[img] = new Uint8Array([...WEBP_1PX]);
    questions.push({
      qid: `${packId}-${pad3(i + 1)}`,
      no: i + 1,
      subjectNo: s,
      noInSubject: counters.get(s)!,
      answer: q.answer ?? 1,
      choiceCount: 4,
      answerSource: 'answer-table',
      answerCheck: 'single',
      img,
      imgSize: [8, 8],
      text: `문항 ${q.hash}`,
      contentHash: `t:${await hash16(q.hash)}`,
      keywords: [],
      lawRefs: [],
      clusterId: null,
      flags: [],
    });
  }
  files['questions.json'] = enc(questions);
  const manifest = {
    format: 'oqp/1',
    packId,
    packVersion: opts.version ?? 1,
    cert: { code, name: '시험용 종목', grade: '기사' },
    exam: { year, round, date: `${year}-03-05` },
    subjects: subjectsUsed.map((no) => ({ no, name: `과목${no}`, count: counters.get(no)!, isLaw: false })),
    passRule: { subjectMin: 40, avgMin: 60 },
    questionCount: questions.length,
    source: { type: 'other', note: 'test' },
    preparedBy: 'test',
    reviewedAt: null,
    createdAt: '2026-10-14T00:00:00+00:00',
    generator: 'oneq-prep test',
    answerMasking: { method: ['none-needed'], masked: 0, leakCheck: 'passed' },
    files: await Promise.all(
      Object.entries(files).map(async ([path, b]) => ({ path, sha256: await hex(b), bytes: b.length })),
    ),
  };
  files['manifest.json'] = enc(manifest);
  return zipSync(files, { level: 0 });
}
