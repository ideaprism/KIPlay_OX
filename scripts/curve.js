'use strict';

/**
 * 봇 정답률 진단 — 체험 모드의 생존 곡선이 PRD 5.3의 목표 정답률과 맞는지 확인한다.
 * 곡선이 어긋나면 혼자 체험할 때의 체감이 실제 회차와 달라진다.
 *
 * 실행:  node scripts/curve.js [봇수] [반복]
 */

const http = require('http');

const BOTS = Number(process.argv[2]) || 300;
const ROUNDS = Number(process.argv[3]) || 3;
const PORT = Number(process.env.PORT) || 12055;
const KEY = process.env.ADMIN_KEY || 'kipi';
const HOST = '127.0.0.1';

const TARGET = { easy: 0.85, medium: 0.6, hard: 0.4 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: HOST, port: PORT, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => { let raw = ''; res.on('data', (c) => (raw += c));
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (_) { resolve({}); } }); });
    req.on('error', reject);
    req.end(payload);
  });
}

function sse(path, onEvent) {
  const req = http.get({ host: HOST, port: PORT, path }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        let event = null; let data = null;
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim();
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (event && data) { try { onEvent(event, JSON.parse(data)); } catch (_) {} }
      }
    });
  });
  req.on('error', () => {});
  return () => req.destroy();
}

(async () => {
  console.log(`\n봇 정답률 진단 · 봇 ${BOTS}명 × ${ROUNDS}회\n${'─'.repeat(58)}`);
  const acc = [[], [], [], [], []];

  for (let r = 0; r < ROUNDS; r += 1) {
    await post('/api/admin/reset', { key: KEY });
    await sleep(200);

    const me = await post('/api/login', { empId: '15029' });
    const closeMe = sse(`/api/stream?token=${me.token}`, () => {});
    await sleep(200);

    const seen = [];
    let done = false;
    const close = sse('/api/spectate', (event, s) => {
      if (event !== 'state') return;
      if (s.phase === 'reveal' && s.reveal && seen.length === s.qIndex) {
        const { o, x, answer, alive, eliminatedCount } = s.reveal;
        const total = o + x + 0; // 무응답은 집계에 안 잡히므로 별도로 환산한다
        const right = answer === 'O' ? o : x;
        seen.push({ q: s.qIndex + 1, right, total, alive, eliminatedCount, answered: total });
      }
      if (s.phase === 'result') done = true;
    });

    await post('/api/demo/start', { token: me.token, bots: BOTS, lobbySec: 2 });

    const t0 = Date.now();
    while (!done && Date.now() - t0 < 120000) await sleep(200);

    let before = BOTS + 1;
    seen.forEach((s, i) => {
      const rate = before > 0 ? s.alive / before : 0;
      if (acc[i]) acc[i].push({ rate, answered: s.answered, before });
      before = s.alive;
    });

    close(); closeMe();
    process.stdout.write(`  회차 ${r + 1} 완료  `);
  }

  await post('/api/admin/reset', { key: KEY });

  console.log(`\n\n  문항  난이도   목표     실측 생존률   편차`);
  console.log(`  ${'─'.repeat(52)}`);
  const ladder = ['easy', 'easy', 'medium', 'hard', 'hard'];
  let worst = 0;
  ladder.forEach((d, i) => {
    if (!acc[i].length) return;
    const mean = acc[i].reduce((a, b) => a + b.rate, 0) / acc[i].length;
    const target = TARGET[d];
    const gap = mean - target;
    worst = Math.max(worst, Math.abs(gap));
    const bar = '█'.repeat(Math.round(mean * 24)).padEnd(24, '·');
    console.log(`   Q${i + 1}   ${d.padEnd(7)}  ${(target * 100).toFixed(0).padStart(3)}%   ${bar} ${(mean * 100).toFixed(1).padStart(5)}%   ${gap >= 0 ? '+' : ''}${(gap * 100).toFixed(1)}%p`);
  });

  console.log(`\n  최대 편차 ${(worst * 100).toFixed(1)}%p — ${worst <= 0.08 ? '목표 정답률과 일치' : '보정 필요'}\n`);
  process.exit(0);
})();
