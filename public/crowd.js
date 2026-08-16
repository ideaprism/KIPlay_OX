'use strict';

/**
 * 12:55 — 군중 무대 렌더러
 *
 * 숫자로 보여주던 것을 전부 사람으로 바꾼다.
 *   · 생존자 수 = 화면에 실제로 남아 있는 사람
 *   · 집계 = 좌우로 갈라선 무리
 *   · 탈락 = 올라가는 층에 타지 못하고 남겨지는 것
 *
 * 인원이 줄수록 카메라가 가까워지고 사람이 사람다워진다(LOD).
 * 이건 연출이면서 동시에 성능 설계다. 450명일 땐 점이라 싸고, 상세히 그릴 땐 인원이 적다.
 *
 * 이 파일은 그리기만 한다. 탈락 판정은 전부 서버가 이미 끝냈고, 여기서는 확정된 사실을
 * 렌더링할 뿐이다. 프레임이 밀려도 게임 결과는 흔들리지 않는다.
 */

(function (global) {
  // ── 월드 상수
  const FLOOR_H = 260;      // 한 층 높이 (월드 단위)
  const ZONE_X = 150;       // 중앙에서 좌우 진영까지의 거리
  const ZONE_W = 210;
  const ZONE_H = 150;
  const PERSON_R = 3.2;     // 기본 반지름. 카메라 배율이 곱해진다

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  /** 인원이 줄수록 카메라가 다가간다. 450명에서 1배, 10명에서 6.6배. */
  const scaleFor = (alive) => clamp(21 / Math.sqrt(Math.max(1, alive)), 0.9, 8);

  function tierFor(alive) {
    if (alive > 300) return 0; // 점
    if (alive > 100) return 1; // 굵은 점
    if (alive > 30) return 2;  // 실루엣
    if (alive > 10) return 3;  // 실루엣 + 사번
    if (alive > 2) return 4;   // 상세 + 이름
    return 5;                  // 결승
  }

  /** 사각 영역에 count명을 격자로 채울 때 idx번째의 상대 좌표 */
  function slot(idx, count, w, h) {
    const cols = Math.max(1, Math.round(Math.sqrt(count * (w / h))));
    const rows = Math.max(1, Math.ceil(count / cols));
    const cx = idx % cols;
    const cy = Math.floor(idx / cols);
    const gx = cols > 1 ? w / (cols - 1) : 0;
    const gy = rows > 1 ? h / (rows - 1) : 0;
    return {
      x: cols > 1 ? -w / 2 + cx * gx : 0,
      y: rows > 1 ? -h / 2 + cy * gy : 0,
    };
  }

  // ── 층 환경. 에셋 없이 그라디언트와 도형만으로 만든다.
  const SCENES = {
    lobby: {
      sky: ['#1B2340', '#131A31'], floor: '#242C4A', accent: '#3C4870',
      label: '1층 · 로비', draw: drawLobby,
    },
    office: {
      sky: ['#1A2138', '#12172A'], floor: '#212842', accent: '#39456B',
      label: '사무실', draw: drawOffice,
    },
    review: {
      sky: ['#241A2A', '#17111E'], floor: '#2C2136', accent: '#5A3A5E',
      label: '심사실', draw: drawReview,
    },
    archive: {
      sky: ['#1E1A16', '#141110'], floor: '#2A2320', accent: '#4A3B2E',
      label: '서고', draw: drawArchive,
    },
    datacenter: {
      sky: ['#0E1A2C', '#08111F'], floor: '#132238', accent: '#1E3A5C',
      label: '전산실', draw: drawDatacenter,
    },
    rooftop: {
      sky: ['#3B2A46', '#8A4A38'], floor: '#1A1428', accent: '#E08A45',
      label: '옥상', draw: drawRooftop,
    },
  };

  function drawLobby(c, w, h, t) {
    c.fillStyle = 'rgba(120,150,220,.10)';
    for (let i = 0; i < 5; i += 1) c.fillRect(w * (0.08 + i * 0.2), h * 0.1, w * 0.11, h * 0.42);
    c.fillStyle = 'rgba(255,255,255,.05)';
    c.fillRect(0, h * 0.52, w, 2);
    void t;
  }

  function drawOffice(c, w, h) {
    c.fillStyle = 'rgba(200,220,255,.09)';
    for (let i = 0; i < 7; i += 1) c.fillRect(w * (0.06 + i * 0.13), h * 0.14, w * 0.05, 5);
    c.fillStyle = 'rgba(120,140,200,.07)';
    for (let i = 0; i < 6; i += 1) c.fillRect(w * (0.1 + i * 0.14), h * 0.3, w * 0.08, h * 0.18);
  }

  function drawReview(c, w, h, t) {
    const g = c.createRadialGradient(w / 2, h * 0.1, 10, w / 2, h * 0.1, h * 0.8);
    g.addColorStop(0, 'rgba(230,120,140,.16)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    c.fillStyle = `rgba(240,140,150,${0.05 + 0.03 * Math.sin(t / 700)})`;
    c.fillRect(0, h * 0.06, w, 3);
  }

  function drawArchive(c, w, h) {
    c.fillStyle = 'rgba(180,140,90,.08)';
    for (let r = 0; r < 4; r += 1) {
      c.fillRect(0, h * (0.12 + r * 0.1), w, 3);
      for (let i = 0; i < 26; i += 1) {
        if ((i * 7 + r * 3) % 5 === 0) continue;
        c.fillRect(w * (i / 26) + 2, h * (0.12 + r * 0.1) - 13, w / 34, 13);
      }
    }
  }

  function drawDatacenter(c, w, h, t) {
    c.fillStyle = 'rgba(40,90,150,.16)';
    for (let i = 0; i < 8; i += 1) c.fillRect(w * (0.05 + i * 0.12), h * 0.1, w * 0.075, h * 0.4);
    for (let i = 0; i < 8; i += 1) {
      for (let j = 0; j < 6; j += 1) {
        const on = (Math.sin(t / 300 + i * 1.7 + j * 0.9) + 1) / 2 > 0.55;
        c.fillStyle = on ? 'rgba(90,200,230,.75)' : 'rgba(90,200,230,.15)';
        c.fillRect(w * (0.06 + i * 0.12), h * (0.13 + j * 0.06), 5, 3);
      }
    }
  }

  function drawRooftop(c, w, h, t) {
    // 도시 스카이라인. 승자가 내려다보는 그림.
    c.fillStyle = 'rgba(20,14,34,.85)';
    let x = 0;
    let seed = 7;
    while (x < w) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const bw = 26 + (seed % 60);
      const bh = h * (0.16 + ((seed >> 7) % 100) / 380);
      c.fillRect(x, h * 0.62 - bh, bw, bh + 10);
      c.fillStyle = 'rgba(255,190,120,.5)';
      for (let i = 0; i < 5; i += 1) {
        const lit = (Math.sin(t / 1600 + x + i * 2.3) + 1) / 2 > 0.45;
        if (lit) c.fillRect(x + 5 + (i % 3) * 8, h * 0.62 - bh + 10 + i * 12, 3, 4);
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
      this.compact = !!opts.compact;   // 참여자 폰용 축소 모드
      this.showLabels = opts.labels !== false;

      this.people = [];
      this.divisions = [];
      this.n = 0;

      this.phase = 'idle';
      this.floor = 1;
      this.scene = 'lobby';
      this.alive = 0;
      this.joined = 0;
      this.named = null;
      this.myIndex = null;

      this.cam = { y: 0, scale: 1, targetY: 0, targetScale: 1 };
      this.riseT = 1;         // 층 상승 진행도 0→1
      this.riseFrom = 1;
      this.revealSide = null; // 정답 방향
      this.t0 = performance.now();
      this.raf = null;
      this.dpr = 1;

      this._onResize = () => this.resize();
      window.addEventListener('resize', this._onResize);

      // 숨겨진 화면 안에서 만들어지면 크기가 0이라 1x1로 잡힌다.
      // 화면이 표시되는 순간을 잡아 다시 재야 한다.
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
    }

    // ── 데이터 주입 ────────────────────────────────────────────

    setCrowd(crowd) {
      if (!crowd || !crowd.n) return;
      this.divisions = crowd.divisions || [];
      this.n = crowd.n;
      this.people = new Array(crowd.n);
      for (let i = 0; i < crowd.n; i += 1) {
        const s = slot(i, crowd.n, ZONE_W * 1.5, ZONE_H * 1.2);
        this.people[i] = {
          i,
          div: Number(crowd.div[i]) || 0,
          flag: crowd.flags[i] || '.',
          alive: true,
          choice: null,
          decided: false,
          x: s.x, y: s.y,
          tx: s.x, ty: s.y,
          floorY: 0,
          fade: 1,
          seed: (i * 2654435761) % 1000 / 1000,
        };
      }
    }

    setState(s) {
      this.phase = s.phase;
      this.joined = s.joined ?? this.joined;
      this.alive = s.alive ?? this.alive;
      this.named = s.named || null;
      if (typeof s.floor === 'number' && s.floor !== this.floor) {
        this.riseFrom = this.floor;
        this.floor = s.floor;
        this.riseT = 0;
      }
      if (s.scene) this.scene = s.scene;
      if (s.aliveMask) this.applyAlive(s.aliveMask);
      if (s.phase === 'question') this.revealSide = null;
    }

    setMyIndex(i) { this.myIndex = i; }

    applyAlive(mask) {
      for (let i = 0; i < this.people.length && i < mask.length; i += 1) {
        this.people[i].alive = mask[i] === '1';
      }
    }

    /** 방향까지 담긴 마스크. 사람들이 좌우로 걸어간다. */
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

    /** 방향은 감춘 마스크. 제자리에서 불만 켜진다. */
    applyDecided(mask) {
      if (!mask) return;
      for (let i = 0; i < this.people.length && i < mask.length; i += 1) {
        this.people[i].decided = mask[i] === '1';
      }
    }

    /** 정답 공개 — 전원의 선택이 드러나고 정답 쪽이 위로 올라간다. */
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

    /** 진영별로 자리를 다시 배치한다. 매 선택마다 O(n)이지만 450명이면 무시할 수 있다. */
    layout() {
      const zones = { O: [], X: [], null: [] };
      for (const p of this.people) {
        if (!p.alive) continue;
        (zones[p.choice] || zones.null).push(p);
      }
      for (const key of ['O', 'X', 'null']) {
        const list = zones[key];
        const baseX = key === 'O' ? -ZONE_X : key === 'X' ? ZONE_X : 0;
        list.forEach((p, idx) => {
          const s = slot(idx, list.length, key === 'null' ? ZONE_W : ZONE_W * 0.9, ZONE_H);
          p.tx = baseX + s.x;
          p.ty = s.y;
        });
      }
    }

    // ── 루프 ──────────────────────────────────────────────────

    start() { if (!this.raf) this.raf = requestAnimationFrame(this.frame.bind(this)); }
    stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = null; }

    frame(now) {
      this.raf = requestAnimationFrame(this.frame.bind(this));
      this.update(now);
      this.draw(now);
    }

    update() {
      // 층 상승 진행
      if (this.riseT < 1) this.riseT = Math.min(1, this.riseT + 0.016);
      const ease = 1 - Math.pow(1 - this.riseT, 3);

      // 정답 쪽만 위로 오른다. 오답 쪽은 이전 층에 남는다.
      for (const p of this.people) {
        const rising = p.alive;
        p.floorY = rising ? -FLOOR_H * ease : 0;
        p.x = lerp(p.x, p.tx, 0.12);
        p.y = lerp(p.y, p.ty, 0.12);
        p.fade = lerp(p.fade, p.alive ? 1 : 0.28, 0.08);
      }

      const aliveCount = Math.max(1, this.alive || this.n || 1);
      this.cam.targetScale = scaleFor(this.compact ? aliveCount * 2.4 : aliveCount);
      this.cam.targetY = -FLOOR_H * ease;
      this.cam.scale = lerp(this.cam.scale, this.cam.targetScale, 0.045);
      this.cam.y = lerp(this.cam.y, this.cam.targetY, 0.06);
    }

    draw(now) {
      const c = this.ctx;
      const t = now - this.t0;
      const W = this.w;
      const H = this.h;
      if (W < 8 || H < 8) return; // 아직 화면에 붙지 않았다

      c.save();
      c.scale(this.dpr, this.dpr);

      const sc = SCENES[this.scene] || SCENES.lobby;

      // 배경
      const g = c.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, sc.sky[0]);
      g.addColorStop(1, sc.sky[1]);
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
      sc.draw(c, W, H, t);

      // 카메라
      const cx = W / 2;
      const cy = H * 0.62;
      const S = this.cam.scale;
      c.save();
      c.translate(cx, cy - this.cam.y * S * 0.5);

      this.drawPlatforms(c, S, sc);
      this.drawPeople(c, S, t);

      c.restore();

      if (this.showLabels) this.drawOverlay(c, W, H, sc);
      c.restore();
    }

    drawPlatforms(c, S, sc) {
      const halfW = (ZONE_X + ZONE_W * 0.7) * S;
      const gap = 14 * S;
      const ease = 1 - Math.pow(1 - this.riseT, 3);
      const rise = -FLOOR_H * ease * S * 0.5;

      // 아래층 (남겨진 사람들이 서 있는 바닥)
      c.fillStyle = sc.floor;
      c.globalAlpha = 0.55;
      c.fillRect(-halfW, ZONE_H * 0.62 * S, halfW * 2, 10 * S);
      c.globalAlpha = 1;

      // 위로 오르는 바닥 — 정답 쪽 절반
      const side = this.revealSide;
      c.fillStyle = sc.floor;
      if (side === 'O' || side === 'X') {
        const from = side === 'O' ? -halfW : gap;
        c.fillRect(from, ZONE_H * 0.62 * S + rise, halfW - gap, 10 * S);
        c.fillStyle = sc.accent;
        c.fillRect(from, ZONE_H * 0.62 * S + rise, halfW - gap, 2.5 * S);
      } else {
        c.fillRect(-halfW, ZONE_H * 0.62 * S, halfW * 2, 10 * S);
      }
    }

    drawPeople(c, S, t) {
      const tier = tierFor(this.alive || this.n);
      const r = PERSON_R * S;
      const namedMap = this.named ? new Map(this.named.map((x) => [x.i, x])) : null;

      for (const p of this.people) {
        const px = p.x * S;
        const py = (p.y + p.floorY * 0.5) * S;
        const col = (this.divisions[p.div] && this.divisions[p.div].color) || '#8B93B0';

        c.globalAlpha = p.fade;

        if (tier <= 1) {
          // 점
          c.fillStyle = col;
          c.beginPath();
          c.arc(px, py, r * (tier === 0 ? 0.85 : 1.1), 0, 6.283);
          c.fill();
        } else {
          // 실루엣 — 머리와 몸
          const bob = Math.sin(t / 520 + p.seed * 6.3) * r * 0.12;
          c.fillStyle = col;
          c.beginPath();
          c.arc(px, py - r * 1.5 + bob, r * 0.62, 0, 6.283);
          c.fill();
          c.beginPath();
          c.moveTo(px - r * 0.66, py + r * 0.9);
          c.lineTo(px - r * 0.42, py - r * 0.75 + bob);
          c.lineTo(px + r * 0.42, py - r * 0.75 + bob);
          c.lineTo(px + r * 0.66, py + r * 0.9);
          c.closePath();
          c.fill();
        }

        // 선택함 표시 — 방향을 감춘 구간에서 머리 위에 불이 켜진다
        if (p.decided && !p.choice && p.alive) {
          c.fillStyle = '#FFB43C';
          c.beginPath();
          c.arc(px, py - r * 2.9, r * 0.28, 0, 6.283);
          c.fill();
        }

        // 배지
        if (p.alive && tier >= 2) {
          if (p.flag === 'v') { c.fillStyle = '#FFB43C'; c.fillRect(px - r * 0.5, py - r * 3.1, r, r * 0.45); }
          else if (p.flag === 'n') { c.fillStyle = '#4FC08D'; c.beginPath(); c.arc(px + r * 0.9, py - r * 2.2, r * 0.26, 0, 6.283); c.fill(); }
        }

        // 나
        if (this.myIndex === p.i) {
          c.globalAlpha = 1;
          c.strokeStyle = '#FFFFFF';
          c.lineWidth = Math.max(1, r * 0.18);
          c.beginPath();
          c.arc(px, py - r * 0.4, r * 2.1, 0, 6.283);
          c.stroke();
        }

        // 이름표
        if (tier >= 3 && p.alive && namedMap) {
          const info = namedMap.get(p.i);
          if (info) {
            c.globalAlpha = 1;
            c.textAlign = 'center';
            c.fillStyle = 'rgba(255,255,255,.92)';
            c.font = `700 ${Math.max(9, r * 0.62)}px ui-monospace, monospace`;
            c.fillText(tier >= 4 ? info.name : info.empId, px, py + r * 2.3);
            if (tier >= 4) {
              c.fillStyle = 'rgba(255,255,255,.5)';
              c.font = `${Math.max(8, r * 0.46)}px system-ui, sans-serif`;
              c.fillText(info.dept, px, py + r * 3.2);
            }
          }
        }
      }
      c.globalAlpha = 1;
    }

    drawOverlay(c, W, H, sc) {
      // O / X 진영 표시
      if (this.phase === 'question' || this.phase === 'reveal') {
        const y = H * 0.2;
        c.textAlign = 'center';
        c.font = `700 ${Math.round(clamp(W * 0.05, 22, 64))}px ui-monospace, monospace`;
        const okO = this.revealSide === 'O';
        const okX = this.revealSide === 'X';
        c.fillStyle = this.revealSide ? (okO ? '#4FC08D' : 'rgba(240,115,106,.45)') : 'rgba(255,255,255,.34)';
        c.fillText('O', W * 0.22, y);
        c.fillStyle = this.revealSide ? (okX ? '#4FC08D' : 'rgba(240,115,106,.45)') : 'rgba(255,255,255,.34)';
        c.fillText('X', W * 0.78, y);
      }

      // 층 표시
      c.textAlign = 'left';
      c.font = '600 11px ui-monospace, monospace';
      c.fillStyle = 'rgba(255,255,255,.4)';
      c.fillText(`${this.floor}F · ${sc.label}`, 14, H - 14);
    }

    /** 미니 타워 — 지금 몇 층인지 한눈에 */
    drawTower(ctx, x, y, w, h, maxFloor) {
      const floors = Math.max(6, maxFloor);
      const fh = h / floors;
      ctx.save();
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
      ctx.restore();
    }
  }

  global.CrowdStage = CrowdStage;
  global.CROWD_SCENES = SCENES;
})(window);
