'use strict';

/**
 * 12:55 — 부하 리허설
 *
 * PRD 7.5의 추정치를 실측으로 검증한다. 계산상 여유가 있다는 것과 당일 실제로 버틴다는 것은 다르다.
 *
 * 측정 항목
 *   · 450개 SSE 동시 연결 수립 시간 (12:54:59 스파이크 재현)
 *   · 문항 공개 브로드캐스트가 전원에게 도달하는 데 걸린 시간 (p50 / p95 / max)
 *   · 답안 제출 처리량과 실패 건수
 *   · 서버 메모리 (rss / heap)
 *
 * 실행:  node scripts/load.js            (기본 450명)
 *        node scripts/load.js 900        (인원 지정)
 */

const http = require('http');

const N = Number(process.argv[2]) || 450;
const PORT = Number(process.env.PORT) || 12055;
const KEY = process.env.ADMIN_KEY || 'kipi';
const HOST = '127.0.0.1';

const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: HOST, port: PORT, path, method: 'POST', agent,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let data = {};
          try { data = JSON.parse(raw); } catch (_) { /* noop */ }
          resolve({ status: res.statusCode, data });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: HOST, port: PORT, path, agent }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    }).on('error', reject);
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
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = null;
        let data = null;
        for (const line of raw.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim();
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (event && data) { try { onEvent(event, JSON.parse(data)); } catch (_) { /* noop */ } }
      }
    });
  });
  req.on('error', () => {});
  return () => req.destroy();
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

// ───────────────────────────────────────────────────────────

(async () => {
  console.log(`\n12:55 — 부하 리허설 · 가상 사용자 ${N}명\n${'─'.repeat(52)}`);

  await post('/api/admin/reset', { key: KEY });
  await sleep(200);

  const users = [];
  const errors = { login: 0, answer: 0, reasons: [] };

  // ── 1. 로그인 버스트
  console.log('\n[1] 로그인');
  let t0 = Date.now();
  const logins = [];
  for (let i = 0; i < N; i += 1) {
    // 사번 5자리 = 두 자리 입사연도 + 세 자리 일련번호. 신입 비율이 실제와 비슷하도록 섞는다.
    const yy = (new Date().getFullYear() - (i % 22)) % 100;
    const empId = `${String(yy).padStart(2, '0')}${String(i % 1000).padStart(3, '0')}`;
    logins.push(
      post('/api/login', { empId })
        .then(({ status, data }) => {
          if (status === 200) users.push({ token: data.token, isNew: data.user.isNew, latency: [] });
          else errors.login += 1;
        })
        .catch(() => { errors.login += 1; }),
    );
  }
  await Promise.all(logins);
  const loginMs = Date.now() - t0;
  console.log(`    ${users.length}명 성공 · 실패 ${errors.login} · ${loginMs}ms (${Math.round(users.length / (loginMs / 1000))} req/s)`);

  // ── 2. SSE 동시 연결 (12:54:59 스파이크 재현)
  console.log('\n[2] SSE 동시 연결 — 12:54:59 스파이크 재현');
  t0 = Date.now();
  let connected = 0;
  let questionSeen = 0;
  const qLatency = [];
  let currentQIndex = -1;

  await Promise.all(users.map((u) => new Promise((resolve) => {
    let first = true;
    u.close = sse(`/api/stream?token=${u.token}`, (event, s) => {
      if (event === 'state') {
        if (first) { first = false; connected += 1; resolve(); }
        u.snap = s;

        // 도달 지연 = 수신 시각 − 서버가 payload를 찍은 시각.
        // 같은 머신이라 시계가 일치하므로 직렬화·전송·파싱까지 포함한 실제 지연이다.
        if (s.phase === 'question' && s.qIndex !== u.lastQ) {
          u.lastQ = s.qIndex;
          qLatency.push(Math.max(0, Date.now() - s.serverNow));
          questionSeen += 1;
        }

        // 서든데스 참가자는 값을 제출한다 (챔피언이 실제로 결정되는지 확인)
        if (s.phase === 'sudden' && s.me && s.me.inSudden && !u.sentSudden) {
          u.sentSudden = true;
          post('/api/sudden', {
            token: u.token,
            value: Math.round(500 + Math.random() * 2000),
            rt: Math.round(1000 + Math.random() * 8000),
          }).catch(() => {});
        }
      }
    });
    setTimeout(resolve, 15000); // 안전 타임아웃
  })));

  const connMs = Date.now() - t0;
  console.log(`    ${connected}개 연결 · ${connMs}ms (${Math.round(connected / (connMs / 1000))} conn/s)`);

  let health = await get('/api/health');
  console.log(`    서버 rss ${health.rssMB}MB · heap ${health.heapMB}MB · 연결 ${health.connected}`);

  // ── 3. 실전 1회차
  console.log('\n[3] 게임 1회차 — 전원 응답');

  // 전광판으로 문항 공개 시각을 관측한다
  const closeSpec = sse('/api/spectate', async (event, s) => {
    if (event !== 'state') return;
    if (s.phase === 'question' && s.qIndex !== currentQIndex) {
      currentQIndex = s.qIndex;

      // 응답 창 7초 안에 무작위로 흩어서 제출한다 (실제 사용자 행동 근사)
      for (const u of users) {
        const delay = Math.random() * 5000;
        setTimeout(() => {
          post('/api/answer', {
            token: u.token,
            qIndex: s.qIndex,
            answer: Math.random() < 0.5 ? 'O' : 'X',
            rt: delay,
          }).then((r) => {
            if (r.status !== 200 && r.status !== 409) {
              errors.answer += 1;
              errors.reasons.push(`HTTP ${r.status} ${JSON.stringify(r.data)}`);
            }
          }).catch((e) => {
            errors.answer += 1;
            errors.reasons.push(`${e.code || e.name}: ${e.message}`);
          });
        }, delay);
      }
    }
  });

  const t1 = Date.now();
  await post('/api/admin/start', { key: KEY, lobbySec: 3 });

  let result = null;
  const closeWatch = sse('/api/spectate', (event, s) => {
    if (event === 'state' && s.phase === 'result') result = s.result;
  });

  while (!result && Date.now() - t1 < 120000) await sleep(250);
  const gameMs = Date.now() - t1;

  await sleep(500);
  health = await get('/api/health');

  console.log(`    회차 소요 ${(gameMs / 1000).toFixed(1)}초 · 챔피언 ${result && result.champion ? result.champion.name : '없음'}`);
  console.log(`    답안 제출 실패 ${errors.answer}건`);
  if (errors.reasons.length) {
    const tally = {};
    for (const r of errors.reasons) tally[r] = (tally[r] || 0) + 1;
    for (const [reason, n] of Object.entries(tally)) console.log(`      ${n}× ${reason}`);
  }
  console.log(`    문항 도달 지연  p50 ${pct(qLatency, 50)}ms · p95 ${pct(qLatency, 95)}ms · max ${Math.max(0, ...qLatency)}ms  (표본 ${questionSeen})`);
  console.log(`    서버 rss ${health.rssMB}MB · heap ${health.heapMB}MB · 참가 ${health.players} · 연결 ${health.connected}`);

  // ── 4. 판정
  console.log(`\n${'─'.repeat(52)}`);
  const checks = [
    [connected >= N * 0.99, `SSE 연결 ${connected}/${N}`],
    [connMs < 10000, `연결 수립 ${connMs}ms < 10s`],
    [errors.login === 0, `로그인 실패 ${errors.login}건`],
    [errors.answer === 0, `답안 실패 ${errors.answer}건`],
    [pct(qLatency, 95) < 1000, `문항 도달 p95 ${pct(qLatency, 95)}ms < 1000ms`],
    [health.rssMB < 400, `메모리 ${health.rssMB}MB < 400MB`],
    [!!result, '회차 정상 종료'],
  ];
  let bad = 0;
  for (const [good, label] of checks) {
    console.log(`  ${good ? '✓' : '✗'} ${label}`);
    if (!good) bad += 1;
  }

  closeSpec(); closeWatch();
  for (const u of users) if (u.close) u.close();
  await sleep(300);
  await post('/api/admin/reset', { key: KEY }).catch(() => {});

  console.log(`\n${bad === 0 ? '450명 규모 통과' : `${bad}개 항목 미달`}\n`);
  process.exit(bad === 0 ? 0 : 1);
})();
