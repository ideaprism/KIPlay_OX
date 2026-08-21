'use strict';

/**
 * 12:55 — 엔딩 카드 · 등록특허공보 표제부
 *
 * 우승 장면은 게임 화면 안에 끼워 넣지 않고 끊어서 보여준다.
 *
 * 그런데 이 게임의 우승 장면은 그냥 그림이 아니다. 등록특허공보 한 장을 발행한다.
 * 이번 주 챔피언에게 특허를 내주는 형식이다 —— (54) 발명의 명칭 자리에 그 사람이,
 * (73) 특허권자 자리에 한국특허정보원이, 마지막에 인주 도장이 찍힌다.
 *
 * 레이아웃과 INID 코드는 실제 공보를 그대로 따랐다. 첨부된 두 건이 근거다.
 *
 *   10-2231365  재단법인 한국특허정보원 · (19) 대한민국특허청(KR)      · 2021년 공고
 *   10-3006496  (19) 대한민국 지식재산처(KR)                           · 2026년 공고
 *
 * 기관명이 그 사이에 바뀌었으므로 지금 발행하는 공보는 지식재산처로 찍는다.
 * 왼쪽 위 (19)(12), 오른쪽 위 (45)(11)(24), 아래로 (51)(52)(21)(22) / (73)(72)(74),
 * 그 아래 전체 청구항 수와 심사관, 그리고 (54)와 (57) —— 전부 실제 공보의 순서다.
 */

(function (global) {
  const P = global.CROWD_PALETTE;
  const hatch = global.crowdHatch;
  const seal = global.crowdSeal;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const MYEONGJO = '"Nanum Myeongjo", Batang, 바탕, serif';
  const GOTHIC = '"Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", sans-serif';
  const MONO = 'ui-monospace, monospace';

  /* 연출 순서. 각 구간이 끝나는 시각(ms).
   *
   * 공보는 인쇄물이다. 그래서 전환도 인쇄의 문법을 쓴다 —— 종이가 깔리고, 괘선이 그어지고,
   * 활자가 앉고, 마지막에 도장이 찍힌다. 페이드는 쓰지 않는다. */
  const T = {
    paper: 420,     // 백지가 깔린다
    rules: 1000,    // 괘선과 테두리가 그어진다
    head: 1800,     // 서지사항이 앉는다
    title: 2700,    // (54) 발명의 명칭 — 우승자 이름
    body: 3500,     // (57) 요약
    fig: 4400,      // 대표도 — 우승자 옥상 사시도
    stamp: 5000,    // 인주 도장
  };
  // 카드는 스스로 걷히지 않는다. 우승곡이 끝나도 화면은 그대로 남는다 ——
  // 캡처하고, 돌려 보고, 이야기할 시간이다. 누르면 넘어가고, 다음 회차가 열리면 걷힌다.

  class EndingCard {
    /** @param {HTMLElement} root  전체를 덮는 오버레이. 안에 canvas 하나가 있어야 한다. */
    constructor(root) {
      this.root = root;
      this.canvas = root.querySelector('canvas');
      // 캔버스를 불투명(alpha:false)으로 잡으면 크롬이 글자에 LCD 서브픽셀 안티앨리어싱을
      // 쓴다. 그러면 검은 글자 가장자리에 주황·보라 색테가 생긴다. 컬러 화면에서는 안 보이지만
      // 먹과 종이만 쓰는 도면에서는 그 색테가 그대로 눈에 띈다. alpha:true면 회색조로 떨어진다.
      this.ctx = this.canvas.getContext('2d', { alpha: true });

      this.champ = null;
      this.t0 = 0;
      this.raf = null;
      this.timer = null;
      this.onDone = null;
      this.w = 8;
      this.h = 8;
      this.dpr = 1;

      this._onResize = () => this.resize();
      window.addEventListener('resize', this._onResize);

      // 아무 데나 누르면 넘어간다. 강제로 다 보게 하면 그때부터는 연출이 아니라 방해다.
      this._skip = () => this.finish();
      root.addEventListener('click', this._skip);
      root.addEventListener('keydown', this._skip);
    }

    resize() {
      const r = this.root.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return;
      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.canvas.width = Math.round(r.width * this.dpr);
      this.canvas.height = Math.round(r.height * this.dpr);
      this.w = r.width;
      this.h = r.height;
    }

    show(champ, onDone) {
      if (!champ) return;
      this.champ = champ;
      this.onDone = onDone || null;
      this.root.hidden = false;
      this.root.setAttribute('tabindex', '-1');
      this.resize();
      this.t0 = performance.now();
      if (!this.raf) this.raf = requestAnimationFrame(this.frame.bind(this));

      try { this.root.focus({ preventScroll: true }); } catch (e) { /* 없어도 된다 */ }
    }

    finish() {
      if (!this.champ) return;
      this.champ = null;
      clearTimeout(this.timer);
      this.timer = null;
      if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
      this.root.hidden = true;
      if (this.onDone) { const f = this.onDone; this.onDone = null; f(); }
    }

    destroy() {
      this.finish();
      window.removeEventListener('resize', this._onResize);
      this.root.removeEventListener('click', this._skip);
      this.root.removeEventListener('keydown', this._skip);
    }

    frame(now) {
      if (!this.champ) return;
      this.raf = requestAnimationFrame(this.frame.bind(this));
      this.draw(now - this.t0, now);
    }

    draw(t, now) {
      const c = this.ctx;
      const W = this.w;
      const H = this.h;
      if (W < 8 || H < 8) return;

      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      // 종이. 공보는 흰 바탕이라 게임 화면을 덮는 순간 자체가 전환이 된다.
      c.fillStyle = P.paper;
      c.fillRect(0, 0, W, H);

      // 용지가 세로로 길므로 안쪽에 A4 비율 지면을 잡는다
      const pageH = H * 0.94;
      const pageW = Math.min(W * 0.94, pageH * 0.72);
      const ox = (W - pageW) / 2;
      const oy = (H - pageH) / 2;

      const u = pageW / 100;   // 지면 폭을 100으로 놓은 단위. 어느 화면에서도 같은 비례가 된다.

      if (t > T.paper) this.drawSheet(c, ox, oy, pageW, pageH, u, t);
      if (t > T.rules) this.drawHeader(c, ox, oy, pageW, pageH, u, t);
      if (t > T.head) this.drawBiblio(c, ox, oy, pageW, pageH, u, t);
      if (t > T.title) this.drawTitle(c, ox, oy, pageW, pageH, u, t);
      if (t > T.body) this.drawAbstract(c, ox, oy, pageW, pageH, u, t);
      if (t > T.fig) this.drawRepFigure(c, ox, oy, pageW, pageH, u, now, t);
      if (t > T.stamp) seal(c, ox + pageW * 0.845, oy + pageH * 0.905, u * 7, '登', t - T.stamp);

      if (t > T.stamp + 900) {
        c.textAlign = 'center';
        c.textBaseline = 'bottom';
        c.fillStyle = P.light;
        c.font = `${Math.max(9, u * 2.0)}px ${GOTHIC}`;
        c.fillText('아무 곳이나 누르면 넘어갑니다', W / 2, H - u * 1.5);
      }
    }

    /** 지면과 테두리 */
    drawSheet(c, ox, oy, w, h, u, t) {
      c.fillStyle = '#FFFFFF';
      c.fillRect(ox, oy, w, h);
      c.strokeStyle = P.rule;
      c.lineWidth = 1;
      c.strokeRect(ox + 0.5, oy + 0.5, Math.round(w), Math.round(h));

      // 괘선이 그어지는 동안 폭이 자란다
      const k = clamp((t - T.paper) / (T.rules - T.paper), 0, 1);
      c.strokeStyle = P.ink;
      c.lineWidth = 1.1;
      c.beginPath();
      c.moveTo(ox + u * 4, oy + u * 13.5);
      c.lineTo(ox + u * 4 + (w - u * 8) * k, oy + u * 13.5);
      c.stroke();
    }

    /** 문서번호 머리 — 공보는 매 쪽 오른쪽 위에 등록번호를 단다 */
    drawHeader(c, ox, oy, w, h, u, t) {
      const no = this.champ.regNo;
      c.textAlign = 'right';
      c.textBaseline = 'top';
      c.fillStyle = P.ink;
      c.font = `${Math.max(7, u * 2.1)}px ${GOTHIC}`;
      c.fillText(`등록특허 ${no}`, ox + w - u * 4, oy + u * 2);
      c.fillText(`등록특허 ${no}`, ox + w - u * 4, oy + u * 5.4);

      // 쪽번호
      c.textAlign = 'center';
      c.textBaseline = 'bottom';
      c.fillStyle = P.mid;
      c.font = `${Math.max(7, u * 2.0)}px ${MONO}`;
      c.fillText('- 1 -', ox + w / 2, oy + h - u * 2.5);
    }

    /**
     * 서지사항.
     *
     * 실제 공보의 (19)(12) / (45)(11)(24) 두 단 구조를 그대로 쓴다.
     * 괄호 안 숫자는 INID 코드 —— 이게 이 디자인의 서명이다.
     */
    drawBiblio(c, ox, oy, w, h, u, t) {
      const k = clamp((t - T.head) / (T.title - T.head), 0, 1);
      const ch = this.champ;
      const L = ox + u * 5;
      const R = ox + w * 0.52;
      const lab = Math.max(7, u * 2.15);
      const val = Math.max(7, u * 2.15);

      c.textBaseline = 'top';
      c.textAlign = 'left';

      // (19)(12) — 발행 기관. 기관명이 특허청에서 지식재산처로 바뀌었다.
      c.fillStyle = P.ink;
      c.font = `${lab * 1.15}px ${GOTHIC}`;
      c.fillText('(19) 대한민국 지식재산처(KR)', L, oy + u * 15.5);
      c.fillText('(12) 등록특허공보(B1)', L, oy + u * 19.5);

      if (k < 0.25) return;

      // (45)(11)(24)
      c.font = `${lab}px ${GOTHIC}`;
      const rows = [
        ['(45) 공고일자', ch.pubDate],
        ['(11) 등록번호', ch.regNo],
        ['(24) 등록일자', ch.pubDate],
      ];
      rows.forEach(([a, b], i) => {
        c.fillStyle = P.ink;
        c.fillText(a, R, oy + u * (15.5 + i * 3.6));
        c.fillText(b, R + u * 17, oy + u * (15.5 + i * 3.6));
      });

      if (k < 0.5) return;

      // 왼쪽 단 — 분류와 출원
      const left = [
        ['(51) 국제특허분류(Int. Cl.)', ''],
        ['A63F 13/79 (2014.01)', ''],
        ['G06Q 10/06 (2023.01)', ''],
        ['(21) 출원번호', ch.appNo],
        ['(22) 출원일자', ch.pubDate],
      ];
      left.forEach(([a, b], i) => {
        c.fillStyle = i === 1 || i === 2 ? P.mid : P.ink;
        c.font = `${val}px ${i === 1 || i === 2 ? MONO : GOTHIC}`;
        c.fillText(a, L, oy + u * (26 + i * 3.4));
        if (b) c.fillText(b, L + u * 15, oy + u * (26 + i * 3.4));
      });

      // 오른쪽 단 — 특허권자는 언제나 한국특허정보원이다
      const right = [
        ['(73) 특허권자', 1],
        ['재단법인 한국특허정보원', 0],
        ['대전광역시 서구 둔산서로 137, 5층', 0],
        ['(72) 발명자', 1],
        [ch.name, 0],
        [ch.dept, 0],
      ];
      right.forEach(([a, isLab], i) => {
        c.fillStyle = isLab ? P.ink : P.mid;
        c.font = `${val}px ${isLab ? GOTHIC : MYEONGJO}`;
        c.fillText(a, R + (isLab ? 0 : u * 2), oy + u * (26 + i * 3.4));
      });

      if (k < 0.85) return;

      // 청구항 수와 심사관 — 실제 공보에서 이 줄이 표제부의 끝을 맺는다
      c.strokeStyle = P.rule;
      c.lineWidth = 0.8;
      c.beginPath();
      c.moveTo(ox + u * 4, oy + u * 48);
      c.lineTo(ox + w - u * 4, oy + u * 48);
      c.stroke();

      c.fillStyle = P.ink;
      c.font = `${val}px ${GOTHIC}`;
      c.textAlign = 'left';
      c.fillText(`전체 청구항 수 : 총 ${ch.survived} 항`, L, oy + u * 49.5);
      c.textAlign = 'right';
      c.fillText(`심사관 : ${ch.examiner}`, ox + w - u * 5, oy + u * 49.5);
    }

    /** (54) 발명의 명칭 — 우승자의 이름이 여기 앉는다 */
    drawTitle(c, ox, oy, w, h, u, t) {
      const k = clamp((t - T.title) / (T.body - T.title), 0, 1);
      const ch = this.champ;
      const L = ox + u * 5;

      c.textAlign = 'left';
      c.textBaseline = 'top';
      c.fillStyle = P.ink;
      c.font = `${Math.max(7, u * 2.15)}px ${GOTHIC}`;
      c.fillText('(54) 발명의 명칭', L, oy + u * 54);

      // 이름은 한 글자씩 앉는다. 활자를 심는 속도다.
      const line = `${ch.dept} ${ch.name}의 12:55 우승 방법`;
      const shown = line.slice(0, Math.ceil(line.length * clamp(k * 1.4, 0, 1)));
      c.font = `${Math.max(11, u * 3.4)}px ${MYEONGJO}`;
      c.fillText(shown, L + u * 1, oy + u * 58);
    }

    /**
     * 대표도.
     *
     * 실제 공보는 요약 끝에 대표 도면 하나를 싣는다. 그 자리에 옥상 사시도를 넣는다.
     * 무대가 쓰는 그림을 그대로 불러 쓰므로 게임에서 보던 장면과 어긋나지 않는다.
     */
    drawRepFigure(c, ox, oy, w, h, u, now, t) {
      const k = clamp((t - T.fig) / (T.stamp - T.fig), 0, 1);
      const bw = w - u * 26;
      const bh = h * 0.20;
      const bx = ox + u * 13;
      const by = oy + h * 0.615;

      c.save();
      c.beginPath();
      // 도면이 왼쪽에서 오른쪽으로 드러난다 — 인쇄기가 밀고 나오는 방향이다
      c.rect(bx, by, bw * k, bh);
      c.clip();
      c.translate(bx, by);
      global.paintCrowdScene(c, 'rooftop', bw, bh, now, null);
      // 난간 안쪽에 선 우승자
      const g = global.ROOF_GEOMETRY;
      global.crowdDrawPerson.call(null, c, bw / 2, bh * g.stand, bh * 0.15,
        global.CROWD_DIV_TINT[0], false);
      c.restore();

      c.strokeStyle = P.ink;
      c.lineWidth = 0.9;
      c.strokeRect(bx + 0.5, by + 0.5, Math.round(bw), Math.round(bh));

      if (k > 0.9) {
        c.textAlign = 'center';
        c.textBaseline = 'top';
        c.fillStyle = P.ink;
        c.font = `${Math.max(7, u * 2.0)}px ${GOTHIC}`;
        c.fillText('【도 2】 우승자 옥상 사시도', ox + w / 2, by + bh + u * 1.6);
      }
    }

    /** (57) 요 약 — 자간을 벌린 두 글자. 공보의 버릇이다. */
    drawAbstract(c, ox, oy, w, h, u, t) {
      const k = clamp((t - T.body) / (T.stamp - T.body), 0, 1);
      const ch = this.champ;
      const L = ox + u * 5;
      const size = Math.max(7, u * 2.15);

      c.textAlign = 'left';
      c.textBaseline = 'top';
      c.fillStyle = P.ink;
      c.font = `${size}px ${GOTHIC}`;
      c.fillText('(57) 요  약', L, oy + u * 64);

      const text =
        `본 우승은 ${ch.totalPlayers}명이 참가한 제${ch.round}회 정규전에서 ${ch.survived}개 문항을 연속 통과하고 ` +
        `최후의 1인으로 확정된 것을 특징으로 한다.` +
        (ch.isNew ? ' 특히 2년차 미만 참가자가 우승한 사례로서 그 산업상 이용가능성이 크다.' : '');

      // 줄바꿈을 직접 한다. 공보 본문은 양끝을 맞춘 좁은 단이다.
      c.font = `${size}px ${MYEONGJO}`;
      const maxW = w - u * 12;
      const lines = [];
      let cur = '';
      for (const chr of text) {
        if (c.measureText(cur + chr).width > maxW) { lines.push(cur); cur = ''; }
        cur += chr;
      }
      if (cur) lines.push(cur);

      const total = lines.join('').length;
      const upto = Math.ceil(total * k);
      let seen = 0;
      c.fillStyle = P.ink;
      lines.forEach((ln, i) => {
        if (seen >= upto) return;
        const take = Math.min(ln.length, upto - seen);
        c.fillText(ln.slice(0, take), L + u * 1, oy + u * (68 + i * 3.3));
        seen += ln.length;
      });

    }
  }

  global.EndingCard = EndingCard;
})(window);
