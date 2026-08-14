const fs = require('fs');
const path = require('path');

/**
 * Stockage JSON sur disque, ecriture atomique et differee.
 *
 * Suffisant pour quelques dizaines de comptes. Pour passer a une vraie base
 * (Postgres, SQLite, Redis), il suffit de reimplementer load/save/get/set :
 * le reste du serveur ne connait que cette interface.
 */
class Store {
  constructor(file, fallback = {}) {
    this.file = file;
    this.tmp = `${file}.tmp`;
    this.data = fallback;
    this.dirty = false;
    this.writing = false;
    this.load();
  }

  load() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (fs.existsSync(this.file)) {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      }
    } catch (err) {
      // Fichier corrompu : on le met de cote plutot que d'ecraser silencieusement.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try { fs.renameSync(this.file, backup); } catch (_) {}
      console.error(`[store] lecture impossible, fichier deplace vers ${backup}`, err.message);
    }
    return this.data;
  }

  /** Marque les donnees comme modifiees ; l'ecriture reelle est groupee. */
  touch() {
    this.dirty = true;
  }

  flush() {
    if (!this.dirty || this.writing) return;
    this.writing = true;
    this.dirty = false;
    try {
      fs.writeFileSync(this.tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(this.tmp, this.file); // remplacement atomique
    } catch (err) {
      console.error('[store] ecriture impossible', err.message);
      this.dirty = true;
    } finally {
      this.writing = false;
    }
  }

  /** Ecriture groupee toutes les `ms`, plus un flush a l'arret du process. */
  autoFlush(ms = 2000) {
    this.timer = setInterval(() => this.flush(), ms);
    if (this.timer.unref) this.timer.unref();
    const onExit = () => { this.flush(); process.exit(0); };
    process.on('SIGINT', onExit);
    process.on('SIGTERM', onExit);
    process.on('beforeExit', () => this.flush());
    return this;
  }
}

module.exports = Store;
