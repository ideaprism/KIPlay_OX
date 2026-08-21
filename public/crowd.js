'use strict';

/**
 * 12:55 — 군중 무대 렌더러
 *
 * 구도
 *   게임장 하나가 도면 한 장이다. O와 X 두 구역 상자가 위쪽 절반을 차지하고,
 *   아직 답하지 않은 사람들은 아래 대기 구역에 모여 있다. 문제가 뜨면 각자
 *   구역 상자 안으로 달려 들어간다. 앞사람이 어디로 뛰는지가 그대로 보인다.
 *   인원이 많으면 뒷줄은 화면 아래로 넘쳐 흐른다. 400명을 다 보여줄 필요가 없다.
 *
 * 정답 공개
 *   맞은 구역에는 등록 도장이 찍히고 틀린 구역은 사선으로 지워진다. 살아남은
 *   사람들은 대기 구역으로 내려와 같은 자리에서 다음 문항을 기다린다.
 *   층 상승 구조는 걷어냈다 —— 게임장은 하나다.
 *
 * 이 파일은 그리기만 한다. 탈락 판정은 서버가 이미 끝냈고 여기서는 확정된 사실을
 * 렌더링할 뿐이다. 프레임이 밀려도 게임 결과는 흔들리지 않는다.
 */

(function (global) {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  // ── 구도 비율 (화면 기준)
  //
  // 게임장 하나가 도면 한 장이다. O와 X 두 구역 상자가 지면의 위쪽 절반을 차지하고,
  // 아직 답하지 않은 사람들은 아래 대기 구역에 모여 있다. 참여자 화면에서는 이 두 상자
  // 위에 투명 버튼이 겹쳐서, 구역 자체가 곧 버튼이 된다.
  const BOX = {
    top: 0.115,   // 구역 상자 윗변
    bot: 0.60,    // 아랫변
    oL: 0.035, oR: 0.485,   // O 구역 좌우
    xL: 0.515, xR: 0.965,   // X 구역 좌우
  };
  const HOME_Y = 0.76;      // 대기 구역 첫 줄
  const HOME_W = 0.46;      // 대기 구역 폭

  // ── 옥상 구도 (우승 장면 전용)
  //
  // 카메라는 챔피언의 등 뒤, 옥상 바닥 높이에 있다. 그래서 도시는 눈높이 아래에 깔리고
  // 챔피언의 상반신만 그 위로 솟는다. 아래 네 값이 그 구도를 잡는다.
  const ROOF_SKY = 0.26;    // 지평선 — 이 위는 하늘, 아래는 내려다보는 도시
  const ROOF_EDGE = 0.70;   // 난간 윗면 — 여기서 도시가 끝나고 옥상이 시작된다
  const ROOF_DECK = 0.78;   // 발을 딛는 바닥
  const ROOF_STAND = 0.87;  // 챔피언이 서는 자리
  const ROOF_R = 0.16;      // 챔피언 크기. 머리와 어깨가 난간선 위로 나오는 값이다.

  /** 프레임마다 같은 스카이라인이 나와야 한다. 시드 고정 난수. */
  function seeded(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let x = Math.imul(a ^ (a >>> 15), 1 | a);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * 인원이 줄수록 사람이 커진다. 화면 높이에 대한 비율로 잡아 어떤 크기에서도 같게 보인다.
   *
   * 하한이 중요하다. 사람을 무한정 줄여 400명을 다 담으려 하면 격자처럼 보이고 군중이 아니게 된다.
   * 앞줄 100명 남짓만 보이고 나머지는 화면 아래로 넘치는 편이 훨씬 군중답다.
   */
  function radiusFor(alive, H, minRatio = 0.020) {
    const k = Math.pow(120 / Math.max(1, alive), 0.35);
    return H * clamp(0.020 * k, minRatio, 0.085);
  }

  function tierFor(alive) {
    if (alive > 300) return 0;
    if (alive > 100) return 1;
    if (alive > 30) return 2;
    if (alive > 10) return 3;
    if (alive > 2) return 4;
    return 5;
  }

  /* ── 공보 팔레트 ────────────────────────────────────────────
   *
   * 등록특허공보는 먹과 종이다. 색은 정보가 아니라 방해다.
   *
   * 단 하나의 강조색만 쓴다 —— 인주 빨강. 그것도 도장을 찍을 때만.
   * 정답이 공개되는 순간에만 화면에 빨강이 등장하므로, 그 색이 곧 판정이 된다.
   * 소속색은 윤곽선 안쪽을 아주 옅게 채우는 데만 쓴다. 주인공은 어디까지나 선이다.
   */
  const P = {
    paper:  '#FAF7F0',   // 공보 용지
    paper2: '#F2EEE4',   // 접힌 면, 표 바탕
    ink:    '#141414',
    mid:    '#5A5A5A',
    light:  '#9A9A9A',
    rule:   '#C8C2B6',   // 괘선
    seal:   '#B03A2E',   // 인주. 이 파일에서 유일한 색.
  };

  /** 소속색 — 채도를 눌러 선 아래에 깔린다 */
  const DIV_TINT = ['#6B7B8C', '#6F8489', '#7E8F7A', '#8C8468', '#8C6F6F', '#7A6B8C'];

  const px = (v) => Math.round(v) + 0.5;   // 선을 픽셀 격자에 앉혀 흐려지지 않게 한다

  /**
   * 사선 해칭. 도면에서 면을 채우는 유일한 방법이다.
   * 명암을 쓰지 않고 선 간격만으로 농도를 만든다 —— 인쇄를 전제한 그림의 문법이다.
   */
  function hatch(c, x0, y0, w, h, gap, alpha, dir) {
    if (w <= 0 || h <= 0) return;
    c.save();
    c.beginPath();
    c.rect(x0, y0, w, h);
    c.clip();
    c.strokeStyle = `rgba(20,20,20,${alpha})`;
    c.lineWidth = 0.6;
    c.beginPath();
    if (dir === -1) {
      for (let i = -h; i < w + h; i += gap) {
        c.moveTo(x0 + i, y0);
        c.lineTo(x0 + i + h, y0 + h);
      }
    } else {
      for (let i = -h; i < w + h; i += gap) {
        c.moveTo(x0 + i, y0 + h);
        c.lineTo(x0 + i + h, y0);
      }
    }
    c.stroke();
    c.restore();
  }

  /**
   * 인출선과 부호. 도면의 문법 그 자체다.
   * 가리키는 점에 작은 원, 거기서 뻗은 선, 끝에 숫자.
   */
  function callout(c, num, tx, ty, lx, ly, size) {
    c.strokeStyle = P.ink;
    c.lineWidth = 0.8;
    c.beginPath();
    c.moveTo(px(tx), px(ty));
    c.lineTo(px(lx), px(ly));
    c.stroke();
    c.fillStyle = P.ink;
    c.beginPath();
    c.arc(tx, ty, Math.max(1.2, size * 0.16), 0, 6.283);
    c.fill();
    c.font = `500 ${size}px ui-monospace, monospace`;
    c.textAlign = lx > tx ? 'left' : 'right';
    c.textBaseline = 'middle';
    c.fillText(num, lx + (lx > tx ? size * 0.4 : -size * 0.4), ly);
  }

  /**
   * 도장. 등록이면 원, 거절이면 사선.
   *
   * 이 게임에서 색이 등장하는 유일한 순간이다. 정답이 공개될 때만 인주가 찍힌다.
   */
  function seal(c, cx, cy, r, text, t) {
    // 찍히는 순간 살짝 커졌다 제자리로 —— 도장은 눌렸다 떨어진다
    const pop = t === undefined ? 1 : 1 + 0.12 * Math.exp(-t / 160);
    const rr = r * pop;
    c.save();
    c.translate(cx, cy);
    c.rotate(-0.12);
    c.strokeStyle = P.seal;
    c.lineWidth = Math.max(1.5, r * 0.11);
    c.beginPath();
    c.arc(0, 0, rr, 0, 6.283);
    c.stroke();
    c.beginPath();
    c.arc(0, 0, rr * 0.82, 0, 6.283);
    c.lineWidth = Math.max(1, r * 0.05);
    c.stroke();
    c.fillStyle = P.seal;
    c.font = `700 ${Math.round(rr * 0.52)}px "Nanum Myeongjo", Batang, 바탕, serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, 0, rr * 0.04);
    c.restore();
  }

  // ── 장면은 둘뿐이다. 게임장(도 1)과, 우승 연출 전용의 옥상(도 2).
  const SCENES = {
    ground:  { no: 1, label: '게임장', caption: 'O·X 게임장',        draw: drawGround },
    rooftop: { no: 2, label: '옥상',   caption: '우승자 옥상 사시도', draw: drawRooftop },
  };

  /**
   * 게임장 — 【도 1】.
   *
   * 층 상승 구조는 걷어냈다. 운동장이든 강당이든, 살아남은 사람들이 같은 자리에서
   * 계속 겨룬다. 여기서는 구역 상자 아래의 바닥과 소실선만 그린다. 상자와 글자,
   * 도면부호는 drawZones와 drawSheetFurniture가 그린다 —— 상자 위에 사람이 서야
   * 하므로 그리는 순서가 나뉘어 있을 뿐이다.
   */
  function drawGround(c, w, h) {
    const fy = Math.round(h * (BOX.bot + 0.045));
    c.strokeStyle = P.ink;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(px(0), px(fy));
    c.lineTo(px(w), px(fy));
    c.stroke();

    // 소실점으로 모이는 바닥선. 이게 있어야 아래 무리가 평면 위에 서 있는 것으로 읽힌다.
    c.strokeStyle = 'rgba(20,20,20,.14)';
    c.lineWidth = 0.6;
    c.beginPath();
    for (let i = 0; i <= 10; i += 1) {
      const bx = (w * i) / 10;
      c.moveTo(px(lerp(w / 2, bx, 0.30)), px(fy));
      c.lineTo(px(bx), px(h));
    }
    c.stroke();
  }

  /**
   * 사진 위에 얹는 생기.
   *
   * 정지 사진은 4주만 지나도 닳는다. 창 몇 개가 아주 느리게 켜지고 꺼지는 것만으로
   * 도시가 살아 있게 보인다. 사진에 이미 디테일이 있으니 여기서는 세게 넣지 않는다.
   */
  function drawRoofLife(c, w, h, t) {
    const top = h * ROOF_SKY;
    const span = h * (ROOF_EDGE - ROOF_SKY);
    let seed = 20250819;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    c.fillStyle = P.ink;
    for (let i = 0; i < 26; i += 1) {
      const x = rnd() * w;
      // 아래쪽(가까운 건물)에 더 많이 몰리게 한다
      const y = top + span * Math.pow(rnd(), 0.6);
      const ph = rnd() * 6.283;
      if ((Math.sin(t / 1100 + ph) + 1) / 2 < 0.55) continue;
      c.fillRect(Math.round(x), Math.round(y), Math.max(1, w * 0.0022), Math.max(1, h * 0.006));
    }

    // 항공장애등. 도면에서 유일하게 인주가 찍히는 자리다.
    if (Math.sin(t / 620) > 0) {
      c.fillStyle = P.seal;
      c.beginPath();
      c.arc(w * 0.085, h * (ROOF_EDGE - 0.16), Math.max(1.5, h * 0.007), 0, 6.283);
      c.fill();
    }
  }

  /**
   * 옥상 — 우승 장면.
   *
   * 이 그림에서 유일하게 중요한 건 시점이다. 도시를 눈높이에 두면 길에 서 있는 그림이 되고,
   * 눈높이 아래로 내려야 비로소 내려다보는 그림이 된다. 그래서 지평선을 화면 위쪽(ROOF_SKY)에
   * 붙이고, 건물은 전부 그 아래에 깔되 앞으로 올수록 크고 어둡게 그린다. 난간(ROOF_EDGE)이
   * 도시와 옥상을 가르고, 그 아래가 챔피언이 딛고 선 바닥이다.
   */
  function drawRooftop(c, w, h, t, stage) {
    // 사진 배경이 준비돼 있으면 그것이 하늘·도시·난간·바닥을 전부 대신한다.
    // 없으면 아래의 절차적 옥상이 그대로 그려진다. 이미지는 선택이지 전제가 아니다.
    const bd = stage && stage.backdrop;
    if (bd && bd.ready() && bd.build(w, h, ROOF_EDGE)) {
      bd.draw(c, w, h);
      if (bd.life) drawRoofLife(c, w, h, t);
      return;
    }

    const horizon = h * ROOF_SKY;
    const edge = h * ROOF_EDGE;
    const deck = h * ROOF_DECK;
    const sunX = w * 0.68;

    // ── 해. 도면에서 광원은 동심원 몇 개로 표시한다.
    c.strokeStyle = P.light;
    c.lineWidth = 0.7;
    for (let i = 1; i <= 4; i += 1) {
      c.beginPath();
      c.arc(sunX, horizon - h * 0.02, h * 0.045 + i * h * 0.028, Math.PI, 0);
      c.stroke();
    }
    c.strokeStyle = P.ink;
    c.lineWidth = 1;
    c.beginPath();
    c.arc(sunX, horizon - h * 0.02, h * 0.045, 0, 6.283);
    c.stroke();

    /**
     * 건물 한 띠. 선화라 채우지 않고 윤곽만 그린다.
     * 거리는 명암이 아니라 선 굵기와 해칭 밀도로 만든다 —— 흑백 인쇄의 원근법이다.
     */
    const band = (seed, base, minH, maxH, minW, maxW, lw, hatchA, win) => {
      const rnd = seeded(seed);
      let x = -maxW * rnd();
      c.lineWidth = lw;
      c.strokeStyle = P.ink;
      while (x < w) {
        const bw = Math.max(3, minW + (maxW - minW) * rnd());
        const bh = Math.max(3, minH + (maxH - minH) * rnd());
        const top = base - bh;
        c.fillStyle = P.paper;
        c.fillRect(px(x), px(top), Math.round(bw), Math.round(base - top));
        c.strokeRect(px(x), px(top), Math.round(bw), Math.round(base - top));

        // 옥탑의 물탱크나 계단실
        if (rnd() > 0.62 && bw > 8) {
          const cw = bw * 0.3;
          const ch = bh * 0.16;
          c.fillStyle = P.paper;
          c.fillRect(px(x + bw * 0.25), px(top - ch), Math.round(cw), Math.round(ch));
          c.strokeRect(px(x + bw * 0.25), px(top - ch), Math.round(cw), Math.round(ch));
        }
        if (hatchA > 0) hatch(c, x + 1, top + 1, bw - 2, bh - 2, 6, hatchA, 1);

        // 창. 도면에서는 작은 사각형 격자다.
        if (win && bw > 14) {
          c.lineWidth = 0.5;
          for (let i = 4; i < bw - 5; i += 7) {
            for (let j = 5; j < bh - 4; j += 9) {
              if (rnd() > 0.5) continue;
              c.strokeRect(px(x + i), px(top + j), 3, 4);
            }
          }
          c.lineWidth = lw;
        }
        x += bw + 2 + rnd() * (maxW * 0.28);
      }
    };

    // ── 먼 스카이라인 → 중간 블록 → 발밑의 도시. 앞으로 올수록 굵고 진하다.
    band(11, horizon + h * 0.10, h * 0.03, h * 0.09, w * 0.010, w * 0.030, 0.5, 0, false);
    band(29, horizon + h * 0.24, h * 0.05, h * 0.14, w * 0.016, w * 0.045, 0.75, 0.10, false);
    band(47, edge, h * 0.08, h * 0.20, w * 0.028, w * 0.075, 1.1, 0.18, true);

    // ── 난간. 이 선이 도시와 옥상을 가른다.
    c.fillStyle = P.paper;
    c.fillRect(0, Math.round(edge), w, Math.round(h - edge));
    c.strokeStyle = P.ink;
    c.lineWidth = 1.8;
    c.beginPath();
    c.moveTo(px(0), px(edge));
    c.lineTo(px(w), px(edge));
    c.stroke();
    c.lineWidth = 0.9;
    c.beginPath();
    c.moveTo(px(0), px(deck));
    c.lineTo(px(w), px(deck));
    c.stroke();
    // 난간 안쪽 면 —— 해칭으로 '세워진 면'임을 표시한다
    hatch(c, 0, edge + 1, w, deck - edge - 1, 7, 0.30, 1);

    // 옥상 바닥. 원근선이 소실점으로 모인다.
    c.strokeStyle = 'rgba(20,20,20,.16)';
    c.lineWidth = 0.6;
    c.beginPath();
    for (let i = 0; i <= 10; i += 1) {
      const bx = (w * i) / 10;
      c.moveTo(px(lerp(w / 2, bx, 0.35)), px(deck));
      c.lineTo(px(bx), px(h));
    }
    c.stroke();

    // 환기구와 안테나. 여기가 '건물 옥상'이지 그냥 바닥이 아니라는 표시.
    c.strokeStyle = P.ink;
    c.lineWidth = 1;
    const vw = Math.max(6, w * 0.05);
    const vh = Math.max(6, (h - edge) * 0.34);
    c.fillStyle = P.paper;
    c.fillRect(px(w * 0.06), px(edge - vh), Math.round(vw), Math.round(vh));
    c.strokeRect(px(w * 0.06), px(edge - vh), Math.round(vw), Math.round(vh));
    hatch(c, w * 0.06 + 1, edge - vh + 1, vw - 2, vh - 2, 5, 0.22, -1);
    c.fillRect(px(w * 0.885), px(edge - vh * 0.7), Math.round(vw * 0.7), Math.round(vh * 0.7));
    c.strokeRect(px(w * 0.885), px(edge - vh * 0.7), Math.round(vw * 0.7), Math.round(vh * 0.7));
    c.beginPath();
    c.moveTo(px(w * 0.085), px(edge - vh));
    c.lineTo(px(w * 0.085), px(edge - vh * 2.1));
    c.stroke();
    // 항공장애등. 도면에서 유일하게 인주가 찍히는 자리다.
    if (Math.sin(t / 620) > 0) {
      c.fillStyle = P.seal;
      c.beginPath();
      c.arc(w * 0.085, edge - vh * 2.1, Math.max(1.5, h * 0.009), 0, 6.283);
      c.fill();
    }
  }

  // ═══════════════════════════════════════════════════════════════

  class CrowdStage {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      // 캔버스를 불투명(alpha:false)으로 잡으면 크롬이 글자에 LCD 서브픽셀 안티앨리어싱을
      // 쓴다. 그러면 검은 글자 가장자리에 주황·보라 색테가 생긴다. 컬러 화면에서는 안 보이지만
      // 먹과 종이만 쓰는 도면에서는 그 색테가 그대로 눈에 띈다. alpha:true면 회색조로 떨어진다.
      this.ctx = canvas.getContext('2d', { alpha: true });
      this.compact = !!opts.compact;
      this.showZones = opts.zones !== false;

      this.people = [];
      this.divisions = [];
      this.n = 0;

      this.phase = 'idle';
      this.scene = 'ground';
      this.prevScene = null;
      this.sceneT = 1;
      this.backdrop = null;        // 옥상 배경 사진. 없으면 절차적으로 그린다.
      this.roofStand = ROOF_STAND; // 사진이 난간선을 다르게 선언하면 여기가 따라 움직인다.
      this.alive = 0;
      this.named = null;
      this.myIndex = null;

      this.revealSide = null;
      this.sealAt = null;          // 도장이 찍힌 시각. 눌렸다 떨어지는 맛을 위해 잰다.
      this.championIndex = null;   // 우승 장면 — 이 사람만 옥상에 크게 남는다
      this.t0 = performance.now();
      this.raf = null;
      this.dpr = 1;
      this.w = 1; this.h = 1;

      this._onResize = () => this.resize();
      window.addEventListener('resize', this._onResize);
      if ('ResizeObserver' in window) {
        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(canvas);
      }
      this.resize();
    }

    destroy() {
      this.stop();
      window.removeEventListener('resize', this._onResize);
      if (this._ro) { this._ro.disconnect(); this._ro = null; }
    }

    /**
     * 선화는 저해상도 버퍼를 쓰지 않는다.
     *
     * 픽셀아트였을 때는 일부러 해상도를 낮추고 정수배로 확대했지만, 도면은 정반대다.
     * 가는 선 한 줄이 정확히 1px로 앉아야 인쇄물처럼 보인다. 그래서 화면 해상도 그대로
     * 그리고, 좌표는 px() 로 반 픽셀 격자에 맞춘다.
     */
    resize() {
      const r = this.canvas.getBoundingClientRect();
      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
      this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
      this.w = r.width;
      this.h = r.height;

      // 비율이 바뀌면 다른 원본이 필요할 수 있다. 세로 화면에 가로 사진을 쓰면
      // 도시가 다 잘려나간다.
      if (this.backdrop) this.pickBackdropSource();
      this.layout();
    }

    pickBackdropSource() {
      const bd = this.backdrop;
      bd.load(this.w / Math.max(1, this.h)).then((ok) => {
        if (!ok || this.backdrop !== bd) return;
        const stand = bd.stand();
        if (typeof stand === 'number') this.roofStand = stand;
        this.layout();
      });
    }

    // ── 데이터 ────────────────────────────────────────────────

    setCrowd(crowd) {
      if (!crowd || !crowd.n) return;
      this.divisions = crowd.divisions || [];
      this.n = crowd.n;
      this.people = new Array(crowd.n);
      for (let i = 0; i < crowd.n; i += 1) {
        this.people[i] = {
          i,
          div: Number(crowd.div[i]) || 0,
          flag: crowd.flags[i] || '.',
          alive: true,
          choice: null,
          decided: false,
          x: 0, y: 0, tx: 0, ty: 0,
          fade: 1,
          seed: ((i * 2654435761) % 997) / 997,
        };
      }
      this.layout(true);
    }

    setState(s) {
      this.phase = s.phase;
      this.alive = s.alive ?? this.alive;
      this.named = s.named || null;

      // ?scene= 픽스처로 장면을 고정한 상태면 서버 값으로 덮어쓰지 않는다.
      // 우승 장면이 떠 있는 동안에는 서버가 보내는 게임장 배경으로 되돌리지 않는다.
      if (!this.sceneLocked && s.scene && this.championIndex === null) this.toScene(s.scene);
      if (s.aliveMask) this.applyAlive(s.aliveMask);

      // 새 문항이 시작되면 살아남은 사람들이 다시 아래 중앙으로 모인다.
      // 서든데스도 마찬가지다 —— 직전 정답 공개의 도장·사선이 남아 있으면 안 된다.
      if (s.phase === 'question' || s.phase === 'sudden') {
        this.revealSide = null;
        for (const p of this.people) { p.choice = null; p.decided = false; }
      }
      this.layout();
    }

    setMyIndex(i) { this.myIndex = i; }

    /**
     * 옥상 배경 사진을 건다. 없으면 절차적 옥상이 그대로 쓰인다.
     * 원본이 선언한 난간선(edge)에 맞춰 우승자가 설 자리도 따라 움직인다.
     */
    setBackdrop(cfg) {
      if (!global.RoofBackdrop || !cfg || cfg.enabled === false) return;
      this.backdrop = new global.RoofBackdrop(cfg);
      this.pickBackdropSource();
    }

    /** 장면 전환. 넘어오는 동안만 이전 장면이 남고, 끝나면 새 장면만 그린다. */
    toScene(name) {
      if (!name || !SCENES[name] || name === this.scene) return;
      this.prevScene = this.scene;
      this.scene = name;
      this.sceneT = 0;
    }

    /**
     * 우승 장면. 챔피언 혼자 옥상에 서서 도시를 내려다본다.
     * 몇 층에서 이겼든 마지막은 옥상이다.
     *
     * 결과 단계 내내 매 틱 불릴 수 있으므로 같은 값이면 아무것도 하지 않는다.
     * 그러지 않으면 전환이 계속 처음부터 다시 시작돼 장면이 영영 도착하지 못한다.
     */
    setChampion(ci) {
      const next = typeof ci === 'number' ? ci : null;
      if (next === this.championIndex) return;
      this.championIndex = next;
      if (next !== null && !this.sceneLocked) this.toScene('rooftop');
      this.layout();
    }

    clearChampion() {
      if (this.championIndex === null) return;
      this.championIndex = null;
      // 다음 회차는 옥상에서 시작하지 않는다. 게임장으로 돌려놓는다.
      if (!this.sceneLocked && this.scene === 'rooftop') this.toScene('ground');
      this.layout();
    }

    applyAlive(mask) {
      for (let i = 0; i < this.people.length && i < mask.length; i += 1) {
        this.people[i].alive = mask[i] === '1';
      }
    }

    applyChoices(mask) {
      if (!mask) return;
      for (let i = 0; i < this.people.length && i < mask.length; i += 1) {
        const ch = mask[i];
        const p = this.people[i];
        p.choice = ch === 'O' || ch === 'X' ? ch : null;
        p.decided = !!p.choice;
      }
      this.layout();
    }

    applyDecided(mask) {
      if (!mask) return;
      for (let i = 0; i < this.people.length && i < mask.length; i += 1) {
        this.people[i].decided = mask[i] === '1';
      }
    }

    applyReveal(reveal) {
      if (!reveal) return;
      this.revealSide = reveal.answer;
      if (reveal.choices) {
        for (let i = 0; i < this.people.length && i < reveal.choices.length; i += 1) {
          const ch = reveal.choices[i];
          if (ch === 'O' || ch === 'X') { this.people[i].choice = ch; this.people[i].decided = true; }
        }
      }
      this.layout();
    }

    // ── 배치 ──────────────────────────────────────────────────
    //
    // 화면 좌표로 직접 잡는다. 아래 중앙이 집이고, 위쪽 두 발판이 목적지다.
    // 뒷줄은 화면 밖 아래로 넘쳐도 상관없다.

    layout(snap = false) {
      const W = this.w;
      const H = this.h;
      if (W < 8 || H < 8 || !this.people.length) return;

      // 폰은 화면이 작으니 사람을 더 크게 잡고 그만큼 더 많이 화면 밖으로 넘긴다
      const r = radiusFor(this.alive || this.n, H, this.compact ? 0.032 : 0.020);
      const gap = r * 2.7;

      // 우승 장면 — 챔피언만 옥상 바닥에 서고 나머지는 아래로 물러난다.
      // 발은 난간 안쪽(ROOF_STAND)에 두되 상반신은 난간선 위로 올라가야 한다.
      // 그래야 도시를 등지고 내려다보는 그림이 된다.
      if (this.championIndex !== null) {
        for (const p of this.people) {
          if (p.i === this.championIndex) {
            p.tx = W / 2;
            p.ty = this.scene === 'rooftop' ? H * this.roofStand : H * 0.72;
          } else {
            p.ty = H * 1.4;
            p.alive = false;
          }
        }
        this.r = r;
        return;
      }

      const zones = { O: [], X: [], home: [] };
      const gone = [];
      for (const p of this.people) {
        if (!p.alive) { gone.push(p); continue; }
        // 정답 공개 뒤에는 살아남은 사람이 대기 구역으로 내려온다
        if (this.revealSide) zones.home.push(p);
        else if (p.choice === 'O') zones.O.push(p);
        else if (p.choice === 'X') zones.X.push(p);
        else zones.home.push(p);
      }

      const place = (list, cx, topY, width, tight = 1) => {
        const g = gap * tight;
        const cols = Math.max(1, Math.floor((W * width) / g));
        list.forEach((p, idx) => {
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          const rowCount = Math.min(cols, list.length - row * cols);
          const rowW = (rowCount - 1) * g;
          // 줄마다 살짝 어긋나게 두면 격자처럼 보이지 않는다
          const jitter = (p.seed - 0.5) * g * 0.35;
          p.tx = cx - rowW / 2 + col * g + jitter;
          p.ty = topY + row * g * 0.72 + (p.seed - 0.5) * g * 0.18;
        });
      };

      /** 구역 상자 안에 줄지어 세운다. 첫 줄 발끝이 상자 윗변에서 머리 하나만큼 내려온다. */
      const placeBox = (list, L, R, topY) => {
        const g = gap * 0.8;
        const cols = Math.max(1, Math.floor((R - L - g) / g));
        list.forEach((p, idx) => {
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          const rowCount = Math.min(cols, list.length - row * cols);
          const rowW = (rowCount - 1) * g;
          const jitter = (p.seed - 0.5) * g * 0.35;
          p.tx = (L + R) / 2 - rowW / 2 + col * g + jitter;
          p.ty = topY + gap * 1.35 + row * g * 0.8 + (p.seed - 0.5) * g * 0.18;
        });
      };
      place(zones.home, W / 2, H * HOME_Y, HOME_W);
      placeBox(zones.O, W * BOX.oL, W * BOX.oR, H * BOX.top);
      placeBox(zones.X, W * BOX.xL, W * BOX.xR, H * BOX.top);

      // 남겨진 사람들은 아래로 흘러 사라진다
      for (const p of gone) { p.ty = Math.max(p.ty, H * 0.95) + H * 0.5; }

      if (snap) for (const p of this.people) { p.x = p.tx; p.y = p.ty; }
      this.r = r;
    }

    // ── 루프 ──────────────────────────────────────────────────

    start() { if (!this.raf) this.raf = requestAnimationFrame(this.frame.bind(this)); }
    stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = null; }

    frame(now) {
      this.raf = requestAnimationFrame(this.frame.bind(this));
      this.update();
      this.draw(now);
    }

    update() {
      if (this.sceneT < 1) {
        this.sceneT = Math.min(1, this.sceneT + 0.02);
        if (this.sceneT >= 1) this.prevScene = null;   // 다 넘어왔으면 이전 장면은 버린다
      }

      for (const p of this.people) {
        // 달려가는 속도. 멀수록 빨리 움직여 모두 비슷한 시간에 도착한다.
        const k = p.alive ? 0.11 : 0.06;
        p.x = lerp(p.x, p.tx, k);
        p.y = lerp(p.y, p.ty, k);
        p.fade = lerp(p.fade, p.alive ? 1 : 0, p.alive ? 0.12 : 0.05);
      }
    }

    draw(now) {
      const t = now - this.t0;
      const W = this.w;
      const H = this.h;
      if (W < 8 || H < 8) return;

      const c = this.ctx;
      c.save();
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      const sc = SCENES[this.scene] || SCENES.lobby;
      const from = this.sceneT < 1 ? SCENES[this.prevScene] : null;

      // 배경 — 넘어오는 동안에만 이전 장면을 깔고 그 위로 새 장면을 띄운다.
      // 바닥에 깔아야 하는 건 어디까지나 '지금' 장면이다.
      if (from) {
        this.paintScene(c, from, W, H, t);
        c.globalAlpha = this.sceneT;
        this.paintScene(c, sc, W, H, t);
        c.globalAlpha = 1;
      } else {
        this.paintScene(c, sc, W, H, t);
      }

      // 우승 장면에는 O·X 발판이 없다. 게임은 이미 끝났다.
      const champScene = this.championIndex !== null;
      if (this.showZones && !champScene) this.drawZones(c, W, H, sc);
      this.drawPeople(c, t);
      if (this.showZones) this.drawSheetFurniture(c, W, H, sc, champScene);

      c.restore();
    }

    /** 도면 한 장. 용지를 깔고 테두리를 두른 뒤 그림을 그린다. */
    paintScene(c, sc, W, H, t) {
      c.fillStyle = P.paper;
      c.fillRect(0, 0, W, H);

      // 도면 테두리 두 겹. 바깥은 옅고 안쪽이 실선이다.
      const m = Math.max(5, Math.round(Math.min(W, H) * 0.022));
      c.strokeStyle = P.rule;
      c.lineWidth = 1;
      c.strokeRect(px(m * 0.55), px(m * 0.55), Math.round(W - m * 1.1), Math.round(H - m * 1.1));
      c.strokeStyle = P.ink;
      c.lineWidth = 0.9;
      c.strokeRect(px(m), px(m), Math.round(W - m * 2), Math.round(H - m * 2));

      sc.draw(c, W, H, t, this);
    }

    /**
     * O / X 구역 — 게임장의 두 상자.
     *
     * 참여자 화면에서는 이 상자 위에 투명 버튼이 겹친다. 구역이 곧 버튼이다.
     * 정답이 공개되면 색이 아니라 판정이 찍힌다 —— 맞은 구역에는 등록 도장,
     * 틀린 구역은 사선으로 지워진다. 인주가 등장하는 유일한 순간이고, 그 색이 곧 결과다.
     */
    drawZones(c, W, H, sc) {
      // 서든데스는 O·X가 아니라 숫자 입력이다. 구역 상자는 윤곽만 남기고,
      // 무엇을 해야 하는지를 인주색으로 크게 적는다. 판정의 색이 곧 지시가 된다.
      if (this.phase === 'sudden') {
        const T = H * BOX.top;
        const B = H * BOX.bot;
        c.strokeStyle = P.rule;
        c.lineWidth = 1;
        for (const side of ['O', 'X']) {
          const L = W * (side === 'O' ? BOX.oL : BOX.xL);
          const R = W * (side === 'O' ? BOX.oR : BOX.xR);
          c.strokeRect(px(L), px(T), Math.round(R - L), Math.round(B - T));
        }
        c.fillStyle = P.seal;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.font = `700 ${Math.round(clamp((B - T) * 0.22, 16, 64))}px "Nanum Myeongjo", Batang, 바탕, serif`;
        c.fillText('숫 자  입 력', W / 2, (T + B) / 2);
        return;
      }

      // 도장이 언제 찍혔는지 —— 눌렸다 떨어지는 맛을 주려고 잰다
      if (this.revealSide && this.sealAt === null) this.sealAt = performance.now();
      if (!this.revealSide) this.sealAt = null;
      const since = this.sealAt === null ? undefined : performance.now() - this.sealAt;

      for (const side of ['O', 'X']) {
        const L = W * (side === 'O' ? BOX.oL : BOX.xL);
        const R = W * (side === 'O' ? BOX.oR : BOX.xR);
        const T = H * BOX.top;
        const B = H * BOX.bot;
        const hit = this.revealSide === side;
        const miss = this.revealSide && !hit;
        const cx = (L + R) / 2;

        // 상자. 면은 해칭, 윤곽은 실선 —— 도면의 문법 그대로.
        // 해칭 방향을 좌우 반대로 두면 두 구역이 같은 무늬로 붙어 보이지 않는다.
        c.fillStyle = P.paper;
        c.fillRect(Math.round(L), Math.round(T), Math.round(R - L), Math.round(B - T));
        hatch(c, L + 1, T + 1, R - L - 2, B - T - 2, 9, miss ? 0.05 : 0.11, side === 'O' ? 1 : -1);
        c.strokeStyle = P.ink;
        c.lineWidth = hit ? 2.4 : 1.2;
        c.strokeRect(px(L), px(T), Math.round(R - L), Math.round(B - T));

        // 글자는 상자 가운데 크게, 옅게. 사람들이 그 위에 서므로 바닥 무늬처럼 깔린다.
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.font = `400 ${Math.round(clamp((B - T) * 0.55, 22, 220))}px "Nanum Myeongjo", Batang, 바탕, serif`;
        c.fillStyle = miss ? 'rgba(20,20,20,.08)' : 'rgba(20,20,20,.20)';
        c.fillText(side, cx, (T + B) / 2 + (B - T) * 0.03);

        if (miss) {
          // 거절 —— 상자를 사선으로 지운다
          c.strokeStyle = P.seal;
          c.lineWidth = Math.max(1.5, H * 0.006);
          c.beginPath();
          c.moveTo(px(L + (R - L) * 0.05), px(B - (B - T) * 0.07));
          c.lineTo(px(R - (R - L) * 0.05), px(T + (B - T) * 0.07));
          c.stroke();
        } else if (hit) {
          seal(c, R - (R - L) * 0.15, T + (B - T) * 0.22, Math.max(10, H * 0.055), '登', since);
        }
      }
    }

    drawPeople(c, t) {
      const tier = tierFor(this.alive || this.n);
      const pendingLabels = [];
      const baseR = this.r || radiusFor(this.alive || this.n, this.h, this.compact ? 0.032 : 0.020);
      const namedMap = this.named ? new Map(this.named.map((x) => [x.i, x])) : null;

      const champ = this.championIndex;

      for (const p of this.people) {
        if (champ !== null && p.i !== champ) continue;
        if (p.fade < 0.03) continue;
        if (p.y > this.h * 1.15 && !p.alive) continue;

        const isChamp = p.i === champ;
        const onRoof = isChamp && this.scene === 'rooftop';
        const r = isChamp ? Math.max(baseR, this.h * (onRoof ? ROOF_R : 0.105)) : baseR;
        // 소속색은 서버 명부(data/employees.json)가 원본이다. DIV_TINT는 못 받았을 때의 대비책.
        const tint = (this.divisions[p.div] && this.divisions[p.div].color) || DIV_TINT[p.div % DIV_TINT.length];
        c.globalAlpha = isChamp ? 1 : p.fade;

        const X = p.x;
        const Y = p.y;

        // 발밑 접지선. 도면에서 사람이 바닥에 닿아 있다는 표시는 짧은 가로선 하나면 된다.
        if (isChamp) {
          c.strokeStyle = P.ink;
          c.lineWidth = 1;
          c.beginPath();
          c.moveTo(px(X - r * 1.1), px(Y));
          c.lineTo(px(X + r * 1.1), px(Y));
          c.stroke();
          hatch(c, X - r * 1.1, Y, r * 2.2, r * 0.22, 4, 0.28, 1);
        }

        const running = Math.abs(p.y - p.ty) > r * 0.6;
        const bob = running ? Math.abs(Math.sin(t / 90 + p.seed * 6.3)) * r * 0.28 : 0;

        // 아주 멀리서 본 군중. 한 사람이 몇 px이면 윤곽선이 뭉개지므로 점으로 찍는다.
        if (tier <= 1 && !isChamp) {
          c.fillStyle = tint;
          c.beginPath();
          c.arc(X, Y - r * 0.9 - bob, r * 0.75, 0, 6.283);
          c.fill();
        } else {
          this.drawPerson(c, X, Y - bob, r, tint, running);
        }

        // 방향을 감춘 구간에서는 머리 위에 표시만 남는다
        if (p.decided && !p.choice && p.alive) {
          c.strokeStyle = P.ink;
          c.lineWidth = 1;
          c.beginPath();
          c.arc(X, Y - r * 3.3 - bob, Math.max(1.5, r * 0.26), 0, 6.283);
          c.stroke();
        }

        if (p.alive && r >= 4) {
          if (p.flag === 'v') this.drawCrown(c, X, Y - r * 3.35 - bob, r);
          else if (p.flag === 'n') this.drawSprout(c, X + r * 0.95, Y - r * 2.9 - bob, r);
        }

        // 본인 표시 — 도면의 인출선과 부호로 가리킨다
        if (this.myIndex === p.i && p.alive) {
          c.globalAlpha = 1;
          callout(c, '本人', X + r * 0.5, Y - r * 1.6 - bob,
            X + r * 2.6, Y - r * 3.2 - bob, Math.max(7, r * 0.85));
        }

        if (tier >= 3 && p.alive && namedMap) {
          const info = namedMap.get(p.i);
          if (info) pendingLabels.push({ x: X, y: Y - r * 1.9, name: tier >= 4 ? info.name : info.empId });
        }
      }
      c.globalAlpha = 1;

      /**
       * 이름표는 도면부호처럼 지시선으로 뺀다.
       *
       * 머리 위에 그대로 얹으면 대기 구역에서 서로 겹쳐 아무것도 읽을 수 없다 ——
       * 실제로 그랬다. 왼쪽 절반은 왼쪽 여백에, 오른쪽 절반은 오른쪽 여백에
       * 사다리처럼 쌓고, 각자에게서 지시선을 뻗는다. 세로 순서를 y로 맞춰
       * 지시선이 서로 교차하지 않게 한다.
       */
      if (pendingLabels.length) {
        const fs = Math.max(7, Math.min(10, baseR * 0.62));
        const step = fs * 1.7;
        const top = this.h * 0.585;
        pendingLabels.sort((a, b) => a.x - b.x);
        const halfN = Math.ceil(pendingLabels.length / 2);
        const leftG = pendingLabels.slice(0, halfN).sort((a, b) => a.y - b.y);
        const rightG = pendingLabels.slice(halfN).sort((a, b) => a.y - b.y);
        leftG.forEach((L, i) => callout(c, L.name, L.x - baseR * 0.5, L.y, this.w * 0.155, top + i * step, fs));
        rightG.forEach((L, i) => callout(c, L.name, L.x + baseR * 0.5, L.y, this.w * 0.845, top + i * step, fs));
      }
    }

    /**
     * 인물 기호.
     *
     * 도면 속 사람은 사진이 아니라 기호다. 윤곽선으로 형태를 정하고 안쪽을 소속색으로
     * 아주 옅게만 채운다. 색이 선을 이기면 그 순간 도면이 아니라 삽화가 된다.
     */
    drawPerson(c, x, y, r, tint, running) {
      c.lineWidth = Math.max(0.7, r * 0.11);
      c.strokeStyle = P.ink;
      c.lineJoin = 'round';
      c.lineCap = 'round';

      // 다리
      c.beginPath();
      if (running) {
        c.moveTo(x - r * 0.52, y);
        c.lineTo(x - r * 0.05, y - r * 1.15);
        c.moveTo(x + r * 0.48, y - r * 0.18);
        c.lineTo(x + r * 0.05, y - r * 1.15);
      } else {
        c.moveTo(x - r * 0.32, y);
        c.lineTo(x - r * 0.08, y - r * 1.15);
        c.moveTo(x + r * 0.32, y);
        c.lineTo(x + r * 0.08, y - r * 1.15);
      }
      c.stroke();

      // 몸통 — 사다리꼴 윤곽에 옅은 소속색
      c.beginPath();
      c.moveTo(x - r * 0.55, y - r * 1.15);
      c.lineTo(x - r * 0.42, y - r * 2.15);
      c.lineTo(x + r * 0.42, y - r * 2.15);
      c.lineTo(x + r * 0.55, y - r * 1.15);
      c.closePath();
      c.fillStyle = tint;
      c.globalAlpha *= 0.42;
      c.fill();
      c.globalAlpha /= 0.42;
      c.stroke();

      // 머리 — 비워 둔다. 도면의 인물은 얼굴이 없다.
      c.beginPath();
      c.arc(x, y - r * 2.68, r * 0.55, 0, 6.283);
      c.fillStyle = P.paper;
      c.fill();
      c.stroke();
    }

    /** VIP 왕관 */
    drawCrown(c, x, y, r) {
      c.strokeStyle = P.ink;
      c.lineWidth = Math.max(0.7, r * 0.1);
      c.beginPath();
      c.moveTo(x - r * 0.6, y + r * 0.3);
      c.lineTo(x - r * 0.6, y - r * 0.35);
      c.lineTo(x - r * 0.25, y + r * 0.02);
      c.lineTo(x, y - r * 0.5);
      c.lineTo(x + r * 0.25, y + r * 0.02);
      c.lineTo(x + r * 0.6, y - r * 0.35);
      c.lineTo(x + r * 0.6, y + r * 0.3);
      c.closePath();
      c.stroke();
    }

    /** 신입 새싹 */
    drawSprout(c, x, y, r) {
      c.strokeStyle = P.ink;
      c.lineWidth = Math.max(0.7, r * 0.1);
      c.beginPath();
      c.moveTo(x, y + r * 0.55);
      c.lineTo(x, y - r * 0.3);
      c.moveTo(x, y - r * 0.05);
      c.lineTo(x - r * 0.45, y - r * 0.35);
      c.moveTo(x, y - r * 0.2);
      c.lineTo(x + r * 0.45, y - r * 0.5);
      c.stroke();
    }

    /**
     * 도면 가구 — 캡션, 도면부호 지시선, 부호의 설명, 쪽번호.
     *
     * 상자와 사람만 있으면 그냥 다이어그램이다. 【도 N】 캡션과 숫자 부호,
     * 지시선, 부호의 설명이 붙어야 명세서의 도면이 된다.
     */
    drawSheetFurniture(c, W, H, sc, champScene) {
      const s = Math.max(7, Math.round(Math.min(W, H) * 0.045));
      const m = Math.max(5, Math.round(Math.min(W, H) * 0.022));

      c.textAlign = 'left';
      c.textBaseline = 'top';
      c.fillStyle = P.ink;
      c.font = `500 ${s}px "Nanum Myeongjo", Batang, 바탕, serif`;
      c.fillText(`【도 ${sc.no}】 ${sc.caption}`, m + s * 0.5, m + s * 0.35);

      // 쪽번호 — 공보는 늘 아래 가운데에 - N - 이 있다
      c.textAlign = 'center';
      c.textBaseline = 'bottom';
      c.fillStyle = P.mid;
      c.font = `${Math.max(6, s * 0.75)}px ui-monospace, monospace`;
      c.fillText(`- ${sc.no} -`, W / 2, H - m - 2);

      if (champScene || this.scene !== 'ground') return;

      // 도면부호 지시선. 상자 사이 빈 하늘과 대기 구역 옆이 부호의 자리다.
      const cs = Math.max(7, Math.round(Math.min(W, H) * 0.042));
      callout(c, '10', W * 0.36, H * BOX.top, W * 0.425, H * 0.055, cs);
      callout(c, '20', W * 0.64, H * BOX.top, W * 0.575, H * 0.055, cs);
      // 후반에는 개인 이름표 지시선이 그 자리를 쓴다. 익명 군중 부호는 접는다.
      if (tierFor(this.alive || this.n) < 3) callout(c, '30', W * 0.68, H * 0.815, W * 0.80, H * 0.72, cs);

      // 부호의 설명 — 도면 아래에 늘 붙는 한 줄
      c.textAlign = 'left';
      c.textBaseline = 'bottom';
      c.fillStyle = P.mid;
      c.font = `${Math.max(6, cs * 0.8)}px ui-monospace, monospace`;
      c.fillText('10 O 구역   20 X 구역   30 응답 대기', m + s * 0.5, H - m - 2);
    }
  }

  global.CrowdStage = CrowdStage;
  global.CROWD_SCENES = SCENES;
  global.CROWD_PALETTE = P;
  global.crowdHatch = hatch;
  global.crowdSeal = seal;
  global.crowdCallout = callout;
  // 인물 기호. drawPerson은 this를 쓰지 않으므로 그대로 떼어 쓴다.
  global.crowdDrawPerson = CrowdStage.prototype.drawPerson;
  global.CROWD_DIV_TINT = DIV_TINT;

  /** 엔딩 카드가 같은 옥상을 그리려고 쓴다. 두 곳에 같은 그림을 두지 않으려는 것. */
  global.paintCrowdScene = (c, name, W, H, t, stage) => {
    const sc = SCENES[name] || SCENES.lobby;
    c.fillStyle = P.paper;
    c.fillRect(0, 0, W, H);
    sc.draw(c, W, H, t, stage);
  };
  // 옥상 구도. roof-lab.html이 사진의 난간선을 여기에 맞추려고 읽는다.
  global.ROOF_GEOMETRY = { sky: ROOF_SKY, edge: ROOF_EDGE, deck: ROOF_DECK, stand: ROOF_STAND };
})(window);
