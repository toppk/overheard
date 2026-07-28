import type { WebSocket } from 'ws';

interface LobbyEvent {
  ts: number;
  text: string;
}

/**
 * The grid: everyone who has the site open is present here, sees everyone
 * else, every hot construct, and everything in cold storage. Everyone is a
 * superuser.
 */
export class Lobby {
  private users = new Map<WebSocket, { name: string }>();
  private events: LobbyEvent[] = [];
  private getStateExtras: () => { rooms: unknown; archives: unknown; archiveTotal: number };

  constructor(getStateExtras: () => { rooms: unknown; archives: unknown; archiveTotal: number }) {
    this.getStateExtras = getStateExtras;
  }

  join(ws: WebSocket, name: string): void {
    this.users.set(ws, { name });
    this.announce(`${name} jacks into the grid.`);
  }

  leave(ws: WebSocket): void {
    const user = this.users.get(ws);
    if (!user) return;
    this.users.delete(ws);
    this.announce(`${user.name}'s connection drops.`);
  }

  announce(text: string): void {
    this.events.push({ ts: Date.now(), text });
    if (this.events.length > 50) this.events.splice(0, this.events.length - 50);
    console.log(`[grid] ${text}`);
    this.broadcastState();
  }

  state(): unknown {
    const extras = this.getStateExtras();
    return {
      type: 'lobby.state',
      users: [...this.users.values()].map((u) => u.name),
      rooms: extras.rooms,
      archives: extras.archives,
      archiveTotal: extras.archiveTotal,
      events: this.events.slice(-30),
    };
  }

  broadcastState(): void {
    const data = JSON.stringify(this.state());
    for (const ws of this.users.keys()) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }
}
