'use strict';

/**
 * 12:55 — 옥상 배경 이미지
 *
 * 사진을 그대로 깔지 않는다. 스타일을 통과시켜서 깐다.
 *
 * 실사 사진을 배경으로 쓰고 싶은 이유는 절차적으로 만들기 어려운 것 —— 구도와 빛 —— 을
 * 얻기 위해서다. 그런데 사진을 손대지 않고 깔면 그 위에 서는 우승자와 해상도·엣지·광원이
 * 전부 어긋나서, 스타일 대비가 아니라 합성 실패로 읽힌다. 그래서 사진에서는 구도와 빛만
 * 가져오고, 팔레트 양자화와 디더링으로 나머지 화면과 같은 세계에 넣는다.
 *
 * 두 번째 문제는 비율이다. 옥상 캔버스는 고정 비율이 아니다.
 *
 *   데스크톱 참여자 화면   1223 × 228   (5.4 : 1)
 *   폰 참여자 화면          388 × 286   (1.36 : 1)
 *   전광판                  또 다르다
 *
 * `.rooftop-box`가 높이는 clamp(180px, 32vh, 300px)인데 폭은 100%라 이렇게 벌어진다.
 * 사진 한 장을 cover로 채우면 넓은 쪽에서는 도시가 잘려나가고 좁은 쪽에서는 난간선이
 * 화면 밖으로 밀린다. 그래서 이 파일은 crop을 중앙 정렬로 하지 않는다. 원본에서 난간선이
 * 어디인지(edge)를 선언하게 하고, 어떤 비율에서도 그 선이 무대의 ROOF_EDGE에 오도록
 * 세로 오프셋을 계산한다. 우승자가 항상 난간 안쪽에 서는 이유가 이것이다.
 *
 * 이미지가 없으면 아무 일도 일어나지 않는다. crowd.js가 원래의 절차적 옥상을 그린다.
 */

(function (global) {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* ── 팔레트 ──────────────────────────────────────────────
   *
   * 스타일을 정하면 여기에 그 팔레트를 넣는다. 사진은 이 색들로만 다시 그려진다.
   * 색 가짓수를 묶는 것이 "커밋한 스타일"이라는 인상의 대부분을 만든다.
   */
  const PALETTES = {
    // 점심시간 오락실 — 16색 아케이드
    arcade16: [
      '#1A1A2E', '#16213E', '#3A0CA3', '#7209B7',
      '#F72585', '#FF5D5D', '#FF9F1C', '#FFD60A',
      '#B9E769', '#06D6A0', '#4ADEDE', '#4CC9F0',
      '#6C7A9C', '#C9D1D9', '#FFF3E4', '#FFFFFF',
    ],
    // 특허 도면 — 먹과 종이
    ink5: ['#141414', '#5A5A5A', '#9A9A9A', '#C8C2B6', '#FAF7F0'],
  };

  const BAYER4 = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ];

  const hexToRgb = (hex) => {
    const n = parseInt(String(hex).slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };

  /** 사진은 대개 팔레트보다 부드럽다. 넣기 전에 대비와 채도를 조금 밀어준다. */
  function grade(data, g) {
    const b = g.brightness || 0;
    const c = 1 + (g.contrast || 0);
    const s = 1 + (g.saturation || 0);
    for (let i = 0; i < data.length; i += 4) {
      let r = data[i], gr = data[i + 1], bl = data[i + 2];
      r = (r - 128) * c + 128 + b;
      gr = (gr - 128) * c + 128 + b;
      bl = (bl - 128) * c + 128 + b;
      const lum = r * 0.299 + gr * 0.587 + bl * 0.114;
      data[i] = clamp(lum + (r - lum) * s, 0, 255);
      data[i + 1] = clamp(lum + (gr - lum) * s, 0, 255);
      data[i + 2] = clamp(lum + (bl - lum) * s, 0, 255);
    }
  }

  /**
   * 팔레트로 다시 그린다. 순서 디더링(Bayer 4×4)을 섞어야 하늘 그라디언트가
   * 띠로 끊기지 않고 점으로 흩어진다. 그 점무늬가 곧 스타일의 서명이다.
   */
  function quantize(imageData, palette, spread) {
    const pal = palette.map(hexToRgb);
    const d = imageData.data;
    const W = imageData.width;

    for (let i = 0, px = 0; i < d.length; i += 4, px += 1) {
      const x = px % W;
      const y = (px / W) | 0;
      const bias = spread > 0 ? ((BAYER4[y & 3][x & 3] + 0.5) / 16 - 0.5) * spread : 0;
      const r = clamp(d[i] + bias, 0, 255);
      const g = clamp(d[i + 1] + bias, 0, 255);
      const b = clamp(d[i + 2] + bias, 0, 255);

      let best = 0;
      let bestD = Infinity;
      for (let k = 0; k < pal.length; k += 1) {
        const p = pal[k];
        const dr = r - p[0], dg = g - p[1], db = b - p[2];
        // 사람 눈에 맞춘 가중치. 초록 오차가 가장 크게 보인다.
        const dist = dr * dr * 0.30 + dg * dg * 0.59 + db * db * 0.11;
        if (dist < bestD) { bestD = dist; best = k; }
      }
      d[i] = pal[best][0];
      d[i + 1] = pal[best][1];
      d[i + 2] = pal[best][2];
      d[i + 3] = 255;
    }
  }

  /**
   * 원본을 목표 크기에 채우되, 난간선을 맞춘다.
   *
   * cover로 채우면서 세로 오프셋만 따로 잡는 게 요점이다. 가운데 정렬을 하면
   * 비율이 바뀔 때마다 난간선이 위아래로 흔들리고, 우승자가 허공에 서거나
   * 난간에 파묻힌다.
   */
  function drawCover(ctx, img, srcEdge, dstEdge, W, H) {
    // 세로로 밀 여유가 없으면 난간선을 맞출 수 없다.
    //
    // 그냥 cover로 채우면 원본과 목표 비율이 비슷할 때 위아래 여유가 0이 되고,
    // 오프셋이 그대로 잘려서 난간선이 목표에서 벗어난다. 실제로 16:9 원본을
    // 16:9 화면에 넣었을 때 24px이 밀렸다.
    //
    // 그래서 필요한 여유를 먼저 계산해 그만큼 확대한다. 아래 두 조건을 동시에 만족해야
    // 오프셋이 잘리지 않는다.
    //   난간 위쪽이 모자라지 않을 것 :  dh ≥ H · dstEdge / srcEdge
    //   난간 아래쪽이 모자라지 않을 것 :  dh ≥ H · (1−dstEdge) / (1−srcEdge)
    // 가로가 좀 더 잘리는 건 감수한다. 잘려도 되는 쪽은 도시의 좌우다.
    const need = Math.max(dstEdge / srcEdge, (1 - dstEdge) / (1 - srcEdge));
    const s = Math.max(W / img.width, (H * need) / img.height);
    const dw = img.width * s;
    const dh = img.height * s;
    const dx = (W - dw) / 2;
    const dy = clamp(H * dstEdge - dh * srcEdge, H - dh, 0);
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  /* ── 배경 ────────────────────────────────────────────── */

  class RoofBackdrop {
    /**
     * @param {object} cfg
     *   sources  [{ src, minAspect, edge, stand }]  넓은 것부터. 비율에 맞는 첫 항목을 쓴다.
     *              edge  원본에서 난간 윗선의 위치 (0..1)
     *              stand 우승자가 설 자리 (0..1). 없으면 edge + 0.17.
     *   palette  'arcade16' | 'ink5' | [hex...] | null   null이면 색은 그대로 둔다
     *   buffer   저해상도 버퍼의 가로 픽셀 수. null이면 원본 해상도로 쓴다.
     *   dither   0이면 끔. 24~40 사이가 무난하다.
     *   grade    { brightness, contrast, saturation }
     */
    constructor(cfg) {
      const c = cfg || {};
      this.sources = c.sources || [];
      this.palette = typeof c.palette === 'string' ? PALETTES[c.palette] : c.palette || null;
      this.buffer = c.buffer || null;
      this.dither = c.dither === undefined ? 32 : c.dither;
      this.grade = c.grade || null;
      this.life = c.life !== false;   // 창 반짝임을 얹을지. 도면 스타일에서는 끈다.

      this.img = null;
      this.pick = null;
      this.out = null;       // 변환 결과 캔버스
      this.outW = 0;
      this.outH = 0;
      this.failed = false;
    }

    /** 비율에 맞는 원본을 골라 읽는다. 실패해도 조용히 넘어간다 — 절차적 옥상이 받는다. */
    load(aspect) {
      const pick = this.sources.find((s) => aspect >= (s.minAspect || 0)) || this.sources[0];
      if (!pick) { this.failed = true; return Promise.resolve(false); }
      if (this.pick === pick && this.img) return Promise.resolve(true);

      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          this.img = img;
          this.pick = pick;
          this.out = null;
          resolve(true);
        };
        img.onerror = () => {
          // 이미지가 아직 없을 수 있다. 그게 정상 동작이다.
          this.failed = true;
          resolve(false);
        };
        img.src = pick.src;
      });
    }

    ready() { return !!this.img; }

    /** 원본이 선언한 난간선. 무대가 우승자를 세울 때 쓴다. */
    edge() { return this.pick ? this.pick.edge : null; }
    stand() {
      if (!this.pick) return null;
      return this.pick.stand === undefined ? this.pick.edge + 0.17 : this.pick.stand;
    }

    /** 캔버스 크기가 바뀌었을 때만 다시 만든다. 변환은 비싸다. */
    build(W, H, dstEdge) {
      if (!this.img) return false;
      if (this.out && this.outW === W && this.outH === H) return true;

      const bw = this.buffer ? this.buffer : Math.round(W);
      const bh = Math.max(1, Math.round(bw * (H / W)));

      const cv = document.createElement('canvas');
      cv.width = bw;
      cv.height = bh;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = 'high';
      drawCover(cx, this.img, this.pick.edge, dstEdge, bw, bh);

      if (this.grade || this.palette) {
        const d = cx.getImageData(0, 0, bw, bh);
        if (this.grade) grade(d.data, this.grade);
        if (this.palette) quantize(d, this.palette, this.dither);
        cx.putImageData(d, 0, 0);
      }

      this.out = cv;
      this.outW = W;
      this.outH = H;
      return true;
    }

    /** 저해상도 버퍼는 뭉개지 않고 확대한다. 그래야 픽셀이 픽셀로 남는다. */
    draw(ctx, W, H) {
      if (!this.out) return false;
      const smooth = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = !this.buffer;
      ctx.drawImage(this.out, 0, 0, this.out.width, this.out.height, 0, 0, W, H);
      ctx.imageSmoothingEnabled = smooth;
      return true;
    }
  }

  /* ── 설정 ────────────────────────────────────────────────
   *
   * 옥상 사진을 쓰려면 여기 한 곳만 고치면 된다.
   *
   *   1. public/img/ 에 이미지를 넣는다. 두 벌을 권한다 —— 전광판과 데스크톱용 가로,
   *      폰용 세로. 한 장으로 5.4:1과 1.36:1을 모두 감당할 수는 없다.
   *   2. 각 원본에서 난간 윗선이 세로로 몇 %에 있는지 재서 edge에 적는다.
   *      이 값이 틀리면 우승자가 허공에 서거나 난간에 파묻힌다.
   *      roof-lab.html 에서 사진을 끌어다 놓고 눈으로 맞출 수 있다.
   *   3. enabled 를 true 로 바꾼다.
   *
   * enabled 가 false인 동안에는 아무것도 읽지 않는다. 절차적 옥상이 그대로 쓰인다.
   */
  global.ROOF_BACKDROP_CONFIG = {
    enabled: false,

    sources: [
      { src: 'img/rooftop-wide.webp', minAspect: 2.0, edge: 0.66, stand: 0.86 },
      { src: 'img/rooftop-tall.webp', minAspect: 0, edge: 0.62, stand: 0.84 },
    ],

    // 아트 디렉션은 특허 도면이다. 사진도 먹과 종이로 바꿔서 들어온다.
    palette: 'ink5',
    buffer: null,
    dither: 44,          // 색이 다섯뿐이라 점무늬를 더 세게 섞어야 계조가 산다
    grade: { brightness: 4, contrast: 0.22, saturation: -1 },   // 채도를 완전히 뺀다
    life: true,
  };

  global.RoofBackdrop = RoofBackdrop;
  global.ROOF_PALETTES = PALETTES;
})(window);
