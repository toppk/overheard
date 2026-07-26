import * as fs from 'node:fs';
import * as path from 'node:path';
import * as mediasoup from 'mediasoup';
import type { WebSocket } from 'ws';
import { config } from './config.js';
import { recordProducer, type TrackRecording } from './recorder.js';
import { isSealed } from './archives.js';

export interface Peer {
  id: string;
  name: string;
  ws: WebSocket;
  transports: Map<string, mediasoup.types.WebRtcTransport>;
  producers: Map<string, mediasoup.types.Producer>;
  consumers: Map<string, mediasoup.types.Consumer>;
  recordings: TrackRecording[];
  /** serverClock - clientClock, measured by the client at join. */
  clockOffsetMs?: number;
}

export interface RoomEvent {
  room_time_ms: number; // server receipt time, room-relative
  client_time_ms?: number; // client's claimed wallclock (client clock, raw)
  claim_server_ms?: number; // the claim translated onto the server clock
  participant_id: string;
  display_name: string;
  type: 'join' | 'leave' | 'mute' | 'unmute' | 'deafen' | 'undeafen';
}

export class Room {
  id: string;
  router: mediasoup.types.Router;
  peers = new Map<string, Peer>();
  startedAt = Date.now();
  finishedRecordings: TrackRecording[] = [];
  events: RoomEvent[] = [];
  // Leaves in progress: the peer is out of `peers` but their recording is
  // still finalizing. The room isn't empty until these drain, or a
  // same-moment double-leave seals the room before all tracks exist.
  private pendingLeaves = 0;
  private closed = false;

  constructor(id: string, router: mediasoup.types.Router) {
    this.id = id;
    this.router = router;
  }

  addPeer(id: string, name: string, ws: WebSocket): Peer {
    const peer: Peer = {
      id,
      name,
      ws,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
      recordings: [],
    };
    this.peers.set(id, peer);
    this.addEvent(peer, 'join');
    return peer;
  }

  addEvent(peer: Peer, type: RoomEvent['type'], clientTimeMs?: number): void {
    this.events.push({
      room_time_ms: Date.now() - this.startedAt,
      ...(clientTimeMs !== undefined && { client_time_ms: clientTimeMs }),
      ...(clientTimeMs !== undefined &&
        peer.clockOffsetMs !== undefined && {
          claim_server_ms: Math.round(clientTimeMs + peer.clockOffsetMs),
        }),
      participant_id: peer.id,
      display_name: peer.name,
      type,
    });
  }

  async createWebRtcTransport(peer: Peer): Promise<mediasoup.types.WebRtcTransport> {
    const transport = await this.router.createWebRtcTransport({
      listenIps: config.announcedIps.map((announcedIp) => ({ ip: '0.0.0.0' as const, announcedIp })),
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
    });
    // Media-path diagnostics: these are what distinguish "client connected
    // but sent no audio" from "media never got through at all".
    transport.on('icestatechange', (state) =>
      console.log(`[transport ${peer.name}/${transport.id.slice(0, 8)}] ice: ${state}`),
    );
    transport.on('dtlsstatechange', (state) =>
      console.log(`[transport ${peer.name}/${transport.id.slice(0, 8)}] dtls: ${state}`),
    );
    peer.transports.set(transport.id, transport);
    return transport;
  }

  async startRecording(peer: Peer, producer: mediasoup.types.Producer): Promise<void> {
    try {
      const rec = await recordProducer({
        router: this.router,
        producer,
        roomId: this.id,
        roomStartedAt: this.startedAt,
        participantId: peer.id,
        displayName: peer.name,
      });
      peer.recordings.push(rec);
      producer.on('transportclose', () => void rec.stop());
    } catch (err) {
      // A recording failure must not interrupt the call.
      console.error(`[rec] failed to record producer for ${peer.name}:`, err);
    }
  }

  async removePeer(peerId: string): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.pendingLeaves++;
    try {
      this.addEvent(peer, 'leave');
      this.peers.delete(peerId);
      for (const rec of peer.recordings) {
        await rec.stop();
        this.finishedRecordings.push(rec);
      }
      for (const transport of peer.transports.values()) transport.close();
    } finally {
      this.pendingLeaves--;
    }
  }

  broadcast(exceptPeerId: string | null, msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const peer of this.peers.values()) {
      if (peer.id === exceptPeerId) continue;
      if (peer.ws.readyState === peer.ws.OPEN) peer.ws.send(data);
    }
  }

  get isEmpty(): boolean {
    return this.peers.size === 0 && this.pendingLeaves === 0;
  }

  // Writing metadata.json is what seals a room forever — it is written for
  // every room that ends, even one where nothing was recorded.
  writeMetadata(): void {
    const dir = path.join(config.recordingsDir, this.id);
    fs.mkdirSync(dir, { recursive: true });
    const metadata = {
      room_id: this.id,
      started_at: new Date(this.startedAt).toISOString(),
      ended_at: new Date().toISOString(),
      tracks: this.finishedRecordings.map((rec) => ({
        participant_id: rec.participantId,
        display_name: rec.displayName,
        file: rec.file,
        room_time_start_ms: rec.roomTimeStartMs,
        room_time_end_ms: rec.roomTimeEndMs ?? null,
        ...(rec.rtp && { rtp: rec.rtp }),
      })),
      // Non-speech events on the same room timeline. mute/unmute are client
      // CLAIMS (stamped on receipt; client_time_ms is what the client says).
      events: this.events,
    };
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2));
    console.log(`[room ${this.id}] wrote metadata for ${metadata.tracks.length} track(s)`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.writeMetadata();
    this.router.close();
  }
}

export class RoomManager {
  private worker!: mediasoup.types.Worker;
  private rooms = new Map<string, Room>();

  async init(): Promise<void> {
    this.worker = await mediasoup.createWorker({
      rtcMinPort: config.rtcMinPort,
      rtcMaxPort: config.rtcMaxPort,
    });
    this.worker.on('died', () => {
      console.error('mediasoup worker died, exiting');
      process.exit(1);
    });
  }

  listLive(): { roomId: string; participants: string[]; startedAt: number }[] {
    return [...this.rooms.values()].map((room) => ({
      roomId: room.id,
      participants: [...room.peers.values()].map((p) => p.name),
      startedAt: room.startedAt,
    }));
  }

  isActive(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  async getOrCreateRoom(roomId: string): Promise<Room> {
    let room = this.rooms.get(roomId);
    if (!room && isSealed(roomId)) {
      throw new Error('sealed');
    }
    if (!room) {
      const router = await this.worker.createRouter({ mediaCodecs: config.mediaCodecs });
      room = new Room(roomId, router);
      this.rooms.set(roomId, room);
      console.log(`[room ${roomId}] created`);
    }
    return room;
  }

  async closeRoomIfEmpty(room: Room): Promise<boolean> {
    if (!room.isEmpty || !this.rooms.has(room.id)) return false;
    this.rooms.delete(room.id);
    room.close();
    console.log(`[room ${room.id}] closed`);
    return true;
  }
}
