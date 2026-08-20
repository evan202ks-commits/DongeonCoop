// Rendu 2D vue de dessus : terrain plat, plots de depot, joueurs.
export class Renderer {
  constructor(canvas, config, items = {}, classes = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.config = config;
    this.items = items;
    this.classes = classes;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.camera = { x: 0, y: 0 };
    this.iconCache = new Map(); // src -> { img, ready }
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** Charge (et met en cache) l'icone d'un objet ; renvoie l'image des qu'elle est prete. */
  getIcon(src) {
    let entry = this.iconCache.get(src);
    if (!entry) {
      const img = new Image();
      entry = { img, ready: false };
      img.onload = () => { entry.ready = true; };
      img.src = src;
      this.iconCache.set(src, entry);
    }
    return entry.ready ? entry.img : null;
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.canvas.width = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.view = { w, h };
  }

  centerOn(x, y) {
    const { width, height } = this.config.WORLD;
    const { w, h } = this.view;
    this.camera.x = w >= width ? (width - w) / 2 : Math.max(0, Math.min(width - w, x - w / 2));
    this.camera.y = h >= height ? (height - h) / 2 : Math.max(0, Math.min(height - h, y - h / 2));
  }

  frame(players, items, selfId, now) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.view.w, this.view.h);
    ctx.save();
    ctx.translate(-this.camera.x, -this.camera.y);

    this.drawGround();
    this.drawSpawnPads();
    for (const item of items) this.drawItem(item, now);

    // Tri par Y : les joueurs plus bas passent devant.
    const sorted = [...players].sort((a, b) => a.y - b.y);
    for (const p of sorted) this.drawPlayer(p, p.id === selfId, now);

    ctx.restore();
  }

  drawGround() {
    const ctx = this.ctx;
    const { width, height, tile } = this.config.WORLD;
    const cam = this.camera, view = this.view;

    // Sol de base
    ctx.fillStyle = '#131c2e';
    ctx.fillRect(0, 0, width, height);

    // Damier discret, limite aux tuiles visibles
    const x0 = Math.max(0, Math.floor(cam.x / tile));
    const y0 = Math.max(0, Math.floor(cam.y / tile));
    const x1 = Math.min(width / tile, Math.ceil((cam.x + view.w) / tile));
    const y1 = Math.min(height / tile, Math.ceil((cam.y + view.h) / tile));

    for (let ty = y0; ty < y1; ty++) {
      for (let tx = x0; tx < x1; tx++) {
        if ((tx + ty) % 2 === 0) continue;
        ctx.fillStyle = 'rgba(255,255,255,0.014)';
        ctx.fillRect(tx * tile, ty * tile, tile, tile);
      }
    }

    // Lignes de dalles
    ctx.strokeStyle = 'rgba(148,163,184,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let tx = x0; tx <= x1; tx++) { ctx.moveTo(tx * tile, y0 * tile); ctx.lineTo(tx * tile, y1 * tile); }
    for (let ty = y0; ty <= y1; ty++) { ctx.moveTo(x0 * tile, ty * tile); ctx.lineTo(x1 * tile, ty * tile); }
    ctx.stroke();

    // Bordure du terrain
    ctx.strokeStyle = 'rgba(56,189,248,0.35)';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, width - 4, height - 4);
  }

  drawSpawnPads() {
    const ctx = this.ctx;
    const { width, height } = this.config.WORLD;
    const { ringRadius, slots } = this.config.SPAWN;

    ctx.strokeStyle = 'rgba(74,222,128,0.12)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(width / 2, height / 2, ringRadius, 0, Math.PI * 2);
    ctx.stroke();

    for (let i = 0; i < slots; i++) {
      const angle = (i / slots) * Math.PI * 2;
      const x = width / 2 + Math.cos(angle) * ringRadius;
      const y = height / 2 + Math.sin(angle) * ringRadius;
      ctx.strokeStyle = 'rgba(74,222,128,0.22)';
      ctx.beginPath();
      ctx.arc(x, y, 22, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /** Objet au sol : icone (ou losange colore a defaut), animation de flottement pour attirer l'oeil. */
  drawItem(item, now) {
    const ctx = this.ctx;
    const def = this.items[item.t] || { color: '#94a3b8', name: item.t };
    // Dephasage par objet (base sur sa position) pour que chaque item flotte a son propre rythme.
    const phase = item.x * 0.05 + item.y * 0.03;
    const bob = Math.sin(now / 350 + phase) * 3;
    const wobble = Math.sin(now / 500 + phase) * 0.08;          // leger balancement
    const breathe = 1 + Math.sin(now / 420 + phase) * 0.06;     // respiration d'echelle
    const glow = 0.35 + Math.sin(now / 300 + phase) * 0.15;     // scintillement doux

    // Ombre au sol : respire un peu moins pour rester ancree.
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(item.x, item.y + 9, 9 * (0.94 + (breathe - 1)), 4, 0, 0, Math.PI * 2);
    ctx.fill();

    const icon = def.icon ? this.getIcon(def.icon) : null;

    if (icon) {
      ctx.save();
      ctx.translate(item.x, item.y + bob);
      ctx.rotate(wobble);
      ctx.scale(breathe, breathe);

      // Halo scintillant derriere l'icone pour donner un peu de vie/magie.
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 14);
      grad.addColorStop(0, `${def.color}${Math.round(glow * 255).toString(16).padStart(2, '0')}`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, 14, 0, Math.PI * 2);
      ctx.fill();

      const size = 22;
      ctx.imageSmoothingEnabled = false; // rendu net pour des sprites pixel-art
      ctx.drawImage(icon, -size / 2, -size / 2, size, size);
      ctx.restore();
    } else {
      // Repli : losange colore pour les types sans icone dediee.
      ctx.save();
      ctx.translate(item.x, item.y + bob);
      ctx.rotate(Math.PI / 4 + wobble);
      ctx.fillStyle = def.color;
      ctx.fillRect(-7, -7, 14, 14);
      ctx.strokeStyle = 'rgba(2,6,23,0.55)';
      ctx.lineWidth = 2;
      ctx.strokeRect(-7, -7, 14, 14);
      ctx.restore();
    }
  }

  drawPlayer(p, isSelf, now) {
    const ctx = this.ctx;
    const r = this.config.PLAYER.radius;

    // Chute a l'arrivee : le corps descend, l'ombre grandit.
    const drop = p.dropProgress ?? 1;            // 0 = en haut, 1 = pose
    const lift = (1 - drop) * 220;               // decalage vertical
    const shadowScale = 0.45 + drop * 0.55;

    // Ombre au sol
    ctx.fillStyle = `rgba(0,0,0,${0.28 * shadowScale})`;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y + r * 0.55, r * shadowScale, r * 0.45 * shadowScale, 0, 0, Math.PI * 2);
    ctx.fill();

    const by = p.y - lift;

    // Corps : teinte du compte a l'interieur, anneau a la couleur de la classe.
    ctx.fillStyle = p.tint || p.color;
    ctx.beginPath();
    ctx.arc(p.x, by, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = p.color;
    ctx.lineWidth = 4;
    ctx.stroke();

    if (isSelf) {
      ctx.strokeStyle = 'rgba(248,250,252,0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, by, r + 3.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Initiale de la classe (M / B / A / V) au centre du corps
    const cls = this.classes[p.classId];
    if (cls) {
      ctx.font = '800 13px Segoe UI, Roboto, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(2,6,23,0.8)';
      ctx.fillText(cls.name[0].toUpperCase(), p.x, by + 0.5);
      ctx.textBaseline = 'alphabetic';
    }

    // Repere de direction
    ctx.fillStyle = 'rgba(2,6,23,0.75)';
    ctx.beginPath();
    ctx.arc(p.x + Math.cos(p.angle) * r * 0.72, by + Math.sin(p.angle) * r * 0.72, r * 0.24, 0, Math.PI * 2);
    ctx.fill();

    // Onde d'impact a l'atterrissage
    if (drop < 1) {
      ctx.strokeStyle = `rgba(74,222,128,${0.5 * (1 - drop)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + (1 - drop) * 30, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Nom
    ctx.font = '600 13px Segoe UI, Roboto, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = isSelf ? '#f8fafc' : '#cbd5e1';
    ctx.fillText(p.name, p.x, by - r - 9);

    if (cls) {
      ctx.font = '600 10px Segoe UI, Roboto, Arial, sans-serif';
      ctx.fillStyle = p.color;
      ctx.fillText(cls.name, p.x, by - r - 21);
    }
  }
}
