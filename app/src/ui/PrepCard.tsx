import { useState } from 'react';
import { PREP_DOWNLOAD_URL, PREP_RELEASES_URL, PREP_SETUP_URL, prepOffer } from '../prep';
import { deviceEnv } from '../util';

/**
 * 원큐합격 전처리기 안내 카드 — 설치 경로 일원화(v0.13.0, 사용자 2026-11-11).
 * 경로는 하나: 링크를 PC로 연다 → 전처리기 설치 → 전처리기에서 문제팩 만들기 → 전처리기 [학습앱 설치]에서 PC·휴대폰을 골라 직접 설치 → [문제팩 가져오기].
 * - Windows PC: 1단계로 [전처리기 설치 파일 받기](Setup.exe), 보조로 설치 없는 zip
 * - 휴대폰·태블릿: 문제팩은 PC에서 만든다 — PC에 전처리기가 없으면 PC에서 이 주소를 열어 설치(주소 복사)
 * - 맥 등: Windows 전용
 */
export const PREP_WHAT =
  '원큐합격 전처리기는 Q-Net의 최신 출제기준과 기출문제 PDF를 모아, 이 학습앱에서 풀 수 있는 문제팩(과목·단원·유형 정리)을 만드는 Windows PC 프로그램입니다.';

export function PrepCard(props: { compact?: boolean; testId?: string; url?: string }) {
  const env = deviceEnv();
  const offer = prepOffer(env);
  const testId = props.testId ?? 'prep-card';
  const [copied, setCopied] = useState(false);
  const url = props.url ?? window.location.href;
  const copy = () =>
    navigator.clipboard
      ?.writeText(url)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));

  if (offer !== 'download')
    return (
      <section className="card guide prep-card" data-testid={testId}>
        <h2>{offer === 'use-pc' ? '문제팩은 PC에서 만듭니다' : '문제팩 만들기 — Windows PC 필요'}</h2>
        <p className="hint">{PREP_WHAT}</p>
        <p className="hint">
          메신저·메일·소셜미디어로 <b>받은 문제팩</b>이 있으면 전처리기 없이 [문제팩 가져오기]로 바로 넣으면 됩니다. 직접 만들려면:
        </p>
        <ol className="install-steps">
          <li>
            PC에 전처리기를 아직 설치하지 않았다면, <b>Windows PC에서 이 앱 주소를 열어</b> 전처리기를 설치하세요
          </li>
          <li>전처리기로 문제팩을 만들고, 그 파일을 이 기기로 옮깁니다(카카오톡 ‘나와의 채팅’, 드라이브, 메일 등)</li>
          <li>
            이 앱의 <b>[문제팩 가져오기]</b>로 넣습니다
          </li>
        </ol>
        <button className="btn btn-block" onClick={copy} data-testid="prep-copy-url">
          {copied ? '주소를 복사했습니다 — PC로 보내 여세요' : '앱 주소 복사(PC로 보내기)'}
        </button>
      </section>
    );

  return (
    <section className="card guide prep-card" data-testid={testId}>
      <h2>{props.compact ? '1단계 — 원큐합격 전처리기 설치' : '원큐합격 전처리기'}</h2>
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
        <li>
          전처리기의 <b>[학습앱 설치]</b>에서 PC·Android·iPhone 중 공부할 기기를 골라 학습앱을 설치하고, <b>[문제팩 가져오기]</b>로 팩을 넣습니다
        </li>
      </ol>
      <p className="hint">
        이미 설치했다면 전처리기가 만든 팩을 [문제팩 가져오기]로 넣으세요. 설치가 막힌 PC는{' '}
        <a href={PREP_DOWNLOAD_URL} data-testid="prep-download-zip" rel="noopener">
          설치 없이 쓰는 zip
        </a>
        , 받기가 안 되면{' '}
        <a href={PREP_RELEASES_URL} target="_blank" rel="noopener">
          배포 페이지
        </a>
        . 지울 때는 Windows 설정 → 앱(만든 문제팩은 남음).
      </p>
    </section>
  );
}
