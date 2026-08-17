'use strict';

/**
 * 12:55 — 전광판
 *
 * 군중 무대(crowd.js)를 띄우고 서버 이벤트를 그 위에 얹는다.
 * 인증 없이 /api/spectate 만 구독하며, 하루 종일 켜둘 수 있어야 하므로
 * 화면이 가려지면 루프를 멈추고 복귀 시 서버 시계로 다시 맞춘다.
 */

const $ = (id) => document.getElementById(id);

let snap = null;
let clockOffset = 0;
let rafId = null;
let feedSeen = 0;
let dropTimer = null;
let stage = null;
let audioReady = false;
let lastPhase = null;
let lastQIndex = -1;
let countdownAt = null;

const now = () => Date.now() + clockOffset;
const pad2 = (n) => String(n).padStart(2, '0');

function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}

const SCENE_KO = {
  lobby: '로비', office: '사무실', review: '심사실',
  archive: '서고', datacenter: '전산실', rooftop: '옥상',
};

// ─────────────────────────────────────────── 무대

function initStage() {
  stage = new CrowdStage($('stage-canvas'), { zones: true });
  stage.start();
}

function drawTower() {
  const cv = $('tower-canvas');
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(r.width * dpr);
  cv.height = Math.round(r.height * dpr);
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, r.width, r.height);
  if (stage) stage.drawTower(c, 0, 0, r.width, r.height, 6);
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

  // 다음 문항 3초 전 카운트다운. 대기실과 정답 공개의 꼬리를 그대로 쓴다.
  if (audioReady && (snap.phase === 'lobby' || snap.phase === 'reveal')) {
    const sec = Math.ceil(remain / 1000);
    if (remain > 0 && sec <= 3 && sec !== countdownAt) {
      countdownAt = sec;
      Sfx.countTick(sec);
    }
    if (remain > 3200) countdownAt = null;
  }
}

function startLoop() { if (!rafId) rafId = requestAnimationFrame(loop); }
function stopLoop() { if (rafId) cancelAnimationFrame(rafId); rafId = null; }

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopLoop(); if (stage) stage.stop(); }
  else { startLoop(); if (stage) stage.start(); }
});

// ─────────────────────────────────────────── 렌더

function renderSplit(s) {
  const box = $('b-split');
  const hidden = s.tallyVisible === false;
  box.classList.toggle('hidden', hidden);

  if (hidden) {
    $('b-num-o').textContent = 'O ?';
    $('b-num-x').textContent = '? X';
    $('b-fill-o').style.width = '50%';
    $('b-fill-x').style.width = '50%';
    return;
  }
  const o = s.o || 0;
  const x = s.x || 0;
  const total = Math.max(1, o + x);
  $('b-fill-o').style.width = `${(o / total) * 100}%`;
  $('b-fill-x').style.width = `${(x / total) * 100}%`;
  $('b-num-o').textContent = `O ${o}`;
  $('b-num-x').textContent = `${x} X`;
}

function renderLegend(divisions) {
  const box = $('b-legend');
  if (!divisions || box.dataset.done) return;
  box.dataset.done = '1';
  box.innerHTML = '';
  for (const d of divisions) {
    const el = document.createElement('div');
    el.innerHTML = `<i style="background:${d.color}"></i>${d.short || d.name}`;
    box.appendChild(el);
  }
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
  while (box.children.length > 14) box.lastChild.remove();
}

function showCenter(on) { $('b-center').hidden = !on; }

function render(s) {
  snap = s;
  clockOffset = s.serverNow - Date.now();

  if (s.crowd) { stage.setCrowd(s.crowd); renderLegend(s.crowd.divisions); }
  stage.setState(s);

  $('b-round').textContent = s.round ? pad2(s.round) : '—';
  $('b-joined').textContent = s.joined;
  $('b-q').textContent = s.qIndex >= 0 ? `${pad2(s.qIndex + 1)} / ${pad2(s.qTotal)}` : '— / —';
  $('b-alive').textContent = s.alive;
  $('t-floor').textContent = `${s.floor || 1}F`;
  $('t-scene').textContent = SCENE_KO[s.scene] || '';
  drawTower();

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

  const phaseChanged = s.phase !== lastPhase;
  lastPhase = s.phase;

  switch (s.phase) {
    case 'idle':
      showCenter(true);
      $('b-center-label').textContent = '대기 중';
      $('b-center-big').textContent = '12:55';
      $('b-center-big').className = 'huge mono';
      $('b-center-floor').hidden = true;
      $('b-center-sub').textContent = '매주 월요일 점심시간 마지막 5분';
      $('b-center-list').hidden = true;
      lastQIndex = -1;
      break;

    case 'lobby':
      showCenter(true);
      $('b-center-label').textContent = '시작까지';
      $('b-center-big').className = 'huge mono';
      $('b-center-big').textContent = fmtClock(s.phaseEndsAt - now());
      $('b-center-floor').hidden = true;
      $('b-center-sub').textContent = `${s.joined}명 입장`;
      $('b-center-list').hidden = true;
      if (phaseChanged && audioReady) Sfx.say('잠시 후 시작합니다.');
      break;

    case 'question':
      showCenter(false);
      $('b-split').hidden = false;
      $('b-question').textContent = s.question ? s.question.text : '';
      $('b-drop').textContent = '';
      renderSplit(s);
      if (s.qIndex !== lastQIndex) {
        lastQIndex = s.qIndex;
        if (audioReady) {
          Sfx.gong();
          const diff = s.question && s.question.difficulty;
          const ko = diff === 'hard' ? '어려움' : diff === 'medium' ? '보통' : '쉬움';
          setTimeout(() => Sfx.say(`${s.qIndex + 1}번 문항. 난이도 ${ko}.`), 900);
        }
      }
      break;

    case 'reveal': {
      showCenter(false);
      const r = s.reveal;
      if (r && phaseChanged) {
        stage.applyReveal(r);
        renderSplit({ ...s, o: r.o, x: r.x, tallyVisible: true });
        if (r.eliminatedCount > 0) {
          $('b-drop').textContent = `−${r.eliminatedCount}`;
          clearTimeout(dropTimer);
          dropTimer = setTimeout(() => { $('b-drop').textContent = ''; }, 3200);
        }
        if (audioReady) {
          Sfx.correct();
          if (r.alive > 0) setTimeout(() => Sfx.rise(), 400);
          setTimeout(() => Sfx.say(
            r.alive > 0
              ? `정답 ${r.answer === 'O' ? '오' : '엑스'}. ${r.eliminatedCount}명 탈락. ${r.alive}명이 ${r.toFloor}층으로 올라갑니다.`
              : `정답 ${r.answer === 'O' ? '오' : '엑스'}. 전원 탈락.`,
          ), 1100);
        }
      }
      break;
    }

    case 'revive':
      showCenter(false);
      break;

    case 'sudden':
      showCenter(false);
      $('b-question').textContent = s.sudden ? s.sudden.text : '';
      $('b-drop').textContent = 'SUDDEN DEATH';
      $('b-split').hidden = true; // 서든데스는 O/X가 아니라 숫자 입력이다
      if (phaseChanged && audioReady) {
        Sfx.gong({ freq: 74, gain: 0.55 });
        setTimeout(() => Sfx.say('서든데스. 가장 가까운 숫자가 이깁니다.'), 900);
      }
      break;

    case 'result': {
      showCenter(true);
      const r = s.result;
      $('b-center-label').textContent = r && r.champion ? '이주의 챔피언' : '전멸';
      $('b-center-big').className = 'champ-name';
      $('b-center-big').textContent = r && r.champion ? r.champion.name : '챔피언 없음';

      if (r && r.champion) {
        $('b-center-floor').hidden = false;
        $('b-center-floor').textContent = `${r.floor}층에서 우승`;
        $('b-center-sub').textContent = `${r.champion.dept} · ${r.champion.survived}문항 생존 · 총 ${r.totalPlayers}명 참가`;
      } else {
        $('b-center-floor').hidden = true;
        $('b-center-sub').textContent = '아무도 끝까지 살아남지 못했습니다.';
      }

      // 승자는 층과 무관하게 옥상으로 올라가 도시를 내려다본다
      stage.scene = 'rooftop';
      stage.riseT = 0;

      const list = $('b-center-list');
      list.hidden = false;
      list.innerHTML = '';
      for (const row of (r ? r.ranking : []).slice(0, 6)) {
        const el = document.createElement('div');
        el.className = 'row';
        el.innerHTML =
          `<span class="r">${pad2(row.rank)}</span>` +
          `<span>${row.name}${row.vip ? ' 👑' : ''}${row.isNew ? ' 🌱' : ''} <span class="s">${row.dept}</span></span>` +
          `<span class="s">${row.survived}문항 · ${row.points}점</span>`;
        list.appendChild(el);
      }

      if (phaseChanged && audioReady) {
        Sfx.champ();
        setTimeout(() => Sfx.say(
          r && r.champion
            ? `${r.floor}층. 오늘의 챔피언은 ${r.champion.dept} ${r.champion.name}님입니다.`
            : '전원 탈락. 챔피언이 나오지 않았습니다.',
        ), 1000);
      }
      break;
    }
  }

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
    renderSplit(snap);
    $('b-alive').textContent = t.alive;
    $('b-joined').textContent = t.joined;
    stage.alive = t.alive;
    if (t.choices) stage.applyChoices(t.choices);
    else if (t.decided) stage.applyDecided(t.decided);
  });

  es.onerror = () => {
    es.close();
    setTimeout(connect, 500 + Math.random() * 2500);
  };
}

// ─────────────────────────────────────────── 부팅

$('audio-go').addEventListener('click', () => {
  audioReady = Sfx.unlock();
  Sfx.gong({ gain: 0.35 });
  setTimeout(() => Sfx.say('전광판 준비 완료.'), 700);
  $('audio-gate').hidden = true;
});

initStage();
connect();
startLoop();
window.addEventListener('resize', drawTower);
