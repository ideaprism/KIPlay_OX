'use strict';

/**
 * 12:55 — 전사 실시간 OX 서바이벌 게임 서버
 *
 * 설계 원칙 (PRD 7.1)
 *   1. WebSocket이 아니라 SSE + POST. 방송형 동기 게임이라 양방향 채널이 필요 없다.
 *   2. 서버리스가 아니라 상시 단일 프로세스. 콜드스타트와 연결 유지 문제를 피한다.
 *   3. 스케일아웃하지 않는다. 450명은 단일 인스턴스가 정답이다.
 *
 * 의존성 0. Node 내장 모듈만 사용한다.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------- 설정

const CONFIG = {
  port: Number(process.env.PORT) || 12055,
  adminKey: process.env.ADMIN_KEY || 'kipi',

  questionMs: 7000,   // 응답 시간
  revealMs: 3000,     // 정답 공개
  reviveMs: 3000,     // 부활권 선택
  suddenMs: 15000,    // 서든데스
  lobbyMs: 30000,     // 기본 대기실 (실전은 5분)
  tallyMs: 1000,      // 실시간 집계 브로드캐스트 간격

  questionCount: 5,
  newbieYears: 2,     // 입사 N년 미만에게 부활권
  heartbeatMs: 15000, // SSE keep-alive
};

const POINTS = { join: 5, survive: 10, champion: 50, beatVip: 30 };

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');

// ---------------------------------------------------------------- 데이터 로드

function loadJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

let BANK = loadJson('questions.json');
let STAFF = loadJson('employees.json');

let ROSTER = new Map(STAFF.roster.map((r) => [r.empId, r]));
let DEPTS = STAFF.departments;
let ID = Object.assign({ digits: 5, yearPrefix: 2, defaultYears: 5 }, STAFF.idFormat || {});
let ID_RE = new RegExp(`^\\d{${ID.digits}}$`);

/**
 * 사번으로 직원을 찾는다.
 *
 * 명부에 있으면 joinYear를 그대로 쓴다. 없으면 idFormat 규칙으로 입사연도를 추정한다.
 * 사내 사번이 순번제라면 employees.json에서 yearPrefix를 0으로 두면 되고,
 * 그 경우 미등록 사번은 defaultYears 연차로 처리되어 부활권 대상에서 빠진다.
 */
function resolveEmployee(empId) {
  const id = String(empId).trim();
  if (!ID_RE.test(id)) return null;

  const nowYear = new Date().getFullYear();
  const known = ROSTER.get(id);
  let joinYear;

  if (known && known.joinYear) {
    joinYear = known.joinYear;
  } else if (ID.yearPrefix > 0) {
    const yy = Number(id.slice(0, ID.yearPrefix));
    if (!Number.isFinite(yy)) return null;
    // 두 자리 연도 해석: 올해보다 크면 지난 세기로 본다 (26 → 2026, 95 → 1995)
    joinYear = ID.yearPrefix === 2 ? (yy <= nowYear % 100 ? 2000 + yy : 1900 + yy) : yy;
  } else {
    joinYear = nowYear - ID.defaultYears;
  }

  if (joinYear < 1960 || joinYear > nowYear) return null;

  const seq = Number(id.slice(ID.yearPrefix > 0 ? ID.yearPrefix : 0)) || 0;

  return {
    empId: id,
    name: known ? known.name : `직원 ${id}`,
    dept: known ? known.dept : DEPTS[seq % DEPTS.length],
    title: known ? known.title || null : null,
    vip: known ? !!known.vip : false,
    years: nowYear - joinYear,
  };
}

// ---------------------------------------------------------------- 게임 상태

// ---------------------------------------------------------------- 체험 모드 봇
//
// 혼자서도 게임 전체를 확인할 수 있어야 한다. 봇은 난이도별 목표 정답률(PRD 5.3)에 맞춰
// 답하므로 집계 바 · 생존자 감소 곡선 · 탈락 피드 · 서든데스가 실제 회차와 같은 모양으로 움직인다.

const BOT_SURNAME = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임',
                     '한', '오', '서', '신', '권', '황', '안', '송', '전', '홍'];
const BOT_GIVEN = ['민준', '서연', '도윤', '하은', '시우', '지우', '주원', '서윤', '예준', '수아',
                   '지호', '하윤', '건우', '채원', '우진', '지아', '현우', '다은', '승우', '유나',
                   '준서', '소율', '지훈', '가은', '태윤', '서아', '민서', '연우', '동현', '수빈'];

/** 난이도별 기본 정답률. PRD 5.3의 목표 정답률과 맞춰 둔다. */
const BOT_ACCURACY = { easy: 0.85, medium: 0.6, hard: 0.4 };

const BOT_AFK_RATE = 0.04;   // 무응답 비율
const BOT_REVIVE_RATE = 0.65; // 신입 봇의 부활권 사용 확률

let botTimers = [];

function clearBotTimers() {
  for (const t of botTimers) clearTimeout(t);
  botTimers = [];
}

function laterBot(ms, fn) {
  botTimers.push(setTimeout(fn, ms));
}

function makeBotName(i) {
  const s = BOT_SURNAME[(i * 7 + 3) % BOT_SURNAME.length];
  const g = BOT_GIVEN[(i * 13 + 5) % BOT_GIVEN.length];
  return `${s}${g}`;
}

function spawnBots(count) {
  const nowYear = new Date().getFullYear();
  for (let i = 0; i < count; i += 1) {
    // 신입 비중을 실제 조직과 비슷하게 둔다 (약 13%)
    const years = Math.random() < 0.13 ? Math.floor(Math.random() * 2) : 2 + Math.floor(Math.random() * 20);
    const joinYear = nowYear - years;
    const token = `bot-${game.round}-${i}`;
    const p = newPlayer(
      {
        empId: `${String(joinYear % 100).padStart(2, '0')}${String(100 + (i % 900)).padStart(3, '0')}`,
        name: makeBotName(i),
        dept: DEPTS[i % DEPTS.length],
        title: null,
        vip: false,
        years,
      },
      token,
    );
    p.isBot = true;
    p.skill = 0.78 + Math.random() * 0.44; // 봇마다 실력 편차를 준다
    p.afk = Math.random() < BOT_AFK_RATE;
    p.points = POINTS.join;
    game.players.set(token, p);
  }
}

function clearBots() {
  clearBotTimers();
  for (const [token, p] of game.players) if (p.isBot) game.players.delete(token);
}

/** 문항 공개와 동시에 봇들의 응답을 응답 창 안에 흩어서 예약한다. */
function scheduleBotAnswers(q) {
  const base = BOT_ACCURACY[q.difficulty] ?? 0.6;
  for (const p of game.players.values()) {
    if (!p.isBot || !p.alive || p.afk) continue;
    const delay = 500 + Math.random() * (CONFIG.questionMs - 1200);
    laterBot(delay, () => {
      if (game.phase !== 'question' || !p.alive) return;
      const acc = Math.min(0.97, Math.max(0.05, base * p.skill));
      const correct = Math.random() < acc;
      p.answer = correct ? q.answer : (q.answer === 'O' ? 'X' : 'O');
      p.rt = Math.round(delay);
    });
  }
}

function scheduleBotSudden(participants) {
  const target = game.suddenQ.answer;
  for (const p of participants) {
    if (!p.isBot) continue;
    laterBot(1200 + Math.random() * (CONFIG.suddenMs - 3000), () => {
      if (game.phase !== 'sudden') return;
      const spread = 0.12 + Math.random() * 0.7;
      const sign = Math.random() < 0.5 ? -1 : 1;
      p.suddenValue = Math.max(0, Math.round(target * (1 + spread * sign)));
      p.suddenRt = Math.round(1500 + Math.random() * 9000);
    });
  }
}

const game = {
  phase: 'idle', // idle | lobby | question | reveal | revive | sudden | result
  demo: false,
  round: 0,
  phaseEndsAt: 0,

  questions: [],
  qIndex: -1,
  suddenQ: null,

  players: new Map(),   // token -> player
  byEmpId: new Map(),   // empId -> token (동시 세션 1개 제한)
  spectators: new Set(),

  lastReveal: null,
  feed: [],             // 전광판 탈락 피드
  result: null,
};

let phaseTimer = null;
let tallyTimer = null;

function newPlayer(emp, token) {
  return {
    token,
    ...emp,
    isNew: emp.years < CONFIG.newbieYears,
    alive: true,
    revives: emp.years < CONFIG.newbieYears ? 1 : 0,
    answer: null,        // 현재 문항 응답
    rt: null,
    survived: 0,         // 생존 문항 수
    eliminatedAt: null,  // 탈락 문항 index
    revivePending: false,
    reviveChoice: null,
    suddenValue: null,
    suddenRt: null,
    points: 0,
    res: null,                    // SSE 연결
    disconnectedAt: Date.now(),   // 아직 스트림을 열지 않은 상태
  };
}

/**
 * 끊긴 참여자를 정리한다.
 * 이게 없으면 폰을 닫은 사람이 영구히 참가자로 집계되어 참여율 지표가 오염된다.
 * 진행 중에는 정리하지 않는다. 재접속하면 자기 생존 상태를 그대로 이어받아야 하기 때문이다.
 */
function prunePlayers(maxIdleMs = 0) {
  const cutoff = Date.now() - maxIdleMs;
  let removed = 0;
  for (const [token, p] of game.players) {
    if (p.isBot) continue; // 봇은 회차 리셋에서 별도로 정리한다
    if (p.res || !p.disconnectedAt || p.disconnectedAt > cutoff) continue;
    game.players.delete(token);
    if (game.byEmpId.get(p.empId) === token) game.byEmpId.delete(p.empId);
    removed += 1;
  }
  return removed;
}

setInterval(() => {
  if (game.phase !== 'idle' && game.phase !== 'lobby' && game.phase !== 'result') return;
  if (prunePlayers(90000) > 0) pushState();
}, 30000).unref();

function resetPlayerForRound(p) {
  p.alive = true;
  p.revives = p.isNew ? 1 : 0;
  p.answer = null;
  p.rt = null;
  p.survived = 0;
  p.eliminatedAt = null;
  p.revivePending = false;
  p.reviveChoice = null;
  p.suddenValue = null;
  p.suddenRt = null;
  p.points = POINTS.join;
}

const alivePlayers = () => [...game.players.values()].filter((p) => p.alive);
const vipPlayer = () => [...game.players.values()].find((p) => p.vip) || null;

// ---------------------------------------------------------------- SSE

function sseOpen(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
}

function sseSend(res, event, data) {
  if (!res || res.writableEnded) return;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (_) {
    /* 끊긴 연결은 무시한다. cleanup이 정리한다. */
  }
}

setInterval(() => {
  for (const p of game.players.values()) if (p.res) p.res.write(': hb\n\n');
  for (const res of game.spectators) res.write(': hb\n\n');
}, CONFIG.heartbeatMs).unref();

// ---------------------------------------------------------------- 상태 스냅샷

function tallyCounts() {
  let o = 0;
  let x = 0;
  for (const p of game.players.values()) {
    if (!p.alive) continue;
    if (p.answer === 'O') o += 1;
    else if (p.answer === 'X') x += 1;
  }
  return { o, x };
}

function publicState() {
  const q = game.questions[game.qIndex] || null;
  const vip = vipPlayer();

  return {
    phase: game.phase,
    demo: game.demo,
    round: game.round,
    phaseEndsAt: game.phaseEndsAt,
    serverNow: Date.now(),
    joined: game.players.size,
    alive: alivePlayers().length,
    qIndex: game.qIndex,
    qTotal: game.questions.length,
    question:
      q && (game.phase === 'question' || game.phase === 'reveal')
        ? { text: q.text, difficulty: q.difficulty }
        : null,
    sudden:
      game.phase === 'sudden' && game.suddenQ
        ? { text: game.suddenQ.text, unit: game.suddenQ.unit }
        : null,
    reveal: game.phase === 'reveal' ? game.lastReveal : null,
    vip: vip ? { name: vip.name, title: vip.title, alive: vip.alive, dept: vip.dept } : null,
    feed: game.feed.slice(-14),
    result: game.result,
    ...tallyCounts(),
  };
}

function personalState(p) {
  return {
    ...publicState(),
    me: {
      empId: p.empId,
      name: p.name,
      dept: p.dept,
      years: p.years,
      isNew: p.isNew,
      isVip: p.vip,
      title: p.title,
      alive: p.alive,
      revives: p.revives,
      answer: p.answer,
      survived: p.survived,
      eliminatedAt: p.eliminatedAt,
      revivePending: !!p.revivePending,
      inSudden: !!p.inSudden,
      points: p.points,
      correct: game.phase === 'reveal' && game.lastReveal ? p.lastCorrect ?? null : null,
    },
  };
}

function pushState() {
  for (const p of game.players.values()) {
    if (p.res) sseSend(p.res, 'state', personalState(p));
  }
  const pub = publicState();
  for (const res of game.spectators) sseSend(res, 'state', pub);
}

function pushTally() {
  const { o, x } = tallyCounts();
  const payload = { o, x, alive: alivePlayers().length, joined: game.players.size };
  for (const p of game.players.values()) if (p.res) sseSend(p.res, 'tally', payload);
  for (const res of game.spectators) sseSend(res, 'tally', payload);
}

// ---------------------------------------------------------------- 상태 기계

function clearTimers() {
  if (phaseTimer) clearTimeout(phaseTimer);
  if (tallyTimer) clearInterval(tallyTimer);
  phaseTimer = null;
  tallyTimer = null;
  clearBotTimers();
}

function schedule(ms, fn) {
  if (phaseTimer) clearTimeout(phaseTimer);
  phaseTimer = setTimeout(fn, ms);
}

function pickQuestions() {
  const pool = BANK.pool;
  const byDiff = (d) => pool.filter((q) => q.difficulty === d).sort(() => Math.random() - 0.5);
  const easy = byDiff('easy');
  const medium = byDiff('medium');
  const hard = byDiff('hard');

  // PRD 5.3 난이도 사다리: 쉬움 → 쉬움~중간 → 중간 → 어려움 → 어려움
  const ladder = [easy[0], easy[1], medium[0], hard[0], hard[1]].filter(Boolean);
  while (ladder.length < CONFIG.questionCount) {
    const rest = pool.filter((q) => !ladder.includes(q));
    if (!rest.length) break;
    ladder.push(rest[Math.floor(Math.random() * rest.length)]);
  }
  return ladder.slice(0, CONFIG.questionCount);
}

function startGame(lobbyMs, opts = {}) {
  clearTimers();
  game.demo = !!opts.demo;
  if (!game.demo) clearBots(); // 실전 회차에 체험용 봇이 섞이지 않게 한다
  game.round += 1;
  game.questions = pickQuestions();
  game.suddenQ = BANK.sudden[Math.floor(Math.random() * BANK.sudden.length)];
  game.qIndex = -1;
  game.lastReveal = null;
  game.result = null;
  game.feed = [];

  for (const p of game.players.values()) resetPlayerForRound(p);

  game.phase = 'lobby';
  game.phaseEndsAt = Date.now() + lobbyMs;
  pushState();

  log(`round ${game.round} 시작 · 대기실 ${Math.round(lobbyMs / 1000)}초 · 접속 ${game.players.size}명`);
  schedule(lobbyMs, () => beginQuestion(0));
}

function beginQuestion(index) {
  clearTimers();
  game.qIndex = index;
  game.phase = 'question';
  game.phaseEndsAt = Date.now() + CONFIG.questionMs;
  game.lastReveal = null;

  for (const p of game.players.values()) {
    p.answer = null;
    p.rt = null;
    p.lastCorrect = null;
  }

  pushState();
  scheduleBotAnswers(game.questions[index]);
  tallyTimer = setInterval(pushTally, CONFIG.tallyMs);
  schedule(CONFIG.questionMs, revealQuestion);
}

function revealQuestion() {
  clearTimers();
  const q = game.questions[game.qIndex];
  const { o, x } = tallyCounts();

  const eliminated = [];
  for (const p of game.players.values()) {
    if (!p.alive) continue;
    const correct = p.answer === q.answer; // 미응답은 오답 처리 (PRD 5.2)
    p.lastCorrect = correct;
    if (correct) {
      p.survived += 1;
      p.points += POINTS.survive;
    } else {
      p.alive = false;
      p.eliminatedAt = game.qIndex;
      eliminated.push(p);
    }
  }

  for (const p of eliminated.slice(0, 14)) {
    game.feed.push({ name: p.name, dept: p.dept, q: game.qIndex + 1, vip: p.vip });
  }

  game.phase = 'reveal';
  game.phaseEndsAt = Date.now() + CONFIG.revealMs;
  game.lastReveal = {
    answer: q.answer,
    evidence: q.evidence,
    source: q.source,
    o,
    x,
    eliminatedCount: eliminated.length,
    eliminatedNames: eliminated.slice(0, 8).map((p) => p.name),
    alive: alivePlayers().length,
  };
  pushState();

  const candidates = eliminated.filter((p) => p.isNew && p.revives > 0);
  schedule(CONFIG.revealMs, () => (candidates.length ? offerRevive(candidates) : nextStep()));
}

function offerRevive(candidates) {
  clearTimers();
  game.phase = 'revive';
  game.phaseEndsAt = Date.now() + CONFIG.reviveMs;

  for (const p of candidates) {
    p.revivePending = true;
    p.reviveChoice = p.isBot ? Math.random() < BOT_REVIVE_RATE : null;
  }
  pushState();
  for (const p of candidates) {
    if (p.res) sseSend(p.res, 'revive', { deadline: game.phaseEndsAt });
  }

  schedule(CONFIG.reviveMs, resolveRevive);
}

function resolveRevive() {
  clearTimers();
  for (const p of game.players.values()) {
    if (!p.revivePending) continue;
    p.revivePending = false;
    if (p.reviveChoice === true && p.revives > 0) {
      p.revives -= 1;
      p.alive = true;
      p.eliminatedAt = null;
      game.feed.push({ name: p.name, dept: p.dept, q: game.qIndex + 1, revived: true });
    }
  }
  nextStep();
}

function nextStep() {
  const alive = alivePlayers();

  // 전멸 시 직전 문항 생존자끼리 서든데스로 구제한다.
  if (alive.length === 0) {
    const lastRound = [...game.players.values()].filter((p) => p.eliminatedAt === game.qIndex);
    if (lastRound.length >= 2) return beginSudden(lastRound);
    if (lastRound.length === 1) return finish(lastRound[0]);
    return finish(null);
  }

  if (game.qIndex + 1 < game.questions.length) return beginQuestion(game.qIndex + 1);
  if (alive.length >= 2) return beginSudden(alive);
  return finish(alive[0]);
}

function beginSudden(participants) {
  clearTimers();
  game.phase = 'sudden';
  game.phaseEndsAt = Date.now() + CONFIG.suddenMs;

  for (const p of game.players.values()) {
    p.suddenValue = null;
    p.suddenRt = null;
    p.inSudden = false;
  }
  for (const p of participants) {
    p.inSudden = true;
    p.alive = true; // 전멸 구제 시 되살린다
  }

  pushState();
  scheduleBotSudden(participants);
  schedule(CONFIG.suddenMs, resolveSudden);
}

function resolveSudden() {
  clearTimers();
  const target = game.suddenQ.answer;
  const entries = [...game.players.values()]
    .filter((p) => p.inSudden && p.suddenValue !== null)
    .map((p) => ({ p, diff: Math.abs(p.suddenValue - target), rt: p.suddenRt ?? Infinity }))
    // 오차가 같으면 반응 시간으로 가린다 (PRD 5.5)
    .sort((a, b) => a.diff - b.diff || a.rt - b.rt);

  for (const p of game.players.values()) if (p.inSudden) p.alive = false;

  if (!entries.length) return finish(null);
  entries[0].p.alive = true;
  game.suddenResult = entries.slice(0, 5).map((e) => ({
    name: e.p.name,
    dept: e.p.dept,
    value: e.p.suddenValue,
    diff: e.diff,
    rt: e.rt === Infinity ? null : e.rt,
  }));
  finish(entries[0].p);
}

function finish(champion) {
  clearTimers();
  game.phase = 'result';
  game.phaseEndsAt = 0;

  const vip = vipPlayer();
  const all = [...game.players.values()];

  if (champion) champion.points += POINTS.champion;

  let vipBeaten = [];
  if (vip) {
    vipBeaten = all.filter((p) => !p.vip && p.survived > vip.survived);
    for (const p of vipBeaten) p.points += POINTS.beatVip;
  }

  const ranking = all
    .sort((a, b) => {
      if (champion) {
        if (a === champion) return -1;
        if (b === champion) return 1;
      }
      return b.survived - a.survived || b.points - a.points;
    })
    .slice(0, 12)
    .map((p, i) => ({
      rank: i + 1,
      name: p.name,
      dept: p.dept,
      survived: p.survived,
      points: p.points,
      isNew: p.isNew,
      vip: p.vip,
    }));

  game.result = {
    champion: champion
      ? { name: champion.name, dept: champion.dept, isNew: champion.isNew, survived: champion.survived }
      : null,
    ranking,
    sudden: game.suddenResult || null,
    suddenAnswer: game.suddenQ ? { value: game.suddenQ.answer, unit: game.suddenQ.unit, evidence: game.suddenQ.evidence } : null,
    vip: vip ? { name: vip.name, title: vip.title, survived: vip.survived } : null,
    vipBeaten: vipBeaten.map((p) => ({ name: p.name, dept: p.dept })),
    totalPlayers: all.length,
  };
  game.suddenResult = null;

  pushState();
  log(`round ${game.round} 종료 · 챔피언 ${champion ? champion.name : '없음'}`);
}

function resetGame() {
  clearTimers();
  game.phase = 'idle';
  game.demo = false;
  game.qIndex = -1;
  game.phaseEndsAt = 0;
  game.lastReveal = null;
  game.result = null;
  game.feed = [];
  clearBots();
  prunePlayers(0); // 리셋 시점에 끊겨 있는 참여자는 즉시 정리한다
  for (const p of game.players.values()) resetPlayerForRound(p);
  pushState();
}

function forceNext() {
  switch (game.phase) {
    case 'lobby': return beginQuestion(0);
    case 'question': return revealQuestion();
    case 'reveal': return resolveRevive();
    case 'revive': return resolveRevive();
    case 'sudden': return resolveSudden();
    default: return null;
  }
}

// ---------------------------------------------------------------- HTTP

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e5) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch (_) { resolve({}); }
    });
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (!p.startsWith('/api/')) return serveStatic(req, res, p);

  // ---- 참여자 SSE
  if (p === '/api/stream') {
    const player = game.players.get(url.searchParams.get('token'));
    if (!player) return sendJson(res, 401, { error: 'invalid token' });

    if (player.res && !player.res.writableEnded) player.res.end();
    sseOpen(res);
    player.res = res;
    player.disconnectedAt = null;
    sseSend(res, 'state', personalState(player));

    req.on('close', () => {
      if (player.res !== res) return;
      player.res = null;
      player.disconnectedAt = Date.now();
    });
    return;
  }

  // ---- 상태 점검 (운영·부하 리허설용)
  if (p === '/api/health') {
    const m = process.memoryUsage();
    let connected = 0;
    for (const pl of game.players.values()) if (pl.res) connected += 1;
    return sendJson(res, 200, {
      ok: true,
      phase: game.phase,
      round: game.round,
      players: game.players.size,
      connected,
      spectators: game.spectators.size,
      alive: alivePlayers().length,
      uptimeSec: Math.round(process.uptime()),
      rssMB: +(m.rss / 1048576).toFixed(1),
      heapMB: +(m.heapUsed / 1048576).toFixed(1),
    });
  }

  // ---- 전광판 SSE (인증 불필요)
  if (p === '/api/spectate') {
    sseOpen(res);
    game.spectators.add(res);
    sseSend(res, 'state', publicState());
    req.on('close', () => game.spectators.delete(res));
    return;
  }

  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  const body = await readBody(req);

  // ---- 로그인
  if (p === '/api/login') {
    const emp = resolveEmployee(body.empId);
    if (!emp) return sendJson(res, 400, { error: `사번은 ${ID.digits}자리 숫자입니다.` });

    // 동시 세션 1개 제한 (PRD 7.6)
    const prev = game.byEmpId.get(emp.empId);
    if (prev && game.players.has(prev)) {
      const old = game.players.get(prev);
      if (old.res && !old.res.writableEnded) {
        sseSend(old.res, 'kicked', { reason: '다른 기기에서 접속했습니다.' });
        old.res.end();
      }
      game.players.delete(prev);
    }

    const token = crypto.randomUUID();
    const player = newPlayer(emp, token);
    if (game.phase !== 'idle' && game.phase !== 'lobby') {
      player.alive = false; // 진행 중 입장은 관전만 (PRD 5.1 입장 마감)
      player.eliminatedAt = -1;
    } else {
      player.points = POINTS.join;
    }

    game.players.set(token, player);
    game.byEmpId.set(emp.empId, token);
    pushState();

    return sendJson(res, 200, {
      token,
      user: { ...emp, isNew: player.isNew, revives: player.revives, spectatorOnly: !player.alive },
    });
  }

  // ---- 답안 제출
  if (p === '/api/answer') {
    const player = game.players.get(body.token);
    if (!player) return sendJson(res, 401, { error: 'invalid token' });
    if (game.phase !== 'question') return sendJson(res, 409, { error: 'not accepting' });
    if (!player.alive) return sendJson(res, 409, { error: 'eliminated' });
    if (body.qIndex !== game.qIndex) return sendJson(res, 409, { error: 'stale question' });
    if (body.answer !== 'O' && body.answer !== 'X') return sendJson(res, 400, { error: 'bad answer' });

    player.answer = body.answer; // 마감 전까지 변경 가능 (PRD 5.2)
    player.rt = Number(body.rt) || null;
    return sendJson(res, 200, { ok: true });
  }

  // ---- 부활권
  if (p === '/api/revive') {
    const player = game.players.get(body.token);
    if (!player) return sendJson(res, 401, { error: 'invalid token' });
    if (game.phase !== 'revive' || !player.revivePending) return sendJson(res, 409, { error: 'no offer' });
    player.reviveChoice = !!body.use;
    return sendJson(res, 200, { ok: true });
  }

  // ---- 서든데스
  if (p === '/api/sudden') {
    const player = game.players.get(body.token);
    if (!player) return sendJson(res, 401, { error: 'invalid token' });
    if (game.phase !== 'sudden' || !player.inSudden) return sendJson(res, 409, { error: 'not participant' });
    const v = Number(body.value);
    if (!Number.isFinite(v)) return sendJson(res, 400, { error: 'bad value' });
    player.suddenValue = v;
    player.suddenRt = Number(body.rt) || null;
    return sendJson(res, 200, { ok: true });
  }

  // ---- 체험 모드
  //
  // 혼자서도, 아무 때나 게임 전체를 확인할 수 있어야 한다. 운영 키가 필요 없고
  // 대기실을 짧게 잡아 바로 시작한다. 실전 회차가 진행 중일 때는 거부한다.
  if (p === '/api/demo/start') {
    const player = game.players.get(body.token);
    if (!player) return sendJson(res, 401, { error: 'invalid token' });
    if (game.phase !== 'idle' && game.phase !== 'result' && !game.demo) {
      return sendJson(res, 409, { error: '실전 회차가 진행 중입니다.' });
    }

    clearBots();
    const bots = Math.max(0, Math.min(600, Number(body.bots) || 80));
    spawnBots(bots);

    player.disconnectedAt = player.res ? null : Date.now();
    startGame(Math.max(2000, (Number(body.lobbySec) || 5) * 1000), { demo: true });
    log(`체험 모드 시작 · 봇 ${bots}명 · 요청자 ${player.name}`);
    return sendJson(res, 200, { ok: true, bots });
  }

  // ---- 운영자
  if (p.startsWith('/api/admin/')) {
    if (body.key !== CONFIG.adminKey) return sendJson(res, 403, { error: 'bad key' });
    const action = p.slice('/api/admin/'.length);

    if (action === 'start') {
      startGame(Number(body.lobbySec) > 0 ? Number(body.lobbySec) * 1000 : CONFIG.lobbyMs);
      return sendJson(res, 200, { ok: true });
    }
    if (action === 'next') { forceNext(); return sendJson(res, 200, { ok: true }); }
    if (action === 'reset') { resetGame(); return sendJson(res, 200, { ok: true }); }
    if (action === 'reload') {
      BANK = loadJson('questions.json');
      STAFF = loadJson('employees.json');
      ROSTER = new Map(STAFF.roster.map((r) => [r.empId, r]));
      DEPTS = STAFF.departments;
      ID = Object.assign({ digits: 5, yearPrefix: 2, defaultYears: 5 }, STAFF.idFormat || {});
      ID_RE = new RegExp(`^\\d{${ID.digits}}$`);
      return sendJson(res, 200, { ok: true, pool: BANK.pool.length, roster: ROSTER.size, digits: ID.digits });
    }
    return sendJson(res, 404, { error: 'unknown action' });
  }

  return sendJson(res, 404, { error: 'not found' });
});

// ---------------------------------------------------------------- 부팅

function log(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}] ${msg}`);
}

server.listen(CONFIG.port, () => {
  const bar = '─'.repeat(46);
  console.log(`\n${bar}`);
  console.log('  12:55  —  전사 실시간 OX 서바이벌');
  console.log(bar);
  console.log(`  참여자   http://localhost:${CONFIG.port}/`);
  console.log(`  전광판   http://localhost:${CONFIG.port}/board.html`);
  console.log(`  운영자   http://localhost:${CONFIG.port}/admin.html   (키: ${CONFIG.adminKey})`);
  console.log(`${bar}`);
  console.log(`  문제 ${BANK.pool.length}개 · 서든데스 ${BANK.sudden.length}개 · 명부 ${ROSTER.size}명`);
  console.log(`${bar}\n`);
});
