'use strict';

/**
 * 12:55 — 중계
 *
 * 상태 변화를 읽어 이번에 할 말을 만든다. 화면에 자막으로 띄우고 동시에 읽는다.
 * 소리가 안 나오는 환경에서도 진행이 끊기지 않아야 하므로 텍스트가 먼저고 음성이 나중이다.
 *
 * 급하게 몰아붙이지 않는 것이 목적이다. 숫자만 읽어주는 게 아니라
 * 룰이 바뀌는 지점, 본부별 판세, 결승 진입 같은 "지금 무슨 상황인지"를 말해준다.
 */

(function (global) {
  const DIFF_KO = { easy: '쉬움', medium: '보통', hard: '어려움' };
  const SPOKEN = { O: '오', X: '엑스' };

  /** 본부별 생존자를 많은 순으로 정리한다. */
  function divisionRank(s) {
    const counts = s.divAlive || {};
    const names = new Map((s.divisionNames || []).map((d) => [d.id, d]));
    return Object.entries(counts)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => ({ id, n, name: (names.get(id) || {}).name || id, short: (names.get(id) || {}).short || id }));
  }

  class Commentary {
    constructor() { this.reset(0); }

    reset(round) {
      this.round = round;
      this.lastPhase = null;
      this.lastQIndex = -1;
      this.saidThreshold = false;
      this.saidFinal = false;
      this.saidVipOut = false;
      this.lastFloor = 1;
    }

    /**
     * 이번 상태에서 새로 할 말을 배열로 돌려준다.
     * 각 항목은 { text, say, tone } — text는 자막, say는 읽을 문장(없으면 text를 읽는다).
     */
    update(s) {
      if (!s) return [];
      if (s.round !== this.round) this.reset(s.round);

      const out = [];
      const phaseChanged = s.phase !== this.lastPhase;
      const alive = s.alive || 0;
      const threshold = s.tallyFrom || 30;

      if (phaseChanged && s.phase === 'lobby') {
        out.push({ text: `잠시 후 시작합니다. 현재 ${s.joined}명 입장.`, tone: 'calm' });
      }

      if (s.phase === 'question' && s.qIndex !== this.lastQIndex) {
        this.lastQIndex = s.qIndex;
        const d = s.question && s.question.difficulty;
        const first = s.qIndex === 0;
        out.push({
          text: first
            ? `첫 문항입니다. 난이도 ${DIFF_KO[d] || '쉬움'}.`
            : `${s.qIndex + 1}번 문항. 난이도 ${DIFF_KO[d] || ''}.`,
          tone: 'cue',
        });
        if (!first && alive > 0 && alive <= 10) {
          out.push({ text: `남은 인원 ${alive}명.`, tone: 'calm' });
        }
      }

      if (phaseChanged && s.phase === 'reveal' && s.reveal) {
        const r = s.reveal;
        out.push({
          text: `정답은 ${r.answer}입니다.`,
          say: `정답은 ${SPOKEN[r.answer] || r.answer}입니다.`,
          tone: r.answer === 'O' ? 'good' : 'good',
        });

        if (r.alive === 0) {
          out.push({ text: '전원 탈락했습니다.', tone: 'bad' });
        } else if (r.eliminatedCount === 0) {
          out.push({ text: `전원 통과. ${r.alive}명이 ${r.toFloor}층으로 올라갑니다.`, tone: 'good' });
        } else {
          out.push({
            text: `${r.eliminatedCount}명 탈락. ${r.alive}명이 ${r.toFloor}층으로 올라갑니다.`,
            tone: 'bad',
          });
        }
      }

      // ── 룰이 바뀌는 지점. 이건 반드시 알려야 한다.
      if (!this.saidThreshold && alive > 0 && alive < threshold && s.phase !== 'idle') {
        this.saidThreshold = true;
        out.push({
          text: `이제부터 다른 사람의 선택은 보이지 않습니다. 스스로 판단하세요.`,
          tone: 'rule',
        });
      }

      // ── 10명 이하가 되면 본부별 판세를 읽어준다.
      if (phaseChanged && s.phase === 'reveal' && alive > 1 && alive <= 10) {
        const rank = divisionRank(s);
        if (rank.length) {
          const breakdown = rank.map((d) => `${d.short} ${d.n}명`).join(', ');
          const lead = rank.length > 1 && rank[0].n === rank[1].n
            ? `${rank[0].n}명씩으로 팽팽합니다.`
            : `${rank[0].name}가 ${rank[0].n}명으로 가장 많습니다.`;
          out.push({ text: `${breakdown}. ${lead}`, tone: 'calm' });
        }
      }

      // ── VIP 탈락
      if (!this.saidVipOut && s.vip && s.vip.alive === false && s.phase !== 'idle') {
        this.saidVipOut = true;
        out.push({ text: `${s.vip.title || 'VIP'} ${s.vip.name} 탈락하셨습니다.`, tone: 'bad' });
      }

      // ── 결승
      if (!this.saidFinal && alive === 2 && (s.phase === 'reveal' || s.phase === 'question')) {
        this.saidFinal = true;
        out.push({ text: '결승입니다. 단 두 명 남았습니다.', tone: 'cue' });
      }

      if (phaseChanged && s.phase === 'sudden') {
        out.push({ text: '서든데스. 정답에 가장 가까운 숫자가 이깁니다.', tone: 'cue' });
      }

      if (phaseChanged && s.phase === 'result' && s.result) {
        const r = s.result;
        out.push(
          r.champion
            ? { text: `${r.floor}층. 오늘의 챔피언은 ${r.champion.dept} ${r.champion.name}님입니다.`, tone: 'good' }
            : { text: '전원 탈락. 챔피언이 나오지 않았습니다.', tone: 'bad' },
        );
        if (r.champion && r.vipBeaten && r.vipBeaten.length) {
          out.push({ text: `${r.vipBeaten.length}명이 ${r.vip ? r.vip.title || 'VIP' : 'VIP'}를 넘어섰습니다.`, tone: 'calm' });
        }
      }

      this.lastPhase = s.phase;
      if (s.floor) this.lastFloor = s.floor;
      return out;
    }
  }

  global.Commentary = Commentary;
  global.divisionRank = divisionRank;
})(window);
