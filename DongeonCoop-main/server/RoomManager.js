const { Room } = require('./Room');

/** Place les joueurs dans la premiere salle non pleine, en cree une sinon. */
class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.seq = 0;
  }

  createRoom() {
    const id = `terrain-${++this.seq}`;
    const room = new Room(id);
    this.rooms.set(id, room);
    return room;
  }

  findAvailable() {
    for (const room of this.rooms.values()) {
      if (!room.isFull()) return room;
    }
    return this.createRoom();
  }

  get(id) {
    return this.rooms.get(id);
  }

  /** Supprime une salle vide, sauf si c'est la derniere. */
  cleanup(id) {
    const room = this.rooms.get(id);
    if (room && room.count === 0 && this.rooms.size > 1) {
      this.rooms.delete(id);
    }
  }

  get all() {
    return [...this.rooms.values()];
  }
}

module.exports = RoomManager;
