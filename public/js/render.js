// Rendu 2D vue de dessus : salle de donjon (image de fond), butin, joueurs.
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
    this.map = config.MAP;
    this.debug = false;         // F2 : superpose la grille de collision

    // Image de la salle : elle sert de sol, de murs et de decor. Tant qu'elle
    // n'est pas chargee, on peint un aplat sombre pour eviter le flash blanc.
    // La porte du haut est peinte dans la carte : ses battants en sont
    // redecoupes une fois pour toutes (buildDoor), pour pouvoir les ecarter.
    this.door = this.map.door;
    this.doorLeaf = null;
    this.doorWheel = null;
    this.doorGlow = 0;

    this.room = new Image();
    this.roomReady = false;
    this.room.onload = () => { this.roomReady = true; this.buildDoor(); };
    this.room.src = this.map.image;

    // Planche des flammes : 8 images cote a cote, fond transparent. Les
    // flammes ont ete effacees de l'image de la salle, ce sont celles-ci qui
    // brulent a leur place.
    this.flameSprite = this.map.flameSprite;
    this.flames = new Image();
    this.flamesReady = false;
    this.flames.onload = () => { this.flamesReady = true; };
    this.flames.src = this.flameSprite.image;

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

  /** Decoupe un morceau de la carte dans un canvas hors ecran, selon un chemin. */
  cutFromRoom(box, path) {
    const cv = document.createElement('canvas');
    cv.width = box.w;
    cv.height = box.h;
    const c = cv.getContext('2d');
    c.save();
    c.beginPath();
    path(c, box);
    c.clip();
    c.imageSmoothingEnabled = false;
    c.drawImage(this.room, -box.x, -box.y, this.config.WORLD.width, this.config.WORLD.height);
    c.restore();
    return cv;
  }

  /**
   * Deux sprites : le battant entier (l'arche) et le disque du rouage.
   * Le rouage tourne autour de son moyeu : un disque tourne reste un disque,
   * donc il se recouvre exactement lui-meme, sans coin transparent a rattraper.
   */
  buildDoor() {
    const { arch, wheel } = this.door;
    this.doorBox = {
      x: arch.x - arch.r - 2,
      y: arch.y - arch.r - 2,
      w: arch.r * 2 + 4,
      h: (arch.bottom - arch.y) + arch.r + 4
    };
    this.doorLeaf = this.cutFromRoom(this.doorBox, (c, box) => {
      const r = arch.r + 1;                 // 1 px de marge : voir buildDoor
      c.arc(arch.x - box.x, arch.y - box.y, r, Math.PI, 0);
      c.lineTo(arch.x + r - box.x, arch.bottom + 1 - box.y);
      c.lineTo(arch.x - r - box.x, arch.bottom + 1 - box.y);
      c.closePath();
    });

    this.doorWheelBox = { x: wheel.x - wheel.r, y: wheel.y - wheel.r, w: wheel.r * 2, h: wheel.r * 2 };
    this.doorWheel = this.cutFromRoom(this.doorWheelBox, (c, box) => {
      c.arc(wheel.x - box.x, wheel.y - box.y, wheel.r, 0, Math.PI * 2);
    });
  }

  /** Contour de l'ouverture : demi-cercle en haut, montants droits jusqu'au seuil. */
  archPath(ctx) {
    const { arch } = this.door;
    ctx.beginPath();
    ctx.arc(arch.x, arch.y, arch.r, Math.PI, 0);
    ctx.lineTo(arch.x + arch.r, arch.bottom);
    ctx.lineTo(arch.x - arch.r, arch.bottom);
    ctx.closePath();
  }

  /**
   * Etat de la porte a `elapsed` ms du declenchement, ou null au repos —
   * auquel cas on ne dessine rien et c'est la porte fermee de la carte
   * qu'on voit, au pixel pres.
   */
  doorState(elapsed) {
    const d = this.door;
    if (elapsed == null || elapsed < 0 || elapsed > d.duration) return null;

    const T = d.timing;
    const turn = (d.wheel.turn * Math.PI) / 180;
    const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    let t = elapsed;

    // 1-2. Le verrou cede : le mecanisme s'illumine et tremble sur place.
    if (t < T.unlock) {
      const k = t / T.unlock;
      return { angle: 0, dx: 0, glow: k, shake: Math.sin(t / 21) * 1.3 * k };
    }
    t -= T.unlock;

    // 3. Rotation : quart de tour du rouage, l'X devient une croix droite.
    if (t < T.rotate) {
      return { angle: turn * ease(t / T.rotate), dx: 0, glow: 1, shake: Math.sin(t / 33) * 0.7 };
    }
    t -= T.rotate;

    // 4-5. Deplacement : les deux moities s'ecartent et decouvrent le passage.
    if (t < T.slide) {
      return { angle: turn, dx: d.slide * ease(t / T.slide), glow: 1, shake: Math.sin(t / 27) * 0.5 };
    }
    t -= T.slide;

    // 6. Ouverte : passage libre, le temps que l'arrivant se pose.
    if (t < T.hold) return { angle: turn, dx: d.slide, glow: 0.72, shake: 0 };
    t -= T.hold;

    // 7. Fermeture : les battants se rejoignent, puis le rouage se reverrouille.
    const k = t / T.close;
    return {
      angle: turn * (1 - Math.max(0, (k - 0.55) / 0.45)),
      dx: d.slide * (1 - ease(Math.min(1, k / 0.6))),
      glow: 0.5 * (1 - k),
      shake: 0
    };
  }

  /** Le battant complet (arche + rouage a son angle courant), a sa place sur la carte. */
  drawDoorLeaf(angle) {
    const ctx = this.ctx;
    const { wheel } = this.door;
    ctx.drawImage(this.doorLeaf, this.doorBox.x, this.doorBox.y);
    if (!angle) return;
    ctx.save();
    ctx.translate(wheel.x, wheel.y);
    ctx.rotate(angle);
    ctx.translate(-wheel.x, -wheel.y);
    ctx.drawImage(this.doorWheel, this.doorWheelBox.x, this.doorWheelBox.y);
    ctx.restore();
  }

  /**
   * La porte, dessinee par-dessus la carte : le passage sombre au fond, puis
   * les deux moities du battant translatees chacune de son cote. Tout est
   * borne a l'arche, donc les battants disparaissent derriere les montants.
   */
  drawDoor(elapsed) {
    const state = this.doorState(elapsed);
    this.doorGlow = state ? state.glow : 0;
    if (!state || !this.doorLeaf) return;

    const ctx = this.ctx;
    const { arch } = this.door;
    const shake = state.shake || 0;

    ctx.save();
    this.archPath(ctx);
    ctx.clip();

    // Le passage : noir violace, un peu plus clair pres du seuil, assombri
    // sur les cotes pour qu'il se creuse au lieu de faire un trou plat.
    const top = arch.y - arch.r;
    const grad = ctx.createLinearGradient(0, top, 0, arch.bottom);
    grad.addColorStop(0, '#080510');
    grad.addColorStop(1, '#1d1429');
    ctx.fillStyle = grad;
    ctx.fillRect(arch.x - arch.r, top, arch.r * 2, arch.bottom - top);

    const sides = ctx.createLinearGradient(arch.x - arch.r, 0, arch.x + arch.r, 0);
    sides.addColorStop(0, 'rgba(0,0,0,0.55)');
    sides.addColorStop(0.5, 'rgba(0,0,0,0)');
    sides.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = sides;
    ctx.fillRect(arch.x - arch.r, top, arch.r * 2, arch.bottom - top);

    // La lumiere de la salle mord sur les premieres dalles du couloir.
    const sill = ctx.createLinearGradient(0, arch.bottom - 12, 0, arch.bottom);
    sill.addColorStop(0, 'rgba(150,110,205,0)');
    sill.addColorStop(1, 'rgba(150,110,205,0.28)');
    ctx.fillStyle = sill;
    ctx.fillRect(arch.x - arch.r, arch.bottom - 12, arch.r * 2, 12);

    ctx.imageSmoothingEnabled = false;
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(side * state.dx + shake * side, 0);
      // La demi-arche est decoupee APRES la translation : elle suit son battant.
      ctx.beginPath();
      if (side < 0) ctx.rect(arch.x - arch.r - 3, arch.y - arch.r - 3, arch.r + 4, arch.r * 2 + 6);
      else ctx.rect(arch.x, arch.y - arch.r - 3, arch.r + 4, arch.r * 2 + 6);
      ctx.clip();
      this.drawDoorLeaf(state.angle);
      ctx.restore();
    }
    ctx.imageSmoothingEnabled = true;
    ctx.restore();
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

  frame(players, items, selfId, now, doorElapsed = null) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.view.w, this.view.h);
    ctx.save();
    ctx.translate(-this.camera.x, -this.camera.y);

    this.drawGround();
    this.drawDoor(doorElapsed);   // sur le mur du haut : derriere le butin et les joueurs
    this.drawFlames(now);
    for (const item of items) this.drawItem(item, now);

    // Tri par Y : les joueurs plus bas passent devant.
    const sorted = [...players].sort((a, b) => a.y - b.y);
    for (const p of sorted) this.drawPlayer(p, p.id === selfId, now);

    // Les bulles passent apres tous les corps : aucune ne se fait recouvrir.
    for (const p of sorted) {
      if (!p.bubble) continue;
      const lift = (1 - (p.dropProgress ?? 1)) * 220;
      const head = p.y - lift - this.config.PLAYER.radius - (this.classes[p.classId] ? 32 : 20);
      this.drawBubble(p, head, now);
    }

    this.drawLights(now);
    if (this.debug) this.drawCollision();

    ctx.restore();
  }

  drawGround() {
    const ctx = this.ctx;
    const { width, height } = this.config.WORLD;

    ctx.fillStyle = '#453849';              // teinte du pourtour de la salle
    ctx.fillRect(0, 0, width, height);

    if (this.roomReady) {
      ctx.imageSmoothingEnabled = false;    // pixel art : aucun lissage
      ctx.drawImage(this.room, 0, 0, width, height);
      ctx.imageSmoothingEnabled = true;
    }
  }

  /**
   * Image de la boucle pour une flamme a cet instant.
   * Chaque feu a son propre decalage et sa propre cadence : ils vacillent
   * ensemble sans jamais tomber en phase.
   */
  flameFrame(flame, now) {
    const { frames, frameMs } = this.flameSprite;
    const step = Math.floor((now * flame.rate) / frameMs + flame.phase);
    return ((step % frames) + frames) % frames;
  }

  /** Les huit feux, dessines a meme le sol, derriere le butin et les joueurs. */
  drawFlames(now) {
    if (!this.flamesReady) return;
    const ctx = this.ctx;
    const { width: fw, height: fh } = this.flameSprite;

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    for (const flame of this.map.flames) {
      const frame = this.flameFrame(flame, now);
      const w = fw * flame.scale;
      const h = fh * flame.scale;
      // Ancrage sur le creux de la vasque : centre en x, base en y.
      ctx.drawImage(this.flames, frame * fw, 0, fw, fh,
                    Math.round(flame.x - w / 2), Math.round(flame.y - h), Math.round(w), Math.round(h));
    }
    ctx.restore();
  }

  /** Halos : ceux des flammes suivent l'image en cours, le sceau respire seul. */
  drawLights(now) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    const halo = (x, y, radius, color, strength) => {
      const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
      const inner = Math.round(Math.min(1, strength) * 68).toString(16).padStart(2, '0');
      const mid = Math.round(Math.min(1, strength) * 24).toString(16).padStart(2, '0');
      grad.addColorStop(0, `${color}${inner}`);
      grad.addColorStop(0.45, `${color}${mid}`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    };

    const levels = this.flameSprite.intensity;
    for (const flame of this.map.flames) {
      // Le halo est cale sur l'ampleur de l'image en cours : une grande langue
      // de feu eclaire plus loin qu'une braise basse, et la lumiere bat donc au
      // meme rythme que la flamme au lieu de suivre une sinusoide a part.
      const level = levels[this.flameFrame(flame, now)];
      halo(flame.x, flame.y - 12 * flame.scale, flame.glow * (0.7 + level * 0.35), flame.color, level);
    }

    // Halo de la grande porte : il monte avec le verrou et retombe a la fermeture.
    if (this.doorGlow > 0.02) {
      const d = this.door;
      halo(d.arch.x, d.arch.y, d.glow.r * (0.62 + 0.38 * this.doorGlow), d.glow.color, this.doorGlow * 0.95);
    }

    for (const light of this.map.lights) {
      const phase = light.x * 0.013 + light.y * 0.021;
      const pulse = 0.72 + Math.sin(now / 420 + phase) * 0.12 + Math.sin(now / 137 + phase) * 0.05;
      halo(light.x, light.y, light.r * pulse, light.color, 0.75);
    }

    ctx.restore();
  }

  /** F2 : grille de collision telle que le serveur la voit. */
  drawCollision() {
    const ctx = this.ctx;
    const { cell, cols, rows, grid } = this.map;
    const lines = this._gridLines || (this._gridLines = grid.split('\n'));

    const c0 = Math.max(0, Math.floor(this.camera.x / cell));
    const r0 = Math.max(0, Math.floor(this.camera.y / cell));
    const c1 = Math.min(cols, Math.ceil((this.camera.x + this.view.w) / cell));
    const r1 = Math.min(rows, Math.ceil((this.camera.y + this.view.h) / cell));

    ctx.fillStyle = 'rgba(248,113,113,0.32)';
    for (let row = r0; row < r1; row++) {
      const line = lines[row];
      for (let col = c0; col < c1; col++) {
        if (line.charCodeAt(col) === 49) ctx.fillRect(col * cell, row * cell, cell, cell);
      }
    }

    ctx.strokeStyle = 'rgba(56,189,248,0.5)';
    ctx.lineWidth = 2;
    const f = this.map.floor;
    ctx.strokeRect(f.x0, f.y0, f.x1 - f.x0, f.y1 - f.y0);
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

  /** Decoupe un texte en lignes qui tiennent dans `maxWidth`. */
  wrapText(text, maxWidth, maxLines) {
    const ctx = this.ctx;
    const words = String(text).split(' ');
    const lines = [];
    let line = '';

    for (const word of words) {
      const attempt = line ? `${line} ${word}` : word;
      if (ctx.measureText(attempt).width <= maxWidth || !line) {
        line = attempt;
      } else {
        lines.push(line);
        line = word;
        if (lines.length === maxLines) break;
      }
    }
    if (lines.length < maxLines && line) lines.push(line);

    // Texte trop long : on coupe proprement sur la derniere ligne.
    if (lines.length === maxLines) {
      let last = lines[maxLines - 1];
      if (ctx.measureText(last).width > maxWidth || words.join(' ').length > lines.join(' ').length) {
        while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
        if (words.join(' ').length > lines.join(' ').length) lines[maxLines - 1] = `${last}…`;
      }
    }
    return lines;
  }

  /** Phylactere arrondi avec sa petite pointe, centre au-dessus du personnage. */
  drawBubble(p, baseY, now) {
    const ctx = this.ctx;
    const { text, until, kind } = p.bubble;
    const remain = until - now;
    if (remain <= 0) return;

    const alpha = Math.min(1, remain / 450);   // fondu de sortie
    const padX = 9, padY = 6, lineH = 15, maxW = 210, radius = 8;

    ctx.save();
    ctx.font = `${kind === 'emote' ? 'italic ' : ''}600 12.5px Segoe UI, Roboto, Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    const lines = this.wrapText(text, maxW, 3);
    const w = Math.min(maxW, Math.max(...lines.map(l => ctx.measureText(l).width))) + padX * 2;
    const h = lines.length * lineH + padY * 2;
    const x = p.x - w / 2;
    const y = baseY - h - 8;

    ctx.globalAlpha = alpha;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, radius);
    else ctx.rect(x, y, w, h);
    ctx.fillStyle = 'rgba(12,18,30,0.92)';
    ctx.fill();
    ctx.strokeStyle = kind === 'emote' ? 'rgba(148,163,184,0.7)' : (p.color || '#94a3b8');
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Pointe vers le personnage
    ctx.beginPath();
    ctx.moveTo(p.x - 6, y + h - 1);
    ctx.lineTo(p.x, y + h + 8);
    ctx.lineTo(p.x + 6, y + h - 1);
    ctx.closePath();
    ctx.fillStyle = 'rgba(12,18,30,0.92)';
    ctx.fill();

    ctx.fillStyle = kind === 'emote' ? '#cbd5e1' : '#f1f5f9';
    lines.forEach((line, i) => ctx.fillText(line, p.x, y + padY + lineH * (i + 1) - 4));
    ctx.restore();
  }
}
