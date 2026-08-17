'use strict';

/**
 * 12:55 — 참여자 클라이언트
 *
 * 원칙
 *   · 서버가 권위를 가진다. 클라이언트는 절대 스스로 탈락을 판정하지 않고,
 *     해결된 이벤트를 렌더링만 한다.
 *   · 타이머는 매 프레임 서버 시계 기준으로 다시 계산한다. 프레임 누적을 쓰지 않으므로
 *     탭이 백그라운드에 갔다 와도 시간이 어긋나지 않는다.
 *   · 모든 소리는 런타임에 합성한다. 오디오 파일도, 네트워크 요청도 없다.
 */

const $ = (id) => document.getElementById(id);
const body = document.body;

const state = {
  token: sessionStorage.getItem('t1255') || null,
  clockOffset: 0,     // serverNow - clientNow
  snap: null,
  screen: 'login',
  answered: null,
  lastTickSec: null,
  es: null,
  retry: 0,
};

// 소리는 sfx.js가 제공한다 (전광판과 공유). 첫 사용자 제스처에서 unlock() 해야 울린다.

// ═══════════════════════════════════════════════ 군중 무대
//
// 폰에서는 O/X 버튼이 최우선이라 군중은 상단에 작게 둔다. compact 모드로 카메라를
// 조금 더 당겨 인원이 많아도 사람이 보이게 한다. 진짜 쇼는 전광판이 담당한다.

const stages = { question: null, watch: null };

function initStages() {
  if (stages.question) return;
  stages.question = new CrowdStage($('crowd-canvas'), { compact: true, zones: true });
  stages.watch = new CrowdStage($('watch-canvas'), { compact: true, zones: true });
  for (const s of Object.values(stages)) s.start();
}

const eachStage = (fn) => { for (const s of Object.values(stages)) if (s) fn(s); };

// ═══════════════════════════════════════════════ 중계

const commentary = new Commentary();
let captionTimer = null;
const captionQueue = [];

function showCaption(line) {
  const el = $('caption');
  el.textContent = line.text;
  el.dataset.tone = line.tone || '';
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => { el.textContent = ''; el.dataset.tone = ''; }, 7000);
  Sfx.say(line.say || line.text);
}

/** 여러 줄이 한꺼번에 나오면 읽히지 않는다. 간격을 두고 하나씩 흘린다. */
function runCommentary(s) {
  const lines = commentary.update(s);
  if (!lines.length) return;
  for (const line of lines) captionQueue.push(line);
  if (captionQueue.length === lines.length) drainCaptions();
}

function drainCaptions() {
  const line = captionQueue.shift();
  if (!line) return;
  showCaption(line);
  if (captionQueue.length) setTimeout(drainCaptions, 2800);
}

/** 선택 가리기 안내. 규칙이 바뀌었다는 걸 화면에 계속 남긴다. */
function renderBlindNote(s) {
  const el = $('blind-note');
  const hidden = s.tallyVisible === false && s.phase !== 'idle' && s.phase !== 'lobby';
  el.hidden = !hidden;
  if (hidden) el.textContent = `${s.tallyFrom || 30}명 이하부터는 다른 사람이 무엇을 골랐는지 보이지 않습니다`;
}

// ═══════════════════════════════════════════════ 유틸

const now = () => Date.now() + state.clockOffset;
const pad2 = (n) => String(n).padStart(2, '0');

function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}

/** 문항 텍스트를 단어 단위 마스크 리빌로 세팅한다. 글자 단위로 쪼개지 않는다. */
function splitWords(el, text) {
  el.setAttribute('aria-label', text);
  el.textContent = '';
  let i = 0;
  for (const chunk of text.split(/(\s+)/)) {
    if (!chunk) continue;
    if (/^\s+$/.test(chunk)) { el.appendChild(document.createTextNode(' ')); continue; }
    const mask = document.createElement('span');
    mask.className = 'wmask';
    mask.setAttribute('aria-hidden', 'true');
    const word = document.createElement('span');
    word.className = 'word';
    word.style.setProperty('--i', i++);
    word.textContent = chunk;
    mask.appendChild(word);
    el.appendChild(mask);
  }
  el.classList.remove('is-revealed');
  void el.offsetWidth;
  el.classList.add('is-revealed');
}

function setScreen(name) {
  if (state.screen === name) return;
  state.screen = name;
  body.dataset.screen = name;
}

const DIFF_KO = { easy: '쉬움', medium: '보통', hard: '어려움' };

// ═══════════════════════════════════════════════ 타이머 루프

let rafId = null;

function startTimerLoop() {
  if (rafId) return;
  const step = () => {
    rafId = requestAnimationFrame(step);
    const s = state.snap;
    if (!s || !s.phaseEndsAt) return;

    const remain = s.phaseEndsAt - now();

    if (s.phase === 'question') {
      const ratio = Math.max(0, Math.min(1, remain / (s.questionMs || 10000)));
      $('q-timer-fill').style.transform = `scaleX(${ratio})`;
      $('q-timer').classList.toggle('urgent', remain <= 3000);

      const sec = Math.ceil(remain / 1000);
      if (remain > 0 && remain <= 3000 && sec !== state.lastTickSec) {
        state.lastTickSec = sec;
        Sfx.tick();
      }
    } else if (s.phase === 'sudden') {
      const ratio = Math.max(0, Math.min(1, remain / (s.suddenMs || 20000)));
      $('sd-timer-fill').style.transform = `scaleX(${ratio})`;
      $('sd-timer').classList.toggle('urgent', remain <= 4000);
    } else if (s.phase === 'lobby') {
      $('lobby-countdown').textContent = fmtClock(remain);
    } else if (s.phase === 'revive' && state.screen === 'revive') {
      const ratio = Math.max(0, Math.min(1, remain / 3000));
      $('revive-count').textContent = Math.max(0, Math.ceil(remain / 1000));
      $('revive-bar').style.strokeDashoffset = String(389.6 * (1 - ratio));
    }
  };
  rafId = requestAnimationFrame(step);
}

function stopTimerLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopTimerLoop();
  else startTimerLoop();
});

// ═══════════════════════════════════════════════ 렌더

let lastQIndex = -1;
let lastPhase = null;

function render(s) {
  state.snap = s;
  state.clockOffset = s.serverNow - Date.now();
  const me = s.me;
  if (!me) return;

  initStages();
  if (s.crowd) eachStage((st) => st.setCrowd(s.crowd));
  eachStage((st) => { st.setState(s); if (me.ci !== null) st.setMyIndex(me.ci); });

  // ── 개인 카드
  $('me-name').textContent = me.name;
  $('me-dept').textContent = me.dept;
  $('me-badges').innerHTML = '';
  if (me.isNew) $('me-badges').insertAdjacentHTML('beforeend', '<span class="badge badge-new">새싹</span>');
  if (me.isVip) $('me-badges').insertAdjacentHTML('beforeend', '<span class="badge badge-vip">👑 VIP</span>');

  $('lobby-joined').textContent = s.joined;
  $('lobby-questions').textContent = s.qTotal || 5;
  $('lobby-revives').textContent = me.revives;

  body.dataset.demo = s.demo ? '1' : '0';
  $('lobby-demo').hidden = s.phase !== 'idle';   // 진행 중에는 새 체험을 열지 않는다
  $('rs-replay').hidden = !s.demo;

  renderBlindNote(s);
  runCommentary(s);

  const phaseChanged = s.phase !== lastPhase;
  lastPhase = s.phase;

  switch (s.phase) {
    case 'idle':
      setScreen('lobby');
      $('lobby-countdown').textContent = '--:--';
      break;

    case 'lobby':
      setScreen('lobby');
      $('lobby-countdown').textContent = fmtClock(s.phaseEndsAt - now());
      lastQIndex = -1;
      break;

    case 'question': {
      renderTally(s);
      $('q-index').textContent = pad2(s.qIndex + 1);
      $('q-total').textContent = pad2(s.qTotal);
      $('q-alive').textContent = s.alive;
      $('w-index').textContent = pad2(s.qIndex + 1);
      $('w-total').textContent = pad2(s.qTotal);
      $('w-alive').textContent = s.alive;
      $('w-survived').textContent = me.survived;

      if (s.question && s.qIndex !== lastQIndex) {
        lastQIndex = s.qIndex;
        state.answered = null;
        state.lastTickSec = null;
        splitWords($('q-text'), s.question.text);
        const d = s.question.difficulty || 'easy';
        $('q-diff').dataset.d = d;
        $('q-diff-text').textContent = DIFF_KO[d] || d;
        resetChoices();
        setSendState('', '');
      }
      setScreen(me.alive ? 'question' : 'watch');
      break;
    }

    case 'reveal': {
      const r = s.reveal;
      if (r && phaseChanged) {
        eachStage((st) => st.applyReveal(r));
        $('rv-answer').textContent = r.answer;
        $('rv-answer').className = 'verdict-glyph mono ' + (r.answer === 'O' ? 'verdict-ok' : 'verdict-no');
        $('rv-evidence').textContent = r.evidence || '';
        $('rv-source').textContent = r.source && r.source.title ? `근거 · ${r.source.title}` : '';
        $('rv-cull').textContent = `${r.eliminatedCount}명 탈락 · ${r.alive}명 생존`;

        if (me.correct === true) {
          $('rv-line').textContent = '정답입니다. 살아남았어요.';
          $('rv-line').className = 'verdict-line verdict-ok';
          Sfx.correct();
        } else if (me.correct === false) {
          $('rv-line').textContent = '오답입니다.';
          $('rv-line').className = 'verdict-line verdict-no';
          Sfx.dead();
        } else {
          $('rv-line').textContent = '관전 중입니다.';
          $('rv-line').className = 'verdict-line';
        }
        markChoiceResult(r.answer);
      }
      setScreen('reveal');
      break;
    }

    case 'revive':
      if (me.revivePending) {
        if (phaseChanged) { Sfx.warn(); $('revive-use').disabled = false; $('revive-skip').disabled = false; }
        setScreen('revive');
      } else {
        setScreen('reveal');
      }
      break;

    case 'sudden': {
      $('sd-alive').textContent = s.alive;
      if (s.sudden && phaseChanged) {
        splitWords($('sd-text'), s.sudden.text);
        $('sd-note').textContent = s.sudden.unit
          ? `단위: ${s.sudden.unit} · 동점이면 더 빨리 낸 사람이 이깁니다.`
          : '동점이면 더 빨리 낸 사람이 이깁니다.';
        $('sd-value').value = '';
        $('sd-submit').disabled = false;
        Sfx.warn();
      }
      setScreen(me.inSudden ? 'sudden' : 'watch');
      break;
    }

    case 'result':
      if (phaseChanged) renderResult(s, me);
      setScreen('result');
      break;
  }

  // 관전 화면 공통값
  $('w-alive').textContent = s.alive;
  $('w-survived').textContent = me.survived;
  startTimerLoop();
}

function renderTally(s) {
  // 생존자가 100명 밑으로 떨어지면 서버가 집계를 보내지 않는다.
  // 초반엔 군중을 보고 눈치를 보지만 후반은 혼자 판단해야 한다.
  const hidden = s.tallyVisible === false || s.o === null || s.o === undefined;
  const o = hidden ? 1 : s.o;
  const x = hidden ? 1 : s.x;
  const total = Math.max(1, o + x);

  for (const id of ['bar-o', 'w-bar-o']) $(id).style.flexGrow = String(o / total);
  for (const id of ['bar-x', 'w-bar-x']) $(id).style.flexGrow = String(x / total);
  for (const id of ['num-o', 'w-num-o']) $(id).textContent = hidden ? '?' : o;
  for (const id of ['num-x', 'w-num-x']) $(id).textContent = hidden ? '?' : x;
}

function resetChoices() {
  for (const b of [$('btn-o'), $('btn-x')]) {
    b.setAttribute('aria-pressed', 'false');
    b.classList.remove('burst', 'correct', 'wrong');
    b.disabled = false;
  }
}

function markChoiceResult(answer) {
  const ok = answer === 'O' ? $('btn-o') : $('btn-x');
  const no = answer === 'O' ? $('btn-x') : $('btn-o');
  ok.classList.add('correct');
  no.classList.add('wrong');
}

function renderResult(s, me) {
  const r = s.result;
  if (!r) return;

  if (r.champion) {
    $('rs-crown').textContent = '👑';
    $('rs-label').textContent = '이주의 챔피언';
    $('rs-name').textContent = r.champion.name;
    $('rs-dept').textContent = `${r.champion.dept}${r.champion.isNew ? ' · 새싹' : ''} · ${r.champion.survived}문항 생존`;
    Sfx.champ();
  } else {
    $('rs-crown').textContent = '—';
    $('rs-label').textContent = '전멸';
    $('rs-name').textContent = '챔피언 없음';
    $('rs-dept').textContent = '아무도 끝까지 살아남지 못했습니다.';
  }

  if (r.suddenAnswer) {
    $('rs-sudden-answer').hidden = false;
    $('rs-sudden-text').textContent =
      `서든데스 정답은 ${r.suddenAnswer.value}${r.suddenAnswer.unit || ''}입니다. ${r.suddenAnswer.evidence || ''}`;
    $('rs-sudden-src').textContent = r.sudden && r.sudden.length
      ? r.sudden.map((e) => `${e.name} ${e.value} (오차 ${e.diff})`).join('  ·  ')
      : '';
  } else {
    $('rs-sudden-answer').hidden = true;
  }

  if (r.vip) {
    $('rs-vip').hidden = false;
    const beaten = r.vipBeaten.length;
    $('rs-vip-text').textContent = beaten
      ? `${r.vip.title || 'VIP'} ${r.vip.name}님은 ${r.vip.survived}문항에서 멈췄습니다. ${beaten}명이 넘어섰고, 이분들이 커피 상품권 추첨 대상입니다.`
      : `${r.vip.title || 'VIP'} ${r.vip.name}님이 ${r.vip.survived}문항을 생존했습니다. 아무도 넘지 못했습니다.`;
  } else {
    $('rs-vip').hidden = true;
  }

  const list = $('rs-ranking');
  list.innerHTML = '';
  for (const row of r.ranking) {
    const el = document.createElement('div');
    el.className = 'rank-row' + (row.name === me.name && row.dept === me.dept ? ' me' : '');
    el.innerHTML =
      `<span class="r">${pad2(row.rank)}</span>` +
      `<span>${row.name}${row.vip ? ' 👑' : ''}${row.isNew ? ' 🌱' : ''}` +
      `<span class="s" style="margin-left:8px">${row.dept}</span></span>` +
      `<span class="s">${row.survived}문항 · ${row.points}점</span>`;
    list.appendChild(el);
  }
}

// ═══════════════════════════════════════════════ 통신

/** 세션이 죽었으면 토큰을 버리고 로그인으로 돌려보낸다. */
function dropSession(reason) {
  if (state.es) { state.es.close(); state.es = null; }
  state.token = null;
  sessionStorage.removeItem('t1255');
  $('login-error').textContent = reason || '세션이 만료되었습니다. 다시 입장해 주세요.';
  setScreen('login');
}

async function post(path, payload) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  // 서버 재시작 등으로 토큰이 무효가 되면 조용히 실패하지 않고 즉시 알린다
  if (res.status === 401 && path !== '/api/login') {
    dropSession('서버가 다시 시작되었습니다. 사번을 다시 입력해 주세요.');
  }
  return { ok: res.ok, data };
}

function connect() {
  if (state.es) state.es.close();
  const es = new EventSource(`/api/stream?token=${encodeURIComponent(state.token)}`);
  state.es = es;

  es.addEventListener('state', (e) => { state.retry = 0; render(JSON.parse(e.data)); });

  es.addEventListener('tally', (e) => {
    const t = JSON.parse(e.data);
    if (!state.snap) return;
    Object.assign(state.snap, t);
    renderTally(state.snap);
    $('q-alive').textContent = t.alive;
    $('w-alive').textContent = t.alive;
    eachStage((st) => {
      st.alive = t.alive;
      if (t.choices) st.applyChoices(t.choices);
      else if (t.decided) st.applyDecided(t.decided);
    });
  });

  es.addEventListener('revive', () => Sfx.warn());

  es.addEventListener('kicked', (e) => {
    es.close();
    state.es = null;
    sessionStorage.removeItem('t1255');
    $('login-error').textContent = JSON.parse(e.data).reason || '연결이 종료되었습니다.';
    setScreen('login');
  });

  // 재접속은 0~3초 무작위 지연을 둔다. 450명이 동시에 몰리는 것을 막기 위함이다.
  es.onerror = () => {
    es.close();
    state.es = null;
    const delay = 500 + Math.random() * 2500;
    state.retry += 1;
    if (state.retry < 40) setTimeout(connect, delay);
  };
}

// ═══════════════════════════════════════════════ 입력

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  Sfx.unlock();                       // 오디오는 첫 사용자 제스처에서 해제한다
  $('login-error').textContent = '';
  $('join-btn').disabled = true;

  const { ok, data } = await post('/api/login', { empId: $('empId').value.trim() });
  $('join-btn').disabled = false;

  if (!ok) { $('login-error').textContent = data.error || '입장할 수 없습니다.'; return; }

  state.token = data.token;
  sessionStorage.setItem('t1255', data.token);
  Sfx.select();
  connect();
});

function setSendState(s, text) {
  const el = $('send-state');
  el.dataset.s = s;
  el.textContent = text;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 답안을 확실히 도달시킨다.
 *
 * 네트워크 순간 장애로 답안이 유실되면 그 사람은 틀려서가 아니라 회선 때문에 탈락한다.
 * 이 게임에서 가장 나쁜 버그이므로, 응답 창이 열려 있는 동안 재시도한다.
 * 사용자가 답을 바꾸거나 문항이 넘어가면 즉시 중단한다.
 */
async function submitAnswer(qIndex, answer) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const s = state.snap;
    if (!s || s.qIndex !== qIndex || state.answered !== answer) return; // 낡은 시도
    if (s.phase !== 'question' || now() > s.phaseEndsAt) {
      setSendState('fail', '시간 초과 — 전송되지 않았습니다');
      return;
    }

    const rt = Math.max(0, (s.questionMs || 10000) - (s.phaseEndsAt - now()));
    try {
      const { ok, data } = await post('/api/answer', { token: state.token, qIndex, answer, rt });
      if (ok) { setSendState('ok', `${answer} 전송됨`); return; }
      // 서버가 명시적으로 거절한 경우는 재시도해도 결과가 같다
      if (data && /stale|not accepting|eliminated|invalid/.test(data.error || '')) {
        setSendState('fail', '접수되지 않았습니다');
        return;
      }
    } catch (_) { /* 네트워크 오류 — 재시도한다 */ }

    setSendState('pending', '전송 중…');
    await sleep(120 * (attempt + 1) + Math.random() * 80);
  }
  setSendState('fail', '전송 실패 — 다시 눌러주세요');
}

function choose(answer, btn) {
  const s = state.snap;
  if (!s || s.phase !== 'question' || !s.me.alive) return;

  state.answered = answer;
  $('btn-o').setAttribute('aria-pressed', String(answer === 'O'));
  $('btn-x').setAttribute('aria-pressed', String(answer === 'X'));

  btn.classList.remove('burst');
  void btn.offsetWidth;
  btn.classList.add('burst');
  Sfx.select();

  setSendState('pending', '전송 중…');
  submitAnswer(s.qIndex, answer);
}

$('btn-o').addEventListener('click', (e) => choose('O', e.currentTarget));
$('btn-x').addEventListener('click', (e) => choose('X', e.currentTarget));

$('revive-use').addEventListener('click', () => {
  $('revive-use').disabled = true; $('revive-skip').disabled = true;
  Sfx.correct();
  post('/api/revive', { token: state.token, use: true });
});

$('revive-skip').addEventListener('click', () => {
  $('revive-use').disabled = true; $('revive-skip').disabled = true;
  post('/api/revive', { token: state.token, use: false });
});

$('sudden-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const s = state.snap;
  const v = Number($('sd-value').value);
  if (!Number.isFinite(v)) return;
  $('sd-submit').disabled = true;
  $('sd-submit').textContent = '제출됨';
  Sfx.select();
  const rt = Math.max(0, (s.suddenMs || 20000) - (s.phaseEndsAt - now()));
  post('/api/sudden', { token: state.token, value: v, rt });
});

$('rs-again').addEventListener('click', () => setScreen('lobby'));

// ═══════════════════════════════════════════════ 체험 모드

const demoOpts = { role: 'new', bots: 80, lobby: 3 };

/** 역할별 시연용 사번 (5자리). 명부에 등록된 사번을 그대로 쓴다. */
function demoEmpId(role) {
  if (role === 'vip') return '95001';     // 김원장
  if (role === 'normal') return '15029';  // 임특허 · 11년차
  return '26005';                         // 조새싹 · 0년차 · 부활권 대상
}

function bindChips(attr, key) {
  for (const chip of document.querySelectorAll(`[data-${attr}]`)) {
    chip.addEventListener('click', () => {
      for (const sib of chip.parentElement.children) sib.setAttribute('aria-pressed', 'false');
      chip.setAttribute('aria-pressed', 'true');
      const raw = chip.dataset[attr];
      demoOpts[key] = attr === 'role' ? raw : Number(raw);
    });
  }
}

bindChips('role', 'role');
bindChips('bots', 'bots');
bindChips('lobby', 'lobby');

$('demo-open').addEventListener('click', () => {
  Sfx.unlock();
  $('opt-role').hidden = !!state.token; // 이미 입장했다면 지금 신분을 그대로 쓴다
  $('demo-error').textContent = '';
  setScreen('demo');
});

$('demo-back').addEventListener('click', () => setScreen(state.token ? 'lobby' : 'login'));

$('lobby-demo').addEventListener('click', () => {
  Sfx.unlock();
  $('opt-role').hidden = true;
  $('demo-error').textContent = '';
  setScreen('demo');
});

async function startDemo() {
  $('demo-start').disabled = true;
  $('demo-error').textContent = '';

  try {
    // 아직 입장하지 않았다면 고른 역할로 먼저 입장한다
    if (!state.token) {
      const { ok, data } = await post('/api/login', { empId: demoEmpId(demoOpts.role) });
      if (!ok) throw new Error(data.error || '입장에 실패했습니다.');
      state.token = data.token;
      sessionStorage.setItem('t1255', data.token);
      connect();
      await sleep(250); // 스트림이 열릴 때까지 잠깐 기다린다
    }

    const { ok, data } = await post('/api/demo/start', {
      token: state.token, bots: demoOpts.bots, lobbySec: demoOpts.lobby,
    });
    if (!ok) throw new Error(data.error || '시작할 수 없습니다.');
    Sfx.select();
  } catch (err) {
    $('demo-error').textContent = err.message;
  } finally {
    $('demo-start').disabled = false;
  }
}

$('demo-start').addEventListener('click', startDemo);
$('rs-replay').addEventListener('click', startDemo);

$('narration-toggle').addEventListener('click', (e) => {
  Sfx.narrationOn = !Sfx.narrationOn;
  if (!Sfx.narrationOn) Sfx.silence();
  else Sfx.say('나레이션을 켰습니다.');
  e.currentTarget.setAttribute('aria-pressed', String(Sfx.narrationOn));
  e.currentTarget.textContent = Sfx.narrationOn ? '나레이션 켜짐' : '나레이션 꺼짐';
});

// 키보드 지원 (데스크톱 관전자·운영자 테스트용)
document.addEventListener('keydown', (e) => {
  if (state.screen !== 'question') return;
  if (e.key === 'o' || e.key === 'O' || e.key === 'ArrowLeft') $('btn-o').click();
  if (e.key === 'x' || e.key === 'X' || e.key === 'ArrowRight') $('btn-x').click();
});

// ═══════════════════════════════════════════════ 부팅

// 저장된 토큰이 아직 살아 있는지 먼저 확인한다.
// 죽은 토큰으로 스트림을 열면 계속 재접속만 시도하며 화면이 멈춘 것처럼 보인다.
(async () => {
  if (!state.token) return;
  const { ok } = await post('/api/session', { token: state.token });
  if (ok) connect();
})();

startTimerLoop();

// ── 화면별 픽스처. 서버 없이 각 화면을 바로 확인할 수 있다.
//    예) /?screen=reveal   /?screen=revive   /?screen=champion
const fixture = new URLSearchParams(location.search).get('screen');
if (fixture) {
  const demo = {
    phase: 'idle', serverNow: Date.now(), phaseEndsAt: 0, joined: 312, alive: 37,
    qIndex: 2, qTotal: 5, o: 214, x: 98, feed: [], result: null,
    question: { text: 'PCT 국제출원을 하면 지정한 모든 국가에 자동으로 특허가 등록된다.', difficulty: 'hard' },
    sudden: { text: '발명왕 에디슨이 생전에 취득한 미국 특허는 모두 몇 건일까?', unit: '건' },
    reveal: { answer: 'X', evidence: 'PCT는 국제출원 절차일 뿐이며, 각 지정국의 국내단계 진입과 개별 심사가 필요하다.',
              source: { title: '특허협력조약(PCT) 제도 안내' }, o: 214, x: 98, eliminatedCount: 214, alive: 37 },
    me: { name: '조새싹', dept: '정보서비스실', years: 0, isNew: true, isVip: false,
          alive: true, revives: 1, survived: 2, correct: false, revivePending: true, inSudden: true, points: 25 },
  };
  const map = {
    lobby: 'lobby', question: 'question', reveal: 'reveal', revive: 'revive',
    eliminated: 'question', suddendeath: 'sudden', champion: 'result',
  };
  demo.phase = { lobby: 'lobby', question: 'question', reveal: 'reveal', revive: 'revive',
                 eliminated: 'question', suddendeath: 'sudden', champion: 'result' }[fixture] || 'lobby';
  if (fixture === 'eliminated') demo.me.alive = false;
  if (fixture === 'champion') {
    demo.result = {
      champion: { name: '조새싹', dept: '정보서비스실', isNew: true, survived: 5 },
      ranking: [
        { rank: 1, name: '조새싹', dept: '정보서비스실', survived: 5, points: 105, isNew: true, vip: false },
        { rank: 2, name: '김원장', dept: '원장실', survived: 4, points: 45, isNew: false, vip: true },
        { rank: 3, name: '한분석', dept: '데이터실', survived: 4, points: 45, isNew: false, vip: false },
      ],
      sudden: [{ name: '조새싹', value: 1100, diff: 7, rt: 4210 }],
      suddenAnswer: { value: 1093, unit: '건', evidence: '토머스 에디슨은 미국에서 1,093건의 특허를 취득했다.' },
      vip: { name: '김원장', title: '원장', survived: 4 },
      vipBeaten: [{ name: '조새싹', dept: '정보서비스실' }],
      totalPlayers: 312,
    };
  }
  demo.phaseEndsAt = Date.now() + (demo.phase === 'sudden' ? 15000 : demo.phase === 'revive' ? 3000 : 7000);
  lastPhase = null;
  render(demo);
  void map;
}
