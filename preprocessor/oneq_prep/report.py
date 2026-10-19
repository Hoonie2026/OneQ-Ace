"""검수 보고서(HTML) — 서버 없이 브라우저로 여는 정적 파일.

review/report.html          회차별 요약·막히는 문제 목록
review/<packId>.html        회차의 모든 문항 카드(이미지·정답·과목·경고). 정답·과목·제외를 고치면
                            "검수 파일 저장"으로 <packId>.review.json을 내려받는다 → review/ 폴더에 넣고 다시 실행
review/<packId>/NNN.webp    카드 이미지(팩 안 이미지와 같은 파일)
"""
from __future__ import annotations

import datetime as dt
import html
import json
from collections import Counter
from pathlib import Path

CSS = """
:root{--bg:#fafaf7;--fg:#1d1d1b;--mut:#6b6b66;--card:#fff;--line:#e3e2dc;--ok:#1f7a4d;--bad:#b3261e;--warn:#9a6700;--acc:#2f5bd3;--chip:#efeee8}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--mut:#a3a29b;--card:#20201e;--line:#34332f;--ok:#5cc28d;--bad:#ff8a80;--warn:#e3b341;--acc:#8fb0ff;--chip:#2b2a27}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 "Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",sans-serif}
main{max-width:1100px;margin:0 auto;padding:20px 16px 96px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
.mut{color:var(--mut)}a{color:var(--acc)}table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line)}
th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;font-variant-numeric:tabular-nums;vertical-align:top}th{font-size:13px;color:var(--mut);font-weight:600}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
.chip{display:inline-block;padding:1px 7px;border-radius:10px;background:var(--chip);font-size:12px;margin:0 4px 2px 0}
.bar{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.bar button{border:1px solid var(--line);background:var(--card);color:var(--fg);padding:5px 12px;border-radius:16px;cursor:pointer}
.bar button.on{background:var(--fg);color:var(--bg)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(460px,1fr));gap:12px}
@media (max-width:520px){.grid{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;min-width:0}
.card.has-warn{border-color:var(--warn)}.card.changed{outline:2px solid var(--acc)}.card.excluded{opacity:.55}
.card img{width:100%;height:auto;display:block;background:#fff;border-radius:4px}
.hd{display:flex;justify-content:space-between;gap:8px;align-items:baseline;margin-bottom:6px;flex-wrap:wrap}
.ans{font-weight:700;font-size:16px}.ctl{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center;font-size:13px}
select,input[type=text]{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:4px;padding:3px 4px;max-width:100%}
.w{font-size:13px;color:var(--warn);margin-top:4px}.sug{font-size:13px;margin-top:4px}
footer{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:10px 16px;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap}
footer button{background:var(--acc);color:#fff;border:0;border-radius:6px;padding:8px 16px;font-size:15px;cursor:pointer}
ul.iss{margin:4px 0 0;padding-left:20px}
"""

JS = r"""
const D = JSON.parse(document.getElementById('data').textContent);
const changes = {answers:{}, exclude:{}, reassign:{}};
const cards = [...document.querySelectorAll('.card')];
function mark(card){
  const no = card.dataset.no, it = D.items[no];
  const a = card.querySelector('.a').value, s = card.querySelector('.s').value, x = card.querySelector('.x');
  const r = card.querySelector('.xr');
  delete changes.answers[no]; delete changes.reassign[no]; delete changes.exclude[no];
  if (a && Number(a) !== it.answer) changes.answers[no] = Number(a);
  if (s && s !== it.subject) changes.reassign[no] = s;
  if (x.checked !== Boolean(it.excluded)) { if (x.checked) changes.exclude[no] = r.value || '판독 불가'; }
  else if (x.checked && r.value !== (it.excluded||'')) changes.exclude[no] = r.value;
  const ch = (no in changes.answers) || (no in changes.reassign) || (no in changes.exclude) || (!x.checked && it.excluded && it.excludedManual);
  card.classList.toggle('changed', !!ch); card.classList.toggle('excluded', x.checked);
  const n = Object.keys(changes.answers).length + Object.keys(changes.reassign).length + Object.keys(changes.exclude).length;
  document.getElementById('n').textContent = n;
}
cards.forEach(c => c.querySelectorAll('select,input').forEach(el => el.addEventListener('change', () => mark(c))));
document.querySelectorAll('.bar button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.bar button').forEach(x => x.classList.toggle('on', x === b));
  const f = b.dataset.f;
  cards.forEach(c => c.style.display = (f === 'all' || c.classList.contains(f) || c.dataset.tags.includes(f)) ? '' : 'none');
}));
document.getElementById('save').addEventListener('click', () => {
  const base = D.review || {};
  const out = {packId: D.packId, source: D.source,
    subjectMap: base.subjectMap || {},
    answers: {...(base.answers||{}), ...changes.answers},
    acceptAlso: base.acceptAlso || {},
    exclude: {...(base.exclude||{}), ...changes.exclude},
    reassign: {...(base.reassign||{}), ...changes.reassign},
    reviewed: document.getElementById('done').checked};
  // 화면에서 제외를 해제한 문항은 기존 검수 파일에서도 뺀다
  cards.forEach(c => { if (!c.querySelector('.x').checked) delete out.exclude[c.dataset.no]; });
  // 재배정: 화면에 보이는 과목 선택이 곧 검수 결과다(자동 제안 포함). 시험지 머리말 과목과 같으면 적지 않는다
  out.reassign = {};
  cards.forEach(c => { const v = c.querySelector('.s').value, no = c.dataset.no;
    if (v && v !== D.items[no].pdfStd) out.reassign[no] = v; });
  const blob = new Blob([JSON.stringify(out, null, 1)], {type:'application/json'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = D.packId + '.review.json'; a.click();
});
"""

CIRCLED = "①②③④⑤"


def _e(s) -> str:
    return html.escape(str(s), quote=True)


def _page(title: str, body: str, script: str = "") -> str:
    return (f'<!doctype html><html lang="ko"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1"><title>{_e(title)}</title>'
            f'<style>{CSS}</style></head><body><main>{body}</main>{script}</body></html>')


def _src_label(it) -> str:
    return {("inline-mark", "agree"): "보기 표시 = 정답표", ("inline-mark", "single"): "보기 표시",
            ("answer-table", "single"): "정답표", ("manual", "single"): "수동 입력"}.get(
        (it.answer_source, it.answer_check), "검수 정정" if it.answer_check == "corrected" else "—")


def write_detail(p, out: Path) -> Path:
    img_dir = out.parent / p.pack_id
    img_dir.mkdir(parents=True, exist_ok=True)
    std_names = [s["name"] for s in p.profile.subjects]
    data = {"packId": p.pack_id, "source": p.pdf.name, "review": p.review, "items": {}}
    cards = []
    for it in p.items:
        (img_dir / f"{it.no:03d}.webp").write_bytes(it.image)
        # 재배정 제안이 있으면 아직 반영 전이어도 선택 상자에 제안을 보여 준다
        pdf_std = it.subject if "subject-reassigned" not in it.flags else None
        shown = it.subject
        sug = it.suggestion
        if sug and p.legacy and not p.review.get("reviewed"):
            shown = p.review.get("reassign", {}).get(str(it.no), sug.suggested)
        data["items"][it.no] = {"answer": it.answer, "subject": it.subject, "pdfStd": sug.current if sug else (pdf_std or it.subject),
                                "excluded": it.excluded, "excludedManual": str(it.no) in p.review.get("exclude", {})}
        tags = []
        if it.warnings:
            tags.append("has-warn")
        if "has-figure" in it.flags:
            tags.append("fig")
        if sug and sug.suggested != sug.current:
            tags.append("re")
        if sug and sug.confidence < 0.6:
            tags.append("low")
        opts_a = "".join(f'<option value="{k}"{" selected" if it.answer == k else ""}>{CIRCLED[k-1]}</option>'
                         for k in range(1, it.choice_count + 1))
        if it.answer is None:
            opts_a = '<option value="" selected>?</option>' + opts_a
        opts_s = "".join(f'<option{" selected" if shown == n else ""}>{_e(n)}</option>' for n in std_names)
        if shown and shown not in std_names:
            opts_s = f'<option selected>{_e(shown)}</option>' + opts_s
        warn = "".join(f'<div class="w">⚠ {_e(w)}</div>' for w in it.warnings)
        sug_html = ""
        if sug:
            cls = "ok" if sug.suggested == sug.current else ("warn" if sug.confidence < 0.6 else "")
            sug_html = (f'<div class="sug {cls}">재배정 제안: <b>{_e(sug.suggested)}</b> '
                        f'(확신 {sug.confidence:.0%}) · 가까운 문항 {", ".join(f"{q[-12:]} {s:.2f}" for q, s in sug.neighbors)}</div>')
        local = f" · 원본 {_e(it.pdf_subject)} {it.local_no}번" if p.numbering == "per-subject" else ""
        flags = "".join(f'<span class="chip">{_e(f)}</span>' for f in it.flags)
        cards.append(
            f'<div class="card {" ".join(tags)}" data-no="{it.no}" data-tags="{" ".join(tags)}">'
            f'<div class="hd"><span><b>{it.no}번</b> <span class="mut">{_e(it.pdf_subject)}{local}</span></span>'
            f'<span class="ans">정답 {CIRCLED[it.answer-1] if it.answer else "?"} <span class="mut" style="font-weight:400;font-size:12px">{_src_label(it)}</span></span></div>'
            f'<img loading="lazy" src="{p.pack_id}/{it.no:03d}.webp" width="{it.img_size[0]}" height="{it.img_size[1]}" alt="{it.no}번">'
            f'{warn}{sug_html}<div>{flags}</div>'
            f'<div class="ctl"><label>정답 <select class="a">{opts_a}</select></label>'
            f'<label>과목 <select class="s">{opts_s}</select></label>'
            f'<label><input type="checkbox" class="x"{" checked" if it.excluded else ""}> 제외</label>'
            f'<input type="text" class="xr" placeholder="제외 사유" value="{_e(it.excluded or "")}" size="14"></div></div>')
    n_warn = sum(1 for it in p.items if it.warnings)
    n_re = sum(1 for it in p.items if it.suggestion and it.suggestion.suggested != it.suggestion.current)
    bar = ('<div class="bar"><button class="on" data-f="all">전체</button>'
           f'<button data-f="has-warn">경고 {n_warn}</button>'
           + (f'<button data-f="re">재배정 제안 {n_re}</button><button data-f="low">확신 낮음</button>' if p.legacy else "")
           + '<button data-f="fig">그림 포함</button></div>')
    iss = "".join(f"<li>{_e(x)}</li>" for x in p.issues) or "<li class='ok'>없음</li>"
    data_json = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    body = (f'<p class="mut"><a href="report.html">← 요약</a></p><h1>{_e(p.pack_id)} 검수</h1>'
            f'<p class="mut">{_e(p.pdf.name)} · 시행일 {_e(p.exam["date"])} · {len(p.items)}문항 · 정답 표시 제거 {p.masked}개({", ".join(p.method)})</p>'
            f'<h2>막히는 문제</h2><ul class="iss">{iss}</ul>'
            f'<p class="mut">정답·과목·제외를 고친 뒤 아래 <b>검수 파일 저장</b> → 받은 파일을 <code>review/</code> 폴더에 넣고 같은 명령을 다시 실행하세요.</p>'
            f'{bar}<div class="grid">{"".join(cards)}</div>'
            f'<script type="application/json" id="data">{data_json}</script>')
    foot = ('<footer><span>변경 <b id="n">0</b>건</span>'
            f'<label><input type="checkbox" id="done"{" checked" if p.review.get("reviewed") else ""}> 검수 완료</label>'
            '<button id="save">검수 파일 저장</button></footer>')
    path = out.parent / f"{p.pack_id}.html"
    path.write_text(_page(f"{p.pack_id} 검수", body, foot + f"<script>{JS}</script>"), encoding="utf-8")
    return path


def write_report(prepared: list, out: Path) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    for p in sorted(prepared, key=lambda p: p.exam["date"]):
        write_detail(p, out)
        kept = [it for it in p.items if not it.excluded]
        src = Counter(_src_label(it) for it in kept)
        status = ('<span class="ok">✓ 팩 생성</span>' if p.zip_path else
                  (f'<span class="bad">검수 필요 {len(p.issues)}</span>' if p.issues else '<span class="mut">보고서만</span>'))
        tags = "".join(f'<span class="chip">{t}</span>' for t in
                       (["OCR"] if p.ocr else []) + (["구기준"] if p.legacy else []) +
                       (["과목별 번호"] if p.numbering == "per-subject" else []))
        iss = ("<ul class='iss'>" + "".join(f"<li>{_e(x)}</li>" for x in p.issues[:8]) +
               (f"<li>… 외 {len(p.issues)-8}건</li>" if len(p.issues) > 8 else "") + "</ul>") if p.issues else ""
        notes = "".join(f'<div class="mut" style="font-size:13px">{_e(n)}</div>' for n in p.notes)
        rows.append(f'<tr><td><a href="{p.pack_id}.html">{_e(p.pack_id)}</a> {tags}</td><td>{_e(p.exam["date"])}</td>'
                    f'<td>{len(kept)}{f" (제외 {len(p.items)-len(kept)})" if len(kept) != len(p.items) else ""}</td>'
                    f'<td>{"<br>".join(f"{_e(k)} {v}" for k, v in src.most_common())}</td>'
                    f'<td>{_e(", ".join(p.method))} {p.masked}</td><td>{status}{iss}{notes}</td></tr>')
    total = sum(len([it for it in p.items if not it.excluded]) for p in prepared)
    ok = sum(1 for p in prepared if p.zip_path)
    prof = prepared[0].profile if prepared else None
    head = (f'<h1>원큐합격 전처리 검수 보고서</h1><p class="mut">{_e(prof.name if prof else "")} · '
            f'{dt.datetime.now().strftime("%Y-%m-%d %H:%M")} · 회차 {len(prepared)}개 · 팩 {ok}개 · 문항 {total}개</p>')
    table = ('<table><thead><tr><th>회차</th><th>시행일</th><th>문항</th><th>정답 출처</th><th>정답 표시 제거</th><th>상태</th></tr></thead>'
             f'<tbody>{"".join(rows)}</tbody></table>')
    guide = ('<h2>검수 방법</h2><ol><li>회차 이름을 눌러 문항 카드를 봅니다(<b>경고</b>·<b>재배정 제안</b> 단추로 걸러 보기).</li>'
             '<li>정답·과목·제외를 고치고 <b>검수 파일 저장</b> → 받은 <code>팩ID.review.json</code>을 이 <code>review</code> 폴더에 넣습니다.</li>'
             '<li>같은 명령을 다시 실행하면 반영되어 팩이 만들어집니다. 구기준 회차는 <b>검수 완료</b>를 체크해야 재배정이 반영됩니다.</li></ol>')
    out.write_text(_page("전처리 검수 보고서", head + table + guide), encoding="utf-8")
    return out
