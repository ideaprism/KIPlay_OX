'use strict';

/**
 * 12:55 — 전광판 (관전 전용)
 *
 * 인증 없이 /api/spectate 스트림만 구독한다. 입력 요소가 없고, 하루 종일 켜둘 수 있어야 하므로
 * 타이머 루프는 화면이 가려지면 즉시 정지하고 복귀 시 서버 시계로 다시 맞춘다.
 */

const $ = (id) => document.getElementById(id);

let snap = null;
let clockOffset = 0;
let rafId = null;
let feedSeen = 0;
let prevAlive = null;
let dropTimer = null;

const now = () => Date.now() + clockOffset;
const pad2 = (n) => String(n).padStart(2, '0');

function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}

// ─────────────────────────────────────────── 타이머 루프

function loop() {
  rafId = requestAnimationFrame(loop);
  if (!snap || !snap.phaseEndsAt) return;

  const remain = snap.phaseEndsAt - now();

  if (snap.phase === 'question' || snap.phase === 'sudden') {
    const total = snap.phase === 'sudden' ? 15000 : 7000;
    $('b-timer-fill').style.transform = `scaleX(${Math.max(0, Math.min(1, remain / total))})`;
    $('b-timer').classList.toggle('urgent', remain <= 3000);
  } else if (snap.phase === 'lobby') {
    $('b-center-big').textContent = fmtClock(remain);
  }
}

function startLoop() { if (!rafId) rafId = requestAnimationFrame(loop); }
function stopLoop() { if (rafId) cancelAnimationFrame(rafId); rafId = null; }

document.addEventListener('visibilitychange', () => (document.hidden ? stopLoop() : startLoop()));

// ─────────────────────────────────────────── 렌더

function showPlay(on) {
  $('b-play').hidden = !on;
  $('b-center').hidden = on;
}

function renderTally(s) {
  const o = s.o || 0;
  const x = s.x || 0;
  const total = Math.max(1, o + x);
  $('b-fill-o').style.width = `${(o / total) * 100}%`;
  $('b-fill-x').style.width = `${(x / total) * 100}%`;
  $('b-num-o').textContent = o;
  $('b-num-x').textContent = x;
}

function markAnswer(answer) {
  $('b-row-o').classList.toggle('hit', answer === 'O');
  $('b-row-o').classList.toggle('miss', answer !== 'O');
  $('b-row-x').classList.toggle('hit', answer === 'X');
  $('b-row-x').classList.toggle('miss', answer !== 'X');
}

function clearAnswerMarks() {
  for (const el of [$('b-row-o'), $('b-row-x')]) el.classList.remove('hit', 'miss');
}

function renderFeed(feed) {
  const box = $('b-feed');
  if (feed.length < feedSeen) { box.innerHTML = ''; feedSeen = 0; }
  for (let i = feedSeen; i < feed.length; i += 1) {
    const f = feed[i];
    const el = document.createElement('div');
    el.className = 'feed-item' + (f.revived ? ' revived' : '') + (f.vip ? ' vip' : '');
    el.innerHTML =
      `<span class="nm">${f.name}${f.vip ? ' 👑' : ''}</span>` +
      `<span class="dp">${f.dept}</span>` +
      `<span class="q mono">${f.revived ? '부활' : `Q${f.q}`}</span>`;
    box.prepend(el);
  }
  feedSeen = feed.length;
  while (box.children.length > 16) box.lastChild.remove();
}

function render(s) {
  snap = s;
  clockOffset = s.serverNow - Date.now();

  $('b-round').textContent = s.round ? pad2(s.round) : '—';
  $('b-joined').textContent = s.joined;
  $('b-q').textContent = s.qIndex >= 0 ? `${pad2(s.qIndex + 1)} / ${pad2(s.qTotal)}` : '— / —';

  if (s.vip) {
    $('b-vip').hidden = false;
    $('b-vip').dataset.alive = String(s.vip.alive);
    $('b-vip-text').textContent = s.vip.alive
      ? `${s.vip.title || 'VIP'} ${s.vip.name} 생존 중`
      : `${s.vip.title || 'VIP'} ${s.vip.name} 탈락`;
  } else {
    $('b-vip').hidden = true;
  }

  renderFeed(s.feed || []);

  switch (s.phase) {
    case 'idle':
      showPlay(false);
      $('b-center-label').textContent = '대기 중';
      $('b-center-big').textContent = '12:55';
      $('b-center-sub').textContent = '매주 월요일 점심시간 마지막 5분';
      $('b-center-list').hidden = true;
      break;

    case 'lobby':
      showPlay(false);
      $('b-center-label').textContent = '시작까지';
      // 프레임 루프를 기다리지 않고 즉시 반영한다. 모니터가 프레임을 스로틀해도 낡은 값이 남지 않는다.
      $('b-center-big').textContent = fmtClock(s.phaseEndsAt - now());
      $('b-center-sub').textContent = `${s.joined}명 입장`;
      $('b-center-list').hidden = true;
      prevAlive = null;
      break;

    case 'question':
      showPlay(true);
      clearAnswerMarks();
      $('b-question').textContent = s.question ? s.question.text : '';
      $('b-alive').textContent = s.alive;
      $('b-drop').textContent = '';
      renderTally(s);
      break;

    case 'reveal': {
      showPlay(true);
      const r = s.reveal;
      if (r) {
        markAnswer(r.answer);
        renderTally({ o: r.o, x: r.x });
        $('b-alive').textContent = r.alive;
        if (r.eliminatedCount > 0) {
          $('b-drop').textContent = `−${r.eliminatedCount}`;
          clearTimeout(dropTimer);
          dropTimer = setTimeout(() => { $('b-drop').textContent = ''; }, 2600);
        }
      }
      break;
    }

    case 'revive':
      showPlay(true);
      $('b-alive').textContent = s.alive;
      break;

    case 'sudden':
      showPlay(true);
      clearAnswerMarks();
      $('b-question').textContent = s.sudden ? s.sudden.text : '';
      $('b-alive').textContent = s.alive;
      $('b-drop').textContent = 'SUDDEN DEATH';
      renderTally({ o: 0, x: 0 });
      break;

    case 'result': {
      showPlay(false);
      const r = s.result;
      $('b-center-label').textContent = r && r.champion ? '이주의 챔피언' : '전멸';
      $('b-center-big').textContent = '';
      $('b-center-big').className = 'champ-name';
      $('b-center-big').textContent = r && r.champion ? r.champion.name : '챔피언 없음';
      $('b-center-sub').textContent = r && r.champion
        ? `${r.champion.dept} · ${r.champion.survived}문항 생존 · 총 ${r.totalPlayers}명 참가`
        : '아무도 끝까지 살아남지 못했습니다.';

      const list = $('b-center-list');
      list.hidden = false;
      list.innerHTML = '';
      for (const row of (r ? r.ranking : []).slice(0, 8)) {
        const el = document.createElement('div');
        el.className = 'row';
        el.innerHTML =
          `<span class="r">${pad2(row.rank)}</span>` +
          `<span>${row.name}${row.vip ? ' 👑' : ''}${row.isNew ? ' 🌱' : ''} <span class="s">${row.dept}</span></span>` +
          `<span class="s">${row.survived}문항 · ${row.points}점</span>`;
        list.appendChild(el);
      }
      break;
    }
  }

  // 결과 화면을 벗어나면 큰 숫자 스타일을 되돌린다
  if (s.phase !== 'result') $('b-center-big').className = 'huge mono';

  startLoop();
}

// ─────────────────────────────────────────── 연결

function connect() {
  const es = new EventSource('/api/spectate');

  es.addEventListener('state', (e) => render(JSON.parse(e.data)));

  es.addEventListener('tally', (e) => {
    const t = JSON.parse(e.data);
    if (!snap || snap.phase !== 'question') return;
    Object.assign(snap, t);
    renderTally(snap);
    $('b-alive').textContent = t.alive;
    $('b-joined').textContent = t.joined;
  });

  es.onerror = () => {
    es.close();
    setTimeout(connect, 500 + Math.random() * 2500);
  };
}

connect();
startLoop();
