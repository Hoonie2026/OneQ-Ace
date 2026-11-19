/**
 * 이 기기 데이터 지우기·자격종목 삭제·문제팩 삭제(v0.7 — 삭제 통로를 설정 > 이 기기 데이터 지우기 한 곳으로).
 * DB 파일 자체를 지우지(Dexie.delete) 않고 표를 비운다: 같은 앱이 다른 창(설치 앱 + Chrome 탭)에서 열려 있으면
 * DB 삭제가 무기한 대기해 화면이 그대로 남는다(v0.1.2 실기기). 표 비우기는 막히지 않는다.
 */
import { db as defaultDb, safeWrite, SETTING, type OneQDB } from './db';

const RECORD_TABLES = (d: OneQDB) => [d.attempts, d.notes, d.cards, d.runs, d.orphans];

/** 학습 기록만 지운다(문제팩은 그대로). 백업 복원 시험·다시 시작할 때 */
export async function wipeRecords(d: OneQDB = defaultDb): Promise<void> {
  await safeWrite('학습 기록 지우기', () =>
    d.transaction('rw', [...RECORD_TABLES(d), d.settings], async () => {
      for (const t of RECORD_TABLES(d)) await t.clear();
      await d.settings.bulkDelete([SETTING.lastBackupAt, SETTING.attemptsAtLastBackup]);
    }),
  );
}

/** 문제팩과 학습 기록을 모두 지운다(기기 양도 등) */
export async function wipeAll(d: OneQDB = defaultDb): Promise<void> {
  await safeWrite('모두 지우기', () =>
    d.transaction('rw', [...RECORD_TABLES(d), d.settings, d.packs, d.questions, d.images], async () => {
      for (const t of [...RECORD_TABLES(d), d.settings, d.packs, d.questions, d.images]) await t.clear();
    }),
  );
}

/** 자격종목 하나를 통째로 지운다(합격 등으로 더 공부하지 않을 때): 그 종목의 문제팩과 학습 기록 */
export async function deleteCert(code: string, d: OneQDB = defaultDb): Promise<{ packs: number; attempts: number }> {
  let packs = 0;
  let attempts = 0;
  await safeWrite('자격종목 삭제', () =>
    d.transaction('rw', [...RECORD_TABLES(d), d.packs, d.questions, d.images, d.settings], async () => {
      const ids = (await d.packs.toArray()).filter((p) => p.manifest.cert.code === code).map((p) => p.packId);
      const mine = (qidOrPack: string) => qidOrPack.startsWith(`${code}-`);
      packs = ids.length;
      attempts = await d.attempts.filter((a) => mine(a.qid)).count();
      await d.attempts.filter((a) => mine(a.qid)).delete();
      await d.notes.filter((n) => mine(n.qid)).delete();
      await d.cards.filter((c) => mine(c.qid)).delete();
      await d.orphans.filter((o) => mine(o.packId)).delete();
      await d.runs.filter((r) => mine(r.packId)).delete();
      await d.questions.where('packId').anyOf(ids).delete();
      await d.images.where('packId').anyOf(ids).delete();
      await d.packs.bulkDelete(ids);
      if ((await d.settings.get(SETTING.certCode))?.value === code) await d.settings.delete(SETTING.certCode);
      await d.settings.delete(`plan:${code}`); // 종목별 시험일·학습시간(engine/load.ts planSettingKey)
      await d.settings.delete(`concepts:${code}`); // 유사 문항 군집 캐시(engine/load.ts, ADR 013)
    }),
  );
  return { packs, attempts };
}

const mineOf = (code: string) => (qidOrPack: string) => qidOrPack.startsWith(`${code}-`);

/** 한 종목의 학습 기록만 지운다(문제팩·학습 계획은 그대로). 다른 종목은 그대로 */
export async function wipeCertRecords(code: string, d: OneQDB = defaultDb): Promise<{ attempts: number }> {
  let attempts = 0;
  const mine = mineOf(code);
  await safeWrite('학습 기록 지우기', () =>
    d.transaction('rw', RECORD_TABLES(d), async () => {
      attempts = await d.attempts.filter((a) => mine(a.qid)).count();
      await d.attempts.filter((a) => mine(a.qid)).delete();
      await d.notes.filter((n) => mine(n.qid)).delete();
      await d.cards.filter((c) => mine(c.qid)).delete();
      await d.orphans.filter((o) => mine(o.packId)).delete();
      await d.runs.filter((r) => mine(r.packId)).delete();
    }),
  );
  return { attempts };
}

/**
 * 고른 문제팩과 **그 팩 문항의 학습 기록(풀이·메모)**을 함께 지운다(사용자 결정 v0.7 — 예전 개별 삭제는 기록을 '매핑 대기'로 보관했음).
 * 한 종목의 팩을 모두 고르면 종목 삭제와 같다(학습 계획까지 지움).
 * 오늘 학습·모의고사 묶음은 남은 팩의 문항만으로 열린다(loadSession). 지운 팩의 회독 묶음은 지운다.
 */
export async function deletePacks(packIds: string[], d: OneQDB = defaultDb): Promise<{ packs: number; attempts: number; certsGone: string[] }> {
  const rows = (await d.packs.bulkGet(packIds)).filter((p): p is NonNullable<typeof p> => !!p);
  const codes = [...new Set(rows.map((p) => p.manifest.cert.code))];
  const all = await d.packs.toArray();
  const certsGone = codes.filter((c) => all.filter((p) => p.manifest.cert.code === c).every((p) => packIds.includes(p.packId)));
  let attempts = 0;
  for (const c of certsGone) attempts += (await deleteCert(c, d)).attempts;
  const rest = rows.filter((p) => !certsGone.includes(p.manifest.cert.code)).map((p) => p.packId);
  if (rest.length) {
    await safeWrite('문제팩 삭제', () =>
      d.transaction('rw', [...RECORD_TABLES(d), d.packs, d.questions, d.images], async () => {
        const qids = (await d.questions.where('packId').anyOf(rest).primaryKeys()) as string[];
        const ids = (await d.attempts.where('qid').anyOf(qids).primaryKeys()) as number[];
        attempts += ids.length;
        await d.attempts.bulkDelete(ids);
        await d.notes.bulkDelete(qids);
        await d.cards.bulkDelete(qids);
        await d.orphans.where('packId').anyOf(rest).delete();
        await d.runs.where('packId').anyOf(rest).delete();
        await d.questions.where('packId').anyOf(rest).delete();
        await d.images.where('packId').anyOf(rest).delete();
        await d.packs.bulkDelete(rest);
      }),
    );
  }
  return { packs: rows.length, attempts, certsGone };
}
