import { useEffect, useRef, useState } from 'react';
import { EXTRA_SIZE, type Coach, type SubjectView } from '../coach';
import { Icon } from './Icon';

/** 마우스를 올릴 수 있는 기기(PC)인가 — 안내 한 줄의 낱말만 바꾼다(동작은 마우스·손가락·펜 모두 받는다) */
const canHover = () => typeof window !== 'undefined' && !!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;

/**
 * 과목별 학습(ADR 011 → v0.11 ADR 020): 과목마다 현재 점수 → 시험일 예상 점수 막대와 [학습하기].
 * v0.11(실기기 의견 — "화면이 너무 난잡"): 화면 위 안내문 두 문단을 없애고, **막대에 마우스를 올리면(PC) / 막대를 누르면(폰·태블릿·펜)**
 * 그 과목의 안내창을 띄운다. 한 번에 하나만 열리고, 바깥을 누르거나 Esc로 닫는다.
 * 현재 점수 = 그 과목에서 푼 문항 중 최근 답이 정답인 비율(같은 문항은 1번, 회독 미반영 — ADR 020)
 */
export function SubjectList(props: { coach: Coach; busy: boolean; onStudy: (subjectKey: string) => void }) {
  const { coach } = props;
  const rule = coach.settings?.passRule ?? { subjectMin: 40, avgMin: 60 };
  // 한 묶음 = 오늘 남은 목표 문항 수(시스템 추천과 같음 — v0.7.2). 목표를 채웠으면 추가 15
  const per = coach.today.extra ? EXTRA_SIZE : Math.max(1, coach.today.target - coach.doneToday);
  const tone = (v: number) => (v < rule.subjectMin ? 'bad' : v < rule.avgMin ? 'warn' : 'ok');
  const [open, setOpen] = useState<string | null>(null);
  const pointer = useRef<string>('mouse');
  const listRef = useRef<HTMLUListElement>(null);

  // 바깥을 누르면 닫기, Esc로 닫기
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el?.closest(`[data-tip="${open}"]`)) setOpen(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
    };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  return (
    <>
      <p className="hint subject-tip-hint" data-testid="subject-hint">
        <Icon name="info" size={16} /> {canHover() ? '막대에 마우스를 올리면' : '막대를 누르면'} 점수 설명이 나옵니다
      </p>
      <ul className="subjects" data-testid="subject-list" ref={listRef}>
        {coach.subjects.map((s) => {
          const proj = s.examProjected;
          const { relearn, due, fresh } = s.avail;
          const any = relearn + due + fresh > 0;
          const isOpen = open === s.key;
          const cur = s.current;
          return (
            <li key={s.key} className={`card subject${isOpen ? ' tip-open' : ''}`} data-testid={`subject-${s.key}`}>
              <div className="subject-head">
                <b>{s.name}</b>
                <span className="subject-score" data-testid="subject-score">
                  {cur ?? '—'}
                  {proj != null && (
                    <>
                      <Icon name="arrow" size={14} className="score-arrow" />
                      <b className={proj < rule.subjectMin ? 'bad' : ''}>{proj}</b>
                    </>
                  )}
                  {cur != null || proj != null ? '점' : ''}
                </span>
              </div>
              {/* 막대 = 현재 점수(현재 기준 색), 굵은 실선 = 시험일 예상(계획에서 자동), 점선 = 과락선. 올리거나 누르면 안내창 */}
              <div
                className="bar-hit"
                data-tip={s.key}
                role="button"
                tabIndex={0}
                aria-expanded={isOpen}
                aria-label={`${s.name} 점수 설명 보기`}
                data-testid="subject-bar-hit"
                onPointerDown={(e) => (pointer.current = e.pointerType)}
                onPointerEnter={(e) => {
                  if (e.pointerType === 'mouse') setOpen(s.key);
                }}
                onPointerLeave={(e) => {
                  if (e.pointerType === 'mouse') setOpen((o) => (o === s.key ? null : o));
                }}
                onClick={() => setOpen((o) => (pointer.current === 'mouse' ? s.key : o === s.key ? null : s.key))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setOpen((o) => (o === s.key ? null : s.key));
                  }
                }}
              >
                <div className="bar dual" role="img" aria-label={`${s.name} 현재 ${cur ?? '—'}점, 시험일 예상 ${proj ?? '—'}점`} data-testid="subject-bar">
                  {cur != null && <span className={`bar-fill ${tone(cur)}`} style={{ width: `${Math.max(cur, 0.8)}%` }} data-testid="bar-current" />}
                  <i className="bar-line pass" style={{ left: `${rule.subjectMin}%` }} />
                  {proj != null && (
                    <i className="bar-mark" style={{ left: `${Math.min(99, proj)}%` }} data-testid="bar-projected">
                      <em>예상 {proj}</em>
                    </i>
                  )}
                </div>
                {isOpen && <SubjectTip s={s} rule={rule} per={per} extra={coach.today.extra} />}
              </div>
              <div className="subject-foot">
                <span className="muted">
                  {s.solved ? `푼 ${s.solved}문항 · 정답 ${s.correct} · 마지막 ${new Date(s.lastTs!).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}` : '아직 안 풀었음'}
                </span>
                <button className="btn btn-small btn-primary" disabled={props.busy || !any} onClick={() => props.onStudy(s.key)} data-testid="subject-study">
                  {any ? `학습하기 (${Math.min(per, relearn + due + fresh)}문항)` : '오늘 학습 끝'}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** 과목 막대 안내창: 그 과목의 숫자로 막대 읽는 법을 알려 준다 */
function SubjectTip(props: { s: SubjectView; rule: { subjectMin: number; avgMin: number }; per: number; extra: boolean }) {
  const { s, rule, per, extra } = props;
  const { relearn, due, fresh } = s.avail;
  return (
    <div className="subject-tip" role="tooltip" data-testid="subject-tip">
      <dl>
        <dt>
          <i className="tip-swatch fill" aria-hidden="true" /> 막대 = 현재 점수
        </dt>
        <dd>
          {s.current != null ? (
            <>
              <b>{s.current}점</b> — 푼 {s.solved}문항 중 정답 {s.correct}
            </>
          ) : (
            '아직 푼 문항이 없습니다'
          )}
          <br />
          <small>같은 문항은 여러 번 풀어도 1문항, 정답·오답은 가장 최근 답으로. 모름은 오답</small>
        </dd>
        <dt>
          <i className="tip-swatch mark" aria-hidden="true" /> 굵은 세로선 = 시험일 예상
        </dt>
        <dd>{s.examProjected != null ? <><b>{s.examProjected}점</b> — 학습계획대로 공부했을 때(실제 시험 기준)</> : '학습계획(시험일)을 정하면 표시'}</dd>
        <dt>
          <i className="tip-swatch dash" aria-hidden="true" /> 점선 = 과락선 {rule.subjectMin}점
        </dt>
        <dd>
          막대 색: <span className="tip-c bad">{rule.subjectMin}점 미만</span> · <span className="tip-c warn">{rule.avgMin}점 미만</span> · <span className="tip-c ok">{rule.avgMin}점 이상</span>
        </dd>
        <dt>오늘 학습할 문항</dt>
        <dd>
          {relearn + due + fresh > 0 ? (
            <>
              {relearn + due ? `복습 ${relearn + due} · ` : ''}새 문항 {fresh} — [학습하기]는 {extra ? `목표를 채워 추가 ${EXTRA_SIZE}문항씩` : `오늘 남은 목표 ${per}문항까지`}
            </>
          ) : (
            '오늘은 이 과목에서 낼 문항이 없습니다(내일 복습 준비)'
          )}
        </dd>
      </dl>
    </div>
  );
}
