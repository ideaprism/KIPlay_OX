'use strict';

/**
 * 공개 URL 점검 — 터널이나 배포 주소가 실제로 게임을 굴릴 수 있는지 확인한다.
 *
 * 정적 파일만 열리는 것으로는 부족하다. 이 게임의 생명선은 SSE 스트리밍이라,
 * 중간 프록시가 응답을 버퍼링하면 화면이 통째로 멈춘다. 그래서 실제로 접속해
 * 이벤트가 흘러오는지, 체험 회차가 진행되는지까지 확인한다.
 *
 * 실행:  node scripts/tunnel-check.js https://xxxx.trycloudflare.com [운영키]
 */

const BASE = (process.argv[2] || '').replace(/\/$/, '');
const KEY = process.argv[3] || process.env.ADMIN_KEY || 'kipi';

if (!BASE) {
  console.error('사용법: node scripts/tunnel-check.js <공개 URL> [운영키]');
  process.exit(1);
}

let pass = 0;
let fail = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ✓ ${m}`); } else { fail += 1; console.log(`  ✗ ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`\n공개 URL 점검 · ${BASE}\n${'─'.repeat(56)}\n`);

  // ── 1. 정적 파일
  let t0 = Date.now();
  const page = await fetch(`${BASE}/`).catch(() => null);
  const html = page && page.ok ? await page.text() : '';
  ok(page && page.ok, `참여자 화면 응답 ${page ? page.status : '실패'} (${Date.now() - t0}ms)`);
  ok(html.includes('혼자 체험해보기'), '체험 모드 버튼이 포함됨');

  for (const asset of ['style.css', 'app.js', 'board.html', 'admin.html']) {
    const r = await fetch(`${BASE}/${asset}`).catch(() => null);
    ok(r && r.ok, `정적 파일 ${asset}`);
  }

  // ── 2. API
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  ok(health && health.ok, `상태 점검 API · phase=${health ? health.phase : '실패'}`);

  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empId: '26005' }),
  }).then((r) => r.json()).catch(() => null);
  ok(login && login.token, `로그인 · ${login && login.user ? login.user.name : '실패'}`);
  if (!login || !login.token) return;

  // ── 3. SSE 스트리밍 (가장 중요한 검증)
  //    프록시가 버퍼링하면 여기서 이벤트가 안 온다. 화면이 멈추는 원인이 대부분 이것이다.
  const events = [];
  const ac = new AbortController();
  let firstEventMs = null;

  const streamStart = Date.now();
  const stream = fetch(`${BASE}/api/stream?token=${login.token}`, { signal: ac.signal })
    .then(async (res) => {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(raw);
          const dt = /^data: (.+)$/m.exec(raw);
          if (ev && dt) {
            if (firstEventMs === null) firstEventMs = Date.now() - streamStart;
            try { events.push({ event: ev[1], data: JSON.parse(dt[1]) }); } catch (_) {}
          }
        }
      }
    })
    .catch(() => {});

  await sleep(2500);
  ok(events.length > 0, `SSE 첫 이벤트 도달 (${firstEventMs ?? '-'}ms) — 프록시 버퍼링 없음`);

  // ── 4. 체험 회차가 실제로 진행되는지
  const started = await fetch(`${BASE}/api/demo/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: login.token, bots: 12, lobbySec: 2 }),
  }).then((r) => r.json()).catch(() => null);
  ok(started && started.ok, `체험 시작 · 봇 ${started ? started.bots : '-'}명`);

  await sleep(9000);
  const phases = [...new Set(events.filter((e) => e.event === 'state').map((e) => e.data.phase))];
  const tallies = events.filter((e) => e.event === 'tally').length;
  ok(phases.includes('lobby'), '대기실 이벤트 수신');
  ok(phases.includes('question'), '문항 이벤트 수신');
  ok(tallies > 2, `실시간 집계 ${tallies}회 수신 — 스트리밍이 끊기지 않음`);

  ac.abort();
  await stream;

  await fetch(`${BASE}/api/admin/reset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: KEY }),
  }).catch(() => {});

  // ── 5. 운영 키 노출 점검
  const badKey = await fetch(`${BASE}/api/admin/reset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'kipi' }),
  }).then((r) => r.status).catch(() => 0);
  ok(badKey === 403, `기본 운영 키(kipi) 거부됨 — 응답 ${badKey}`);

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`통과 ${pass} · 실패 ${fail}`);
  console.log(fail === 0 ? '\n이 URL은 직원들에게 보내도 됩니다.\n' : '\n문제가 있습니다. 위 실패 항목을 확인하세요.\n');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
