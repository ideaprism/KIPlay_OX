'use strict';

/**
 * 12:55 — 배경음악
 *
 * 수노(Suno)에서 유료 제작한 두 곡을 튼다.
 *
 *   kipi-esports.wav (19초)   개장 로고송. 게임이 시작되기 전 대기 구간에
 *                             1분에 한 번씩 울린다. 12시 55분이 다가온다는 신호다.
 *   crown-of-valor.wav (102초) 우승곡. 챔피언이 확정되는 순간 곧바로 튼다.
 *                             곡의 좋은 부분을 기다리게 하지 않는 것이 요점이다.
 *
 * 브라우저는 사용자 제스처 없이 소리를 못 낸다. enable()이 그 제스처 자리에서
 * 불려야 하고(전광판의 '준비 완료', 체험 시작 버튼), 그전의 재생 요청은 무시된다.
 * 재생 실패는 전부 조용히 삼킨다 —— 음악이 안 나와도 게임은 돌아가야 한다.
 */

(function (global) {
  const TRACKS = {
    lobby: { src: 'audio/kipi-esports.wav', volume: 0.6 },
    crown: { src: 'audio/crown-of-valor.wav', volume: 0.9 },
  };

  const players = {};
  for (const [key, t] of Object.entries(TRACKS)) {
    const a = new Audio(t.src);
    a.preload = 'auto';
    a.volume = t.volume;
    players[key] = a;
  }

  let enabled = false;
  let lobbyTimer = null;
  let lastLobbyStart = 0;
  const LOBBY_EVERY_MS = 60000;   // 1분에 한 번

  function playFromTop(key) {
    const a = players[key];
    try { a.currentTime = 0; } catch (e) { /* 아직 메타데이터 전이면 그냥 처음부터다 */ }
    a.play().catch(() => { /* 자동재생 차단 등 — 게임은 계속 간다 */ });
  }

  function lobbyTick() {
    if (!enabled) return;
    if (players.lobby.paused && Date.now() - lastLobbyStart >= LOBBY_EVERY_MS) {
      lastLobbyStart = Date.now();
      playFromTop('lobby');
    }
  }

  const Music = {
    /** 사용자 제스처 안에서 불러야 한다. 여기서 두 곡을 예열해 둔다. */
    enable() {
      if (enabled) return;
      enabled = true;
      for (const a of Object.values(players)) a.load();
    },

    /**
     * 대기 구간 로고송. on이면 즉시 한 번 울리고 이후 1분에 한 번씩 반복한다.
     * off면 다음 예약만 멈춘다 —— 흐르던 곡을 끊지는 않는다. 19초짜리 로고송이
     * 대기실 끝자락에 걸쳐도 문항 브리핑을 해치지 않고, 뚝 끊기는 게 더 어색하다.
     */
    lobby(on) {
      if (!on) {
        clearInterval(lobbyTimer);
        lobbyTimer = null;
        return;
      }
      if (!enabled || lobbyTimer) return;
      lobbyTick();
      lobbyTimer = setInterval(lobbyTick, 1000);
    },

    /**
     * 접속 직후의 자동 재생 시도.
     *
     * 링크를 열고 게임 화면이 뜨면 잠깐 뒤 로고송이 울린다. 브라우저가 제스처 없는
     * 재생을 막으면(대부분의 폰이 그렇다) 조용히 물러났다가, 첫 터치·키 입력에서
     * 곧바로 이어서 튼다. 어느 쪽이든 게임은 멈추지 않는다.
     */
    autoJingle(delayMs) {
      setTimeout(() => {
        enabled = true;
        for (const a of Object.values(players)) a.load();
        lastLobbyStart = Date.now();
        const a = players.lobby;
        try { a.currentTime = 0; } catch (e) { /* 메타데이터 전이면 그냥 처음부터 */ }
        a.play().catch(() => {
          const once = () => {
            document.removeEventListener('pointerdown', once);
            document.removeEventListener('keydown', once);
            lastLobbyStart = Date.now();
            playFromTop('lobby');
          };
          document.addEventListener('pointerdown', once);
          document.addEventListener('keydown', once);
        });
      }, delayMs || 1000);
    },

    /**
     * 로고송을 지금 즉시 한 번. 1분 주기 가드를 무시한다.
     * 체험 시작처럼 "새로 시작한다"는 순간에는 최근에 울렸더라도 다시 울려야 한다.
     */
    jingle() {
      if (!enabled) return;
      lastLobbyStart = Date.now();
      playFromTop('lobby');
    },

    /** 우승 확정 — 곧바로 처음부터. 이미 흐르는 중이면 그대로 둔다. */
    crown() {
      if (!enabled) return;
      if (!players.crown.paused) return;
      playFromTop('crown');
    },

    /** 다음 회차가 시작되면 우승곡을 걷는다. */
    stopCrown() {
      const a = players.crown;
      if (!a.paused) a.pause();
    },

    /** 화면이 가려졌을 때 등 — 전부 멈춘다. 대기 예약도 함께. */
    stopAll() {
      this.lobby(false);
      for (const a of Object.values(players)) if (!a.paused) a.pause();
    },
  };

  global.Music = Music;
})(window);
