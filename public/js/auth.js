// Comptes cote client : appels API, jeton conserve en localStorage, reprise de session.
const TOKEN_KEY = 'dc.token';

export const Auth = {
  get token() {
    try { return localStorage.getItem(TOKEN_KEY); } catch (_) { return null; }
  },

  set token(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (_) { /* navigation privee : la session ne survivra pas au rechargement */ }
  },

  async post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Le serveur ne répond pas.');
    return data;
  },

  async register(username, password) {
    const data = await this.post('/api/register', { username, password });
    this.token = data.token;
    return data.profile;
  },

  async login(username, password) {
    const data = await this.post('/api/login', { username, password });
    this.token = data.token;
    return data.profile;
  },

  /** Verifie le jeton stocke. Renvoie le profil, ou null si la session est morte. */
  async resume() {
    const token = this.token;
    if (!token) return null;
    try {
      const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) { this.token = null; return null; }
      const data = await res.json();
      return data.profile;
    } catch (_) {
      return null;
    }
  },

  /** Catalogue des classes et de leurs artefacts (ecran de choix de classe). */
  async classes() {
    const res = await fetch('/api/classes');
    if (!res.ok) throw new Error('Catalogue des classes indisponible.');
    return res.json();
  },

  logout() {
    this.token = null;
  }
};
