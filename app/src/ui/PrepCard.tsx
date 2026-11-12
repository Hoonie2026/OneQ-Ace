import { useState } from 'react';
import { PREP_DOWNLOAD_URL, PREP_RELEASES_URL, PREP_SETUP_URL, prepLink, prepOffer } from '../prep';
import { deviceEnv } from '../util';

/**
 * 원큐합격 전처리기 안내 카드 — 설치 경로 두 갈래(사용자 2026-11-12, ADR 021 7절).
 * - main: 전처리기 링크(?prep)로 열었을 때의 메인. 학습앱은 서브(학습앱 주소로 가기)
 * - 기본(서브): 학습앱 첫 화면·설정의 접힌 칸 "문제팩을 직접 만들려면"
 * Windows PC면 [전처리기 설치 파일 받기](Setup.exe, 보조 zip), 휴대폰·태블릿은 "PC에서 전처리기 링크를 여세요"(링크 복사), 맥은 Windows 전용.
 */
export const PREP_WHAT =
  '원큐합격 전처리기는 Q-Net의 최신 출제기준과 기출문제 PDF를 모아, 이 학습앱에서 풀 수 있는 문제팩(과목·단원·유형 정리)을 만드는 Windows PC 프로그램입니다.';

export function PrepCard(props: { main?: boolean; testId?: string; url: string }) {
  const env = deviceEnv();
  const offer = prepOffer(env);
  const testId = props.testId ?? 'prep-card';
  const [copied, setCopied] = useState(false);
  const link = prepLink(props.url);
  const copy = () =>
    navigator.clipboard
      ?.writeText(link)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  const studySub = props.main && (
    <p className="hint sub-path" data-testid="prep-study-sub">
      공부만 하려면 전처리기가 필요 없습니다 — <a href={props.url}>원큐합격 학습앱 열기</a>(이 기기에 설치하고, 받은 문제팩을 넣어 공부)
    </p>
  );
  const cls = `card guide prep-card${props.main ? '' : ' plain'}`;

  if (offer !== 'download')
    return (
      <section className={cls} data-testid={testId}>
        {props.main && <h2>{offer === 'use-pc' ? '전처리기는 Windows PC에서 설치합니다' : '전처리기는 Windows PC 전용입니다'}</h2>}
        <p className="hint">{PREP_WHAT}</p>
        <ol className="install-steps">
          <li>
            <b>Windows PC에서 전처리기 링크를 엽니다</b> — 아래 [전처리기 링크 복사]로 PC에 보내세요(카카오톡 PC·메일 등)
          </li>
          <li>PC에 전처리기를 설치하고 기출 PDF로 문제팩을 만듭니다</li>
          <li>만든 문제팩 파일을 공부할 기기로 옮겨 학습앱의 [문제팩 가져오기]로 넣습니다</li>
        </ol>
        <button className="btn btn-block" onClick={copy} data-testid="prep-copy-url">
          {copied ? '전처리기 링크를 복사했습니다 — PC로 보내 여세요' : '전처리기 링크 복사(PC로 보내기)'}
        </button>
        {studySub}
      </section>
    );

  return (
    <section className={cls} data-testid={testId}>
      {props.main && <h2>원큐합격 전처리기 설치</h2>}
      <p className="hint">{PREP_WHAT}</p>
      <a className="btn btn-primary btn-block" href={PREP_SETUP_URL} data-testid="prep-download" rel="noopener">
        전처리기 설치 파일 받기
      </a>
      <ol className="install-steps">
        <li>
          브라우저가 「흔히 다운로드되는 파일이 아닙니다」라고 하면 <b>…</b> → <b>유지</b>
        </li>
        <li>
          받은 <b>OneQ-Prep-Setup.exe</b>를 엽니다. 「Windows의 PC 보호」 창이 뜨면 <b>추가 정보</b> → <b>실행</b> → [설치](관리자 권한 필요 없음)
        </li>
        <li>
          바탕화면의 <b>원큐합격 전처리기</b>(노란 아이콘)에서 종목을 조회하고 기출 PDF로 문제팩을 만듭니다
        </li>
      </ol>
      <p className="hint">
        설치가 막힌 PC는{' '}
        <a href={PREP_DOWNLOAD_URL} data-testid="prep-download-zip" rel="noopener">
          설치 없이 쓰는 zip
        </a>
        , 받기가 안 되면{' '}
        <a href={PREP_RELEASES_URL} target="_blank" rel="noopener">
          배포 페이지
        </a>
        . 지울 때는 Windows 설정 → 앱(만든 문제팩은 남음).
      </p>
      {studySub}
    </section>
  );
}
