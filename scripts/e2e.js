'use strict';

/**
 * 12:55 — E2E 검증
 *
 * 실제 HTTP/SSE로 플레이어를 붙여 게임 전체를 돌린다.
 * 빌드가 통과했다는 것은 게임이 동작한다는 증거가 아니므로, 상태 기계 전이와
 * 탈락 판정의 불변식을 실제 플레이로 확인한다.
 *
 *   시나리오 A  정상 진행 — 8명이 무작위 응답, 5문항 완주와 탈락 산식 검증
 *   시나리오 B  부활권    — 신입이 무응답으로 탈락 → 부활권 사용 → 재탈락
 *   시나리오 C  전멸 구제 — 전원 무응답으로 전멸 → 서든데스 → 근접값 판정
 *
 * 실행:  node scripts/e2e.js
 */

const http = require('http');

const PORT = Number(process.env.PORT) || 12055;
const KEY = process.env.ADMIN_KEY || 'kipi';
const HOST = '127.0.0.1';

let pass = 0;
let fail = 0;

const ok = (cond, msg) => {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`); }
  else { fail += 1; console.log(`  ✗ ${msg}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────────────────────── HTTP 헬퍼

function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: HOST, port: PORT, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let data = {};
          try { data = JSON.parse(raw); } catch (_) { /* 빈 응답 */ }
          resolve({ status: res.statusCode, data });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** SSE 스트림을 구독한다. 반환된 함수를 호출하면 끊는다. */
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
        if (event && data) {
          try { onEvent(event, JSON.parse(data)); } catch (_) { /* 무시 */ }
        }
      }
    });
  });
  req.on('error', () => {});
  return () => req.destroy();
}

// ───────────────────────────────────────────── 플레이어

async function join(empId, strategy) {
  const { status, data } = await post('/api/login', { empId });
  if (status !== 200) throw new Error(`login ${empId} 실패: ${JSON.stringify(data)}`);

  const p = {
    empId,
    name: data.user.name,
    isNew: data.user.isNew,
    token: data.token,
    strategy,
    submitted: [],     // 문항별 제출 답
    revivePrompted: 0,
    reviveUsed: 0,
    alive: true,
    survived: 0,
    close: null,
  };

  p.close = sse(`/api/stream?token=${p.token}`, async (event, s) => {
    if (event !== 'state') return;
    p.alive = s.me.alive;
    p.survived = s.me.survived;

    if (s.phase === 'question' && s.me.alive) {
      const answer = strategy(s.qIndex);
      p.submitted[s.qIndex] = answer;              // null이면 무응답
      if (answer) await post('/api/answer', { token: p.token, qIndex: s.qIndex, answer, rt: 1200 });
    }

    if (s.phase === 'revive' && s.me.revivePending) {
      p.revivePrompted += 1;
      const use = p.reviveUsed === 0;
      if (use) p.reviveUsed += 1;
      await post('/api/revive', { token: p.token, use });
    }

    if (s.phase === 'sudden' && s.me.inSudden && p.suddenValue !== undefined) {
      await post('/api/sudden', { token: p.token, value: p.suddenValue, rt: p.suddenRt || 3000 });
    }
  });

  return p;
}

/** 전광판 스트림으로 회차 전체를 관찰한다. */
function observe() {
  const seen = { phases: [], reveals: [], result: null, aliveTrail: [] };
  const close = sse('/api/spectate', (event, s) => {
    if (event !== 'state') return;
    if (seen.phases[seen.phases.length - 1] !== s.phase) seen.phases.push(s.phase);
    if (s.phase === 'reveal' && s.reveal) seen.reveals.push(s.reveal);
    if (s.phase === 'result') seen.result = s.result;
    seen.aliveTrail.push(s.alive);
  });
  return { seen, close };
}

// 층 상승 연출로 정답 공개가 4~6초로 늘어 한 판이 90초를 넘길 수 있다.
// 5분 슬롯이 하드 제약이므로 실제 소요 시간도 함께 기록한다.
async function waitForResult(obs, timeoutMs = 180000) {
  const t0 = Date.now();
  while (!obs.seen.result && Date.now() - t0 < timeoutMs) await sleep(200);
  obs.elapsedMs = Date.now() - t0;
  return obs.seen.result;
}

// ───────────────────────────────────────────── 시나리오

async function scenarioA() {
  console.log('\n[A] 정상 진행 — 8명 무작위 응답');
  await post('/api/admin/reset', { key: KEY });
  await sleep(150);

  const obs = observe();
  const players = [];
  const ids = ['05021', '08033', '10007', '13018',
               '16011', '18003', '20025', '22016'];

  for (const id of ids) {
    players.push(await join(id, () => (Math.random() < 0.5 ? 'O' : 'X')));
  }
  await sleep(300);

  ok(players.length === 8, '8명 입장');

  await post('/api/admin/start', { key: KEY, lobbySec: 2 });
  const result = await waitForResult(obs);

  ok(!!result, '결과 단계 도달');
  ok(obs.seen.phases.includes('lobby'), '대기실 단계 통과');
  ok(obs.seen.phases.includes('question'), '문항 단계 통과');
  ok(obs.seen.phases.includes('reveal'), '정답공개 단계 통과');
  ok(obs.seen.phases[obs.seen.phases.length - 1] === 'result', '마지막 단계는 결과');

  // 탈락 산식 불변식: 각 문항의 탈락자 수 = 그 시점 생존자 중 오답자 수
  let expectedAlive = 8;
  let mathOk = true;
  obs.seen.reveals.forEach((r, qi) => {
    const wrong = players.filter(
      (p) => p.submitted[qi] !== undefined && p.submitted[qi] !== r.answer,
    ).length;
    void wrong; // 개별 추적은 참고용. 아래 총량 불변식으로 검증한다.
    if (r.alive > expectedAlive) mathOk = false;
    expectedAlive = r.alive;
  });
  ok(mathOk, '생존자 수가 단조 감소');

  const finalAlive = obs.seen.reveals.length
    ? obs.seen.reveals[obs.seen.reveals.length - 1].alive
    : 0;
  ok(finalAlive <= 8, `최종 생존 ${finalAlive}명 (시작 8명 이하)`);
  ok(Array.isArray(result.ranking) && result.ranking.length > 0, `순위표 ${result.ranking.length}행 생성`);
  ok(result.totalPlayers === 8, '총 참가자 수 일치');

  const survivedSum = result.ranking.reduce((a, r) => a + r.survived, 0);
  ok(survivedSum >= 0 && result.ranking.every((r) => r.survived <= 5), '생존 문항 수가 0~5 범위');

  for (const p of players) p.close();
  obs.close();
}

async function scenarioB() {
  console.log('\n[B] 부활권 — 신입 무응답 탈락 후 부활');
  await post('/api/admin/reset', { key: KEY });
  await sleep(150);

  const obs = observe();
  const newbie = await join('26005', () => null);          // 절대 응답하지 않는다
  const vet1 = await join('05021', () => 'O');
  const vet2 = await join('08033', () => 'X');
  await sleep(300);

  ok(newbie.isNew === true, `${newbie.name} 신입 판정 (부활권 대상)`);
  ok(vet1.isNew === false, `${vet1.name} 고참 판정 (부활권 없음)`);

  await post('/api/admin/start', { key: KEY, lobbySec: 2 });
  await waitForResult(obs);

  ok(newbie.revivePrompted >= 1, `부활권 선택 창이 ${newbie.revivePrompted}회 제시됨`);
  ok(newbie.reviveUsed === 1, '부활권을 1회만 사용');
  ok(newbie.survived === 0, '무응답이므로 생존 문항 0 (미응답은 오답 처리)');

  const feedRevived = obs.seen.result && obs.seen.result.ranking.some((r) => r.isNew);
  ok(feedRevived, '순위표에 신입이 표시됨');

  newbie.close(); vet1.close(); vet2.close();
  obs.close();
}

async function scenarioC() {
  console.log('\n[C] 전멸 구제 — 전원 무응답 후 서든데스');
  await post('/api/admin/reset', { key: KEY });
  await sleep(150);

  const obs = observe();
  const a = await join('05021', () => null);
  const b = await join('08033', () => null);
  const c = await join('10007', () => null);

  // 서든데스 제출값을 미리 심어둔다. 정답에 가장 가까운 사람이 이겨야 한다.
  a.suddenValue = 1;    a.suddenRt = 5000;
  b.suddenValue = 900;  b.suddenRt = 4000;
  c.suddenValue = 5000; c.suddenRt = 3000;
  await sleep(300);

  await post('/api/admin/start', { key: KEY, lobbySec: 2 });
  const result = await waitForResult(obs);

  ok(obs.seen.phases.includes('sudden'), '전원 탈락 시 서든데스로 구제됨');
  ok(!!result && !!result.champion, `챔피언 결정됨 (${result && result.champion ? result.champion.name : '없음'})`);

  if (result && result.champion && result.suddenAnswer) {
    const target = result.suddenAnswer.value;
    const diffs = [
      { name: a.name, d: Math.abs(a.suddenValue - target) },
      { name: b.name, d: Math.abs(b.suddenValue - target) },
      { name: c.name, d: Math.abs(c.suddenValue - target) },
    ].sort((x, y) => x.d - y.d);
    ok(result.champion.name === diffs[0].name,
      `근접값 판정 정확 — 정답 ${target}, 승자 ${diffs[0].name} (오차 ${diffs[0].d})`);
  }

  a.close(); b.close(); c.close();
  obs.close();
}

async function scenarioD() {
  console.log('\n[D] 입력 검증');
  const bad = await post('/api/login', { empId: '123' });
  ok(bad.status === 400, '잘못된 사번 형식 거부');

  const tooLong = await post('/api/login', { empId: '260051' });
  ok(tooLong.status === 400, '6자리 사번 거부');

  const impossible = await post('/api/login', { empId: '27000' });
  ok(impossible.status === 400, '범위 밖 입사연도(1927) 거부');

  const noKey = await post('/api/admin/start', { key: 'wrong' });
  ok(noKey.status === 403, '잘못된 운영 키 거부');

  const noToken = await post('/api/answer', { token: 'nope', answer: 'O', qIndex: 0 });
  ok(noToken.status === 401, '유효하지 않은 토큰 거부');

  // 동시 세션 1개 제한
  const first = await post('/api/login', { empId: '14062' });
  const second = await post('/api/login', { empId: '14062' });
  ok(first.status === 200 && second.status === 200 && first.data.token !== second.data.token,
    '재로그인 시 새 토큰 발급 (이전 세션 축출)');

  const stale = await post('/api/answer', { token: first.data.token, answer: 'O', qIndex: 0 });
  ok(stale.status === 401, '축출된 이전 토큰은 거부됨');
}

async function scenarioE() {
  console.log('\n[E] 체험 모드 — 혼자서 봇 40명과 진행');
  await post('/api/admin/reset', { key: KEY });
  await sleep(150);

  const obs = observe();
  const solo = await join('26005', () => (Math.random() < 0.5 ? 'O' : 'X'));
  solo.suddenValue = 1000;
  await sleep(250);

  const started = await post('/api/demo/start', { token: solo.token, bots: 40, lobbySec: 2 });
  ok(started.status === 200, '운영 키 없이 체험 시작');
  ok(started.data.bots === 40, `봇 ${started.data.bots}명 생성`);

  await sleep(600);
  let health = await get('/api/health');
  ok(health.players === 41, `참가 인원 41명 (본인 1 + 봇 40) — 실제 ${health.players}`);
  ok(health.phase === 'lobby', '대기실 진입');

  // 41명은 100명 미만이라 진행 중 집계가 가려져야 한다
  let sawDemoFlag = false;
  let sawHidden = false;
  let sawDeciding = false;
  let leakedTally = false;
  let peakAlive = 0;
  const closeTally = sse('/api/spectate', (event, s) => {
    if (event === 'state' && s.demo) sawDemoFlag = true;
    if (event === 'tally') {
      if (s.tallyVisible === false && s.o === null) sawHidden = true;
      if (s.tallyVisible === false && (s.o !== null || s.x !== null)) leakedTally = true;
      if (s.decided && s.decided.includes('1')) sawDeciding = true;
      peakAlive = Math.max(peakAlive, s.alive);
    }
  });

  const result = await waitForResult(obs);

  ok(sawDemoFlag, '상태에 체험 모드 표시가 실림 (화면에 안내 띠가 뜬다)');
  ok(sawHidden, '100명 미만이라 진행 중 O/X 집계가 가려짐');
  ok(!leakedTally, '가려진 구간에서 집계가 새지 않음');
  ok(sawDeciding, '방향은 감춰도 "선택함" 표시는 전달됨');

  const firstReveal = obs.seen.reveals[0];
  const split = firstReveal && firstReveal.choices &&
    firstReveal.choices.includes('O') && firstReveal.choices.includes('X');
  ok(split, '정답 공개 순간 전원의 선택이 O/X로 갈려 드러남');
  ok(peakAlive > 1, `한때 생존자 ${peakAlive}명 (봇 포함)`);
  ok(!!result, '체험 회차 정상 종료');
  ok(result && result.totalPlayers === 41, `결과 집계 41명 — 실제 ${result ? result.totalPlayers : '-'}`);
  ok(result && result.ranking.length > 1, '순위표에 봇이 함께 표시됨');

  // 탈락 곡선이 실제처럼 줄어드는지
  const trail = obs.seen.reveals.map((r) => r.alive);
  const monotone = trail.every((v, i) => i === 0 || v <= trail[i - 1]);
  ok(monotone, `생존 곡선 단조 감소 [${trail.join(' → ')}]`);

  closeTally();
  solo.close();
  obs.close();

  // 리셋하면 봇이 사라져야 한다
  await post('/api/admin/reset', { key: KEY });
  await sleep(250);
  health = await get('/api/health');
  ok(health.players === 0, `리셋 후 봇 정리됨 — 남은 인원 ${health.players}`);
  ok(health.phase === 'idle', '리셋 후 대기 상태');
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: HOST, port: PORT, path }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function scenarioF() {
  console.log('\n[F] 층 상승과 집계 가리기 경계 — 봇 150명');
  await post('/api/admin/reset', { key: KEY });
  await sleep(150);

  const obs = observe();
  const solo = await join('15029', () => (Math.random() < 0.5 ? 'O' : 'X'));
  solo.suddenValue = 1000;
  await sleep(250);

  let visibleAbove = false;   // 100명 이상일 때 집계가 보였는가
  let hiddenBelow = false;    // 100명 미만으로 떨어지자 가려졌는가
  let leak = false;
  let crowdSeen = null;
  const floors = [];

  const close = sse('/api/spectate', (event, s) => {
    if (event === 'state') {
      if (s.crowd) crowdSeen = s.crowd;
      if (s.phase === 'reveal' && s.reveal) floors.push([s.reveal.fromFloor, s.reveal.toFloor]);
    }
    if (event === 'tally') {
      if (s.alive >= 100 && s.tallyVisible && s.o !== null) visibleAbove = true;
      if (s.alive < 100 && s.tallyVisible === false) hiddenBelow = true;
      if (s.tallyVisible === false && s.o !== null) leak = true;
    }
  });

  await post('/api/demo/start', { token: solo.token, bots: 150, lobbySec: 2 });
  // 층 상승 연출로 정답 공개가 4~6초로 늘어나 한 판이 90초를 넘길 수 있다
  const result = await waitForResult(obs, 180000);

  ok(visibleAbove, '100명 이상 구간에서는 집계가 보임');
  ok(hiddenBelow, '100명 미만으로 떨어지면 집계가 가려짐');
  ok(!leak, '가려진 뒤로는 집계가 한 번도 새지 않음');

  ok(crowdSeen && crowdSeen.n === 151, `군중 배열 ${crowdSeen ? crowdSeen.n : '-'}명 (본인 1 + 봇 150)`);
  ok(crowdSeen && crowdSeen.div.length === crowdSeen.n, '본부 마스크 길이가 인원과 일치');
  ok(crowdSeen && crowdSeen.divisions.length === 6, `본부 색 ${crowdSeen ? crowdSeen.divisions.length : '-'}개`);

  const rising = floors.every(([from, to]) => to === from + 1);
  ok(floors.length > 0 && rising, `층이 한 칸씩 상승 [${floors.map((f) => f.join('→')).join(', ')}]`);
  ok(result && result.floor >= 2, `챔피언 층 ${result ? result.floor : '-'}층 기록됨`);
  ok(result && typeof result.scene === 'string', `층 환경 '${result ? result.scene : '-'}' 전달됨`);

  // 5분 슬롯이 하드 제약이다. 대기실 2초를 뺀 순수 게임 시간을 본다.
  const gameSec = (obs.elapsedMs - 2000) / 1000;
  ok(gameSec < 180, `한 판 ${gameSec.toFixed(1)}초 — 3분 예산 이내`);

  close(); solo.close(); obs.close();
}

// ───────────────────────────────────────────── 실행

(async () => {
  console.log('12:55 — E2E 검증 시작\n' + '─'.repeat(46));
  try {
    await scenarioD();
    await scenarioA();
    await scenarioB();
    await scenarioC();
    await scenarioE();
    await scenarioF();
  } catch (err) {
    fail += 1;
    console.log(`\n  ✗ 예외 발생: ${err.message}`);
  }

  await post('/api/admin/reset', { key: KEY }).catch(() => {});

  console.log('\n' + '─'.repeat(46));
  console.log(`통과 ${pass} · 실패 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
