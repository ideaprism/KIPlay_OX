'use strict';

/**
 * 12:55 — 군중 무대 렌더러
 *
 * 구도
 *   화면 위쪽에 O와 X 두 발판이 있고, 아래 중앙에 사람들이 몰려 있다.
 *   문제가 뜨면 각자 O나 X로 달려 올라간다. 앞사람이 어디로 뛰는지가 그대로 보인다.
 *   인원이 많으면 뒷줄은 화면 아래로 넘쳐 흐른다. 400명을 다 보여줄 필요가 없다.
 *   앞의 100명 남짓이 움직이는 것만 보여도 군중은 군중으로 읽힌다.
 *
 * 층 상승
 *   정답 발판이 위로 오르면 카메라가 따라 올라간다. 그래서 화면 안에서는
 *   맞힌 사람들이 위 발판에서 아래 중앙으로 내려와 다음 층의 군중이 되고,
 *   틀린 사람들은 아래로 흘러 사라진다. 한 번의 연속된 움직임으로 층이 바뀐다.
 *
 * 이 파일은 그리기만 한다. 탈락 판정은 서버가 이미 끝냈고 여기서는 확정된 사실을
 * 렌더링할 뿐이다. 프레임이 밀려도 게임 결과는 흔들리지 않는다.
 */

(function (global) {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  // ── 구도 비율 (화면 기준)
  const ZONE_Y = 0.17;      // O / X 발판의 높이
  const ZONE_CX_O = 0.27;   // O 발판 중심
  const ZONE_CX_X = 0.73;   // X 발판 중심
  const ZONE_W = 0.38;      // 발판 폭
  const HOME_Y = 0.70;      // 군중 첫 줄
  const HOME_W = 0.42;      // 군중 폭

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

  // ── 층 환경
  const SCENES = {
    lobby:      { sky: ['#1B2340', '#131A31'], plate: '#2E3860', edge: '#4A5788', label: '로비',   draw: drawLobby },
    office:     { sky: ['#1A2138', '#12172A'], plate: '#2A3358', edge: '#44507E', label: '사무실', draw: drawOffice },
    review:     { sky: ['#241A2A', '#17111E'], plate: '#3A2A44', edge: '#6B4670', label: '심사실', draw: drawReview },
    archive:    { sky: ['#1E1A16', '#141110'], plate: '#382E26', edge: '#5C4834', label: '서고',   draw: drawArchive },
    datacenter: { sky: ['#0E1A2C', '#08111F'], plate: '#16294A', edge: '#255076', label: '전산실', draw: drawDatacenter },
    rooftop:    { sky: ['#3B2A46', '#8A4A38'], plate: '#241B36', edge: '#E08A45', label: '옥상',   draw: drawRooftop },
  };

  function drawLobby(c, w, h) {
    c.fillStyle = 'rgba(120,150,220,.10)';
    for (let i = 0; i < 5; i += 1) c.fillRect(w * (0.06 + i * 0.2), h * 0.30, w * 0.1, h * 0.30);
  }
  function drawOffice(c, w, h) {
    c.fillStyle = 'rgba(200,220,255,.08)';
    for (let i = 0; i < 7; i += 1) c.fillRect(w * (0.05 + i * 0.13), h * 0.34, w * 0.045, 4);
    c.fillStyle = 'rgba(120,140,200,.06)';
    for (let i = 0; i < 6; i += 1) c.fillRect(w * (0.09 + i * 0.14), h * 0.42, w * 0.07, h * 0.14);
  }
  function drawReview(c, w, h, t) {
    const g = c.createRadialGradient(w / 2, h * 0.05, 10, w / 2, h * 0.05, h * 0.9);
    g.addColorStop(0, 'rgba(230,120,140,.15)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.fillStyle = `rgba(240,140,150,${0.05 + 0.03 * Math.sin(t / 700)})`;
    c.fillRect(0, h * 0.04, w, 3);
  }
  function drawArchive(c, w, h) {
    c.fillStyle = 'rgba(180,140,90,.08)';
    for (let r = 0; r < 3; r += 1) {
      const y = h * (0.34 + r * 0.09);
      c.fillRect(0, y, w, 3);
      for (let i = 0; i < 26; i += 1) {
        if ((i * 7 + r * 3) % 5 === 0) continue;
        c.fillRect(w * (i / 26) + 2, y - 12, w / 34, 12);
      }
    }
  }
  function drawDatacenter(c, w, h, t) {
    c.fillStyle = 'rgba(40,90,150,.15)';
    for (let i = 0; i < 8; i += 1) c.fillRect(w * (0.04 + i * 0.12), h * 0.30, w * 0.07, h * 0.28);
    for (let i = 0; i < 8; i += 1) {
      for (let j = 0; j < 5; j += 1) {
        const on = (Math.sin(t / 300 + i * 1.7 + j * 0.9) + 1) / 2 > 0.55;
        c.fillStyle = on ? 'rgba(90,200,230,.7)' : 'rgba(90,200,230,.14)';
        c.fillRect(w * (0.05 + i * 0.12), h * (0.33 + j * 0.05), 5, 3);
      }
    }
  }
  function drawRooftop(c, w, h, t) {
    c.fillStyle = 'rgba(20,14,34,.85)';
    let x = 0; let seed = 7;
    while (x < w) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const bw = 26 + (seed % 60);
      const bh = h * (0.14 + ((seed >> 7) % 100) / 420);
      c.fillRect(x, h * 0.58 - bh, bw, bh + 10);
      c.fillStyle = 'rgba(255,190,120,.45)';
      for (let i = 0; i < 4; i += 1) {
        if ((Math.sin(t / 1600 + x + i * 2.3) + 1) / 2 > 0.45) c.fillRect(x + 5 + (i % 3) * 8, h * 0.58 - bh + 10 + i * 12, 3, 4);
      }
      c.fillStyle = 'rgba(20,14,34,.85)';
      x += bw + 8;
    }
  }

  // ═══════════════════════════════════════════════════════════════

  class CrowdStage {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.compact = !!opts.compact;
      this.showZones = opts.zones !== false;

      this.people = [];
      this.divisions = [];
      this.n = 0;

      this.phase = 'idle';
      this.floor = 1;
      this.scene = 'lobby';
      this.prevScene = null;
      this.sceneT = 1;
      this.alive = 0;
      this.named = null;
      this.myIndex = null;

      this.revealSide = null;
      this.riseT = 1;
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

    resize() {
      const r = this.canvas.getBoundingClientRect();
      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
      this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
      this.w = r.width;
      this.h = r.height;
      this.layout();
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

      // ?scene= 픽스처로 층을 고정한 상태면 서버 값으로 덮어쓰지 않는다
      if (!this.sceneLocked) {
        if (s.scene && s.scene !== this.scene) {
          this.prevScene = this.scene;
          this.scene = s.scene;
          this.sceneT = 0;
        }
        if (typeof s.floor === 'number' && s.floor !== this.floor) {
          this.floor = s.floor;
          this.riseT = 0;
        }
      }
      if (s.aliveMask) this.applyAlive(s.aliveMask);

      // 새 문항이 시작되면 살아남은 사람들이 다시 아래 중앙으로 모인다
      if (s.phase === 'question') {
        this.revealSide = null;
        for (const p of this.people) { p.choice = null; p.decided = false; }
      }
      this.layout();
    }

    setMyIndex(i) { this.myIndex = i; }

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

      const zones = { O: [], X: [], home: [] };
      const gone = [];
      for (const p of this.people) {
        if (!p.alive) { gone.push(p); continue; }
        // 정답 공개 뒤에는 살아남은 사람이 다음 층의 군중으로 내려온다
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

      // 발판에 올라선 무리는 조금 더 촘촘히 서서 옆으로 넓게 퍼진다.
      // 세로로 길어지면 두 진영이 화면 중앙까지 흘러내려 구도가 지저분해진다.
      const plateTh = Math.max(4, H * 0.014);
      place(zones.home, W / 2, H * HOME_Y, HOME_W);
      place(zones.O, W * ZONE_CX_O, H * ZONE_Y + plateTh, ZONE_W, 0.78);
      place(zones.X, W * ZONE_CX_X, H * ZONE_Y + plateTh, ZONE_W, 0.78);

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
      if (this.riseT < 1) this.riseT = Math.min(1, this.riseT + 0.018);
      if (this.sceneT < 1) this.sceneT = Math.min(1, this.sceneT + 0.02);

      for (const p of this.people) {
        // 달려가는 속도. 멀수록 빨리 움직여 모두 비슷한 시간에 도착한다.
        const k = p.alive ? 0.11 : 0.06;
        p.x = lerp(p.x, p.tx, k);
        p.y = lerp(p.y, p.ty, k);
        p.fade = lerp(p.fade, p.alive ? 1 : 0, p.alive ? 0.12 : 0.05);
      }
    }

    draw(now) {
      const c = this.ctx;
      const t = now - this.t0;
      const W = this.w;
      const H = this.h;
      if (W < 8 || H < 8) return;

      c.save();
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      const sc = SCENES[this.scene] || SCENES.lobby;

      // 배경 — 층이 바뀌면 이전 장면에서 넘어온다
      this.paintScene(c, SCENES[this.prevScene] || sc, W, H, t);
      if (this.sceneT < 1) {
        c.globalAlpha = this.sceneT;
        this.paintScene(c, sc, W, H, t);
        c.globalAlpha = 1;
      }

      if (this.showZones) this.drawZones(c, W, H, sc);
      this.drawPeople(c, t);
      if (this.showZones) this.drawFloorTag(c, W, H, sc);

      c.restore();
    }

    paintScene(c, sc, W, H, t) {
      const g = c.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, sc.sky[0]);
      g.addColorStop(1, sc.sky[1]);
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
      sc.draw(c, W, H, t);
    }

    /** 위쪽 O / X 발판 */
    drawZones(c, W, H, sc) {
      const y = H * ZONE_Y;
      const w = W * ZONE_W;
      const th = Math.max(4, H * 0.014);

      for (const side of ['O', 'X']) {
        const cx = W * (side === 'O' ? ZONE_CX_O : ZONE_CX_X);
        const hit = this.revealSide === side;
        const miss = this.revealSide && !hit;

        c.fillStyle = miss ? 'rgba(240,115,106,.22)' : hit ? 'rgba(79,192,141,.30)' : sc.plate;
        c.fillRect(cx - w / 2, y, w, th);
        c.fillStyle = miss ? 'rgba(240,115,106,.5)' : hit ? '#4FC08D' : sc.edge;
        c.fillRect(cx - w / 2, y, w, Math.max(2, th * 0.3));

        c.textAlign = 'center';
        c.textBaseline = 'alphabetic';
        c.font = `700 ${Math.round(clamp(H * 0.13, 20, 96))}px ui-monospace, monospace`;
        c.fillStyle = miss ? 'rgba(240,115,106,.4)' : hit ? '#4FC08D' : 'rgba(255,255,255,.30)';
        c.fillText(side, cx, y - H * 0.02);
      }
    }

    drawPeople(c, t) {
      const tier = tierFor(this.alive || this.n);
      const r = this.r || radiusFor(this.alive || this.n, this.h, this.compact ? 0.032 : 0.020);
      const namedMap = this.named ? new Map(this.named.map((x) => [x.i, x])) : null;

      for (const p of this.people) {
        if (p.fade < 0.03) continue;
        if (p.y > this.h * 1.15 && !p.alive) continue;

        const col = (this.divisions[p.div] && this.divisions[p.div].color) || '#8B93B0';
        c.globalAlpha = p.fade;

        // 달리는 중이면 살짝 위아래로 튄다
        const running = Math.abs(p.y - p.ty) > r * 0.6;
        const bob = running
          ? Math.abs(Math.sin(t / 90 + p.seed * 6.3)) * r * 0.35
          : Math.sin(t / 640 + p.seed * 6.3) * r * 0.1;

        if (tier <= 1) {
          c.fillStyle = col;
          c.beginPath();
          c.arc(p.x, p.y - bob, r * 0.92, 0, 6.283);
          c.fill();
        } else {
          c.fillStyle = col;
          c.beginPath();
          c.arc(p.x, p.y - r * 1.55 - bob, r * 0.6, 0, 6.283);
          c.fill();
          c.beginPath();
          c.moveTo(p.x - r * 0.62, p.y - bob);
          c.lineTo(p.x - r * 0.4, p.y - r * 0.85 - bob);
          c.lineTo(p.x + r * 0.4, p.y - r * 0.85 - bob);
          c.lineTo(p.x + r * 0.62, p.y - bob);
          c.closePath();
          c.fill();
        }

        // 방향을 감춘 구간에서는 머리 위에 불만 켜진다
        if (p.decided && !p.choice && p.alive) {
          c.fillStyle = '#FFB43C';
          c.beginPath();
          c.arc(p.x, p.y - r * 2.9 - bob, r * 0.27, 0, 6.283);
          c.fill();
        }

        if (p.alive && tier >= 2) {
          if (p.flag === 'v') { c.fillStyle = '#FFB43C'; c.fillRect(p.x - r * 0.5, p.y - r * 3.1 - bob, r, r * 0.42); }
          else if (p.flag === 'n') { c.fillStyle = '#4FC08D'; c.beginPath(); c.arc(p.x + r * 0.88, p.y - r * 2.2 - bob, r * 0.25, 0, 6.283); c.fill(); }
        }

        if (this.myIndex === p.i && p.alive) {
          c.globalAlpha = 1;
          c.strokeStyle = '#FFFFFF';
          c.lineWidth = Math.max(1.2, r * 0.16);
          c.beginPath();
          c.arc(p.x, p.y - r * 0.9 - bob, r * 2, 0, 6.283);
          c.stroke();
        }

        if (tier >= 3 && p.alive && namedMap) {
          const info = namedMap.get(p.i);
          if (info) {
            c.globalAlpha = 1;
            c.textAlign = 'center';
            c.fillStyle = 'rgba(255,255,255,.92)';
            c.font = `700 ${Math.max(9, r * 0.6)}px ui-monospace, monospace`;
            c.fillText(tier >= 4 ? info.name : info.empId, p.x, p.y + r * 1.5);
            if (tier >= 4) {
              c.fillStyle = 'rgba(255,255,255,.5)';
              c.font = `${Math.max(8, r * 0.45)}px system-ui, sans-serif`;
              c.fillText(info.dept, p.x, p.y + r * 2.4);
            }
          }
        }
      }
      c.globalAlpha = 1;
    }

    drawFloorTag(c, W, H, sc) {
      c.textAlign = 'left';
      c.font = '600 11px ui-monospace, monospace';
      c.fillStyle = 'rgba(255,255,255,.4)';
      c.fillText(`${this.floor}F · ${sc.label}`, 12, H - 12);
    }

    /** 미니 타워 — 지금 몇 층인지 */
    drawTower(ctx, x, y, w, h, maxFloor) {
      const floors = Math.max(6, maxFloor);
      const fh = h / floors;
      for (let f = 1; f <= floors; f += 1) {
        const fy = y + h - f * fh;
        const here = f === this.floor;
        ctx.fillStyle = here ? '#FFB43C' : f < this.floor ? 'rgba(255,180,60,.28)' : 'rgba(255,255,255,.08)';
        ctx.fillRect(x, fy + 2, w, fh - 4);
        if (here) {
          ctx.fillStyle = '#241503';
          ctx.font = `700 ${Math.min(13, fh * 0.6)}px ui-monospace, monospace`;
          ctx.textAlign = 'center';
          ctx.fillText(`${f}F`, x + w / 2, fy + fh * 0.68);
        }
      }
    }
  }

  global.CrowdStage = CrowdStage;
  global.CROWD_SCENES = SCENES;
})(window);
