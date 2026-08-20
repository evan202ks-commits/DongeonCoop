// Entrees : clavier (ZQSD / WASD / fleches) + joystick tactile flottant.
export class Input {
  constructor() {
    this.keys = new Set();
    this.touchVec = { x: 0, y: 0 };
    this.touchId = null;
    this.origin = { x: 0, y: 0 };

    this.stickWrap = document.getElementById('touch');
    this.stick = this.stickWrap.querySelector('.stick');
    this.knob = this.stickWrap.querySelector('.knob');

    // Taper "z" dans le chat (ou dans le formulaire de connexion) ne doit pas
    // faire courir le personnage : tant qu'un champ a le focus, on ignore tout.
    const typing = (e) => {
      const t = e.target;
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    };

    window.addEventListener('keydown', (e) => {
      if (typing(e)) { this.keys.clear(); return; }
      this.keys.add(e.key.toLowerCase());
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(e.key.toLowerCase())) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    document.addEventListener('focusin', (e) => { if (typing(e)) this.keys.clear(); });
    window.addEventListener('blur', () => this.keys.clear());

    if (matchMedia('(pointer:coarse)').matches) this.enableTouch();
  }

  enableTouch() {
    this.stickWrap.classList.add('on');
    const RADIUS = 55;

    this.stickWrap.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      this.touchId = t.identifier;
      this.origin = { x: t.clientX, y: t.clientY };
      this.stick.hidden = false;
      this.stick.style.left = `${t.clientX - 60}px`;
      this.stick.style.top = `${t.clientY - 60}px`;
      this.knob.style.left = '35px';
      this.knob.style.top = '35px';
      e.preventDefault();
    }, { passive: false });

    this.stickWrap.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== this.touchId) continue;
        let dx = t.clientX - this.origin.x;
        let dy = t.clientY - this.origin.y;
        const dist = Math.hypot(dx, dy);
        if (dist > RADIUS) { dx = (dx / dist) * RADIUS; dy = (dy / dist) * RADIUS; }
        this.touchVec = { x: dx / RADIUS, y: dy / RADIUS };
        this.knob.style.left = `${35 + dx}px`;
        this.knob.style.top = `${35 + dy}px`;
      }
      e.preventDefault();
    }, { passive: false });

    const end = () => {
      this.touchId = null;
      this.touchVec = { x: 0, y: 0 };
      this.stick.hidden = true;
    };
    this.stickWrap.addEventListener('touchend', end);
    this.stickWrap.addEventListener('touchcancel', end);
  }

  /** Axe de deplacement normalise, -1..1 sur chaque composante. */
  axis() {
    let x = 0, y = 0;
    const k = this.keys;
    if (k.has('arrowup') || k.has('z') || k.has('w')) y -= 1;
    if (k.has('arrowdown') || k.has('s')) y += 1;
    if (k.has('arrowleft') || k.has('q') || k.has('a')) x -= 1;
    if (k.has('arrowright') || k.has('d')) x += 1;

    if (Math.abs(this.touchVec.x) > 0.15 || Math.abs(this.touchVec.y) > 0.15) {
      x = this.touchVec.x;
      y = this.touchVec.y;
    }

    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    return { x, y };
  }
}
