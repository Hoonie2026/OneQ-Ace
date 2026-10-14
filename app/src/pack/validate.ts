/**
 * 문제팩 검증기 (TS). preprocessor/oneq_prep/validate.py와 같은 규칙·같은 오류 코드를 쓴다.
 * 공용 시험: shared/fixtures/cases.json (validate.test.ts)
 */
import { unzipSync } from 'fflate';
import schema from '../../../shared/pack-schema.json';
import { validateSchema, type Schema } from './miniSchema';

export type IssueCode =
  | 'ZIP' | 'JSON' | 'SCHEMA' | 'MISSING_FILE' | 'HASH_MISMATCH' | 'EXTRA_FILE' | 'LEAK_CHECK'
  | 'PACK_ID' | 'COUNT_MISMATCH' | 'DUP_QID' | 'QID_FORMAT' | 'ANSWER_RANGE' | 'NUMBERING' | 'SUBJECT';

export interface Issue { code: IssueCode; message: string }

export interface PackManifest {
  format: 'oqp/1';
  packId: string;
  packVersion: number;
  cert: { code: string; name: string; grade: string };
  exam: { year: number; round: number; roundLabel?: string; date: string };
  subjects: { no: number; name: string; count: number; isLaw: boolean }[];
  passRule: { subjectMin: number; avgMin: number };
  questionCount: number;
  source: { type: 'public-pbt' | 'recalled' | 'other'; origin?: string; note?: string };
  preparedBy: string;
  reviewedAt?: string | null;
  createdAt: string;
  generator: string;
  answerMasking: { method: string[]; masked: number; leakCheck: 'passed' | 'failed' };
  files: { path: string; sha256: string; bytes: number }[];
}

export interface PackQuestion {
  qid: string;
  no: number;
  subjectNo: number;
  noInSubject: number;
  answer: number;
  acceptAlso?: number[];
  choiceCount: number;
  answerSource: 'inline-mark' | 'answer-table' | 'manual';
  answerCheck: 'agree' | 'single' | 'corrected';
  img: string;
  imgSize: [number, number];
  text: string;
  contentHash: string;
  keywords: string[];
  lawRefs: string[];
  clusterId: string | null;
  flags: string[];
}

export interface ValidResult {
  ok: true;
  manifest: PackManifest;
  questions: PackQuestion[];
  files: Record<string, Uint8Array>;
}
export interface InvalidResult { ok: false; issues: Issue[] }

const ROOT = schema as unknown as Schema;
const pad3 = (n: number) => String(n).padStart(3, '0');

async function sha256Hex(b: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', b as BufferSource);
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
}

export async function validateFiles(files: Record<string, Uint8Array>): Promise<ValidResult | InvalidResult> {
  const issues: Issue[] = [];
  const add = (code: IssueCode, message: string) => issues.push({ code, message });

  for (const n of ['manifest.json', 'questions.json']) if (!files[n]) add('MISSING_FILE', `${n} 없음`);
  if (issues.length) return { ok: false, issues };

  let manifest: PackManifest;
  let questions: PackQuestion[];
  try {
    const dec = new TextDecoder('utf-8', { fatal: true });
    manifest = JSON.parse(dec.decode(files['manifest.json']));
    questions = JSON.parse(dec.decode(files['questions.json']));
  } catch (e) {
    return { ok: false, issues: [{ code: 'JSON', message: `JSON 해석 실패: ${String(e)}` }] };
  }

  for (const [label, data, def] of [['manifest', manifest, 'manifest'], ['questions', questions, 'questions']] as const) {
    for (const m of validateSchema(ROOT, { $ref: `#/$defs/${def}` }, data)) add('SCHEMA', `${label}${m}`);
  }
  if (issues.length) return { ok: false, issues };

  // ── 정합성 ──
  if (manifest.answerMasking.leakCheck !== 'passed') add('LEAK_CHECK', '정답 표시 제거 검사를 통과하지 못한 팩');

  const listed = new Map(manifest.files.map((f) => [f.path, f]));
  for (const [path, f] of listed) {
    const b = files[path];
    if (!b) add('MISSING_FILE', `${path} 없음`);
    else if (b.length !== f.bytes || (await sha256Hex(b)) !== f.sha256) add('HASH_MISMATCH', `${path} 해시·크기 불일치`);
  }
  if (!listed.has('questions.json')) add('MISSING_FILE', 'manifest.files에 questions.json 없음');
  for (const path of Object.keys(files)) {
    if (path !== 'manifest.json' && !listed.has(path) && !path.endsWith('/')) add('EXTRA_FILE', `목록에 없는 파일: ${path}`);
  }

  const pid = manifest.packId;
  const exp = `${manifest.cert.code}-${manifest.exam.year}-${manifest.exam.round}`;
  if (pid !== exp) add('PACK_ID', `packId ${pid} ≠ 종목-연도-회차 ${exp}`);
  if (questions.length !== manifest.questionCount) {
    add('COUNT_MISMATCH', `문항 ${questions.length}개 ≠ questionCount ${manifest.questionCount}`);
  }

  const seen = new Set<string>();
  for (const q of questions) {
    if (seen.has(q.qid)) add('DUP_QID', `qid 중복: ${q.qid}`);
    seen.add(q.qid);
    if (q.qid !== `${pid}-${pad3(q.no)}`) add('QID_FORMAT', `${q.qid} ≠ ${pid}-${pad3(q.no)}`);
    if (q.answer > q.choiceCount || (q.acceptAlso ?? []).some((a) => a > q.choiceCount || a === q.answer)) {
      add('ANSWER_RANGE', `${q.qid}: 정답 번호가 보기 수를 벗어나거나 중복`);
    }
    if (!listed.has(q.img)) add('MISSING_FILE', `${q.qid}: 이미지 ${q.img}가 manifest.files에 없음`);
  }
  if (!questions.every((q, i) => q.no === i + 1)) add('NUMBERING', '문항번호가 1부터 연속하지 않음');

  const subj = new Map(manifest.subjects.map((s) => [s.no, s]));
  const counts = new Map<number, number[]>();
  for (const q of questions) {
    if (!subj.has(q.subjectNo)) add('SUBJECT', `${q.qid}: 없는 과목 ${q.subjectNo}`);
    counts.set(q.subjectNo, [...(counts.get(q.subjectNo) ?? []), q.noInSubject]);
  }
  for (const [no, s] of subj) {
    const got = counts.get(no) ?? [];
    if (got.length !== s.count) add('SUBJECT', `${no}과목 문항 수 ${got.length} ≠ ${s.count}`);
    else if (!got.every((n, i) => n === i + 1)) add('NUMBERING', `${no}과목 과목 내 번호가 연속하지 않음`);
  }

  return issues.length ? { ok: false, issues } : { ok: true, manifest, questions, files };
}

/** 팩 zip 바이트를 풀어 검사한다. 학습앱의 팩 가져오기는 이 함수를 통과한 팩만 저장한다. */
export async function validatePackZip(data: Uint8Array): Promise<ValidResult | InvalidResult> {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data);
  } catch {
    return { ok: false, issues: [{ code: 'ZIP', message: 'zip 파일이 아님' }] };
  }
  for (const k of Object.keys(files)) if (k.endsWith('/')) delete files[k];
  return validateFiles(files);
}
