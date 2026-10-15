/**
 * 이 기기 데이터 지우기·자격종목 삭제.
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
    }),
  );
  return { packs, attempts };
}
