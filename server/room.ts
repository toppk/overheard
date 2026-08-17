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
  /** The client told us it was being backgrounded (screen lock, app switch)
   *  on its way out. Reported so the lobby stops claiming they are on
   *  channel during the ~12s it takes TCP to notice a locked device. */
  away?: boolean;
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
    // A track that captured zero RTP is a bare ogg header, not a recording.
    // Listing it made the archive claim "N taped channel(s)" and render a
    // player for silence, and made transcribe.py load a whisper model only
    // to die with EOFError. The participant is not erased — their join and
    // leave are still in events[]; there is simply no tape of them.
    const taped = this.finishedRecordings.filter((rec) => rec.capturedMedia);
    const untaped = this.finishedRecordings.length - taped.length;
    const metadata = {
      room_id: this.id,
      started_at: new Date(this.startedAt).toISOString(),
      ended_at: new Date().toISOString(),
      tracks: taped.map((rec) => ({
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
    console.log(
      `[room ${this.id}] wrote metadata for ${metadata.tracks.length} track(s)` +
        (untaped ? ` (${untaped} excluded: no media captured)` : ''),
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.writeMetadata();
    this.router.close();
  }
}

/** How long a room stays alive after its last peer disappears.
 *
 *  Sealing is permanent, so doing it the instant a socket drops means a
 *  screen lock, a tunnel, or one bad moment ends the meeting for good.
 *  Observed on iPadOS (ken, 2026-08-07): locking the screen suspended the
 *  page, the websocket died ~10s later, and the construct flatlined into
 *  cold storage while its only participant was still holding the device —
 *  unlocking left nothing to rejoin.
 *
 *  Deliberately short (ken, 2026-08-07): long enough to survive a lock or a
 *  dropped socket, short enough that an abandoned construct doesn't sit in
 *  the hot list pretending to be a meeting. The client reconnects on its
 *  own now, so this window only has to outlast that ladder (~15s worst
 *  case), not a human noticing and tapping. */
const EMPTY_ROOM_LINGER_MS = Number(process.env.ROOM_LINGER_MS ?? 30_000);

export class RoomManager {
  private worker!: mediasoup.types.Worker;
  private rooms = new Map<string, Room>();
  private lingerTimers = new Map<string, { timer: NodeJS.Timeout; sealsAt: number }>();
  private sealedHandler: ((room: Room) => void) | null = null;

  /** Sealing is now deferred, so the caller can't learn about it from a
   *  return value — it happens here instead. */
  onSealed(handler: (room: Room) => void): void {
    this.sealedHandler = handler;
  }

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

  listLive(): {
    roomId: string;
    participants: string[];
    startedAt: number;
    /** Epoch ms at which an empty-but-held room seals, else null. Lets the
     *  lobby say "empty, flatlines in ~Ns" instead of claiming someone is
     *  still on channel when the participant list has gone empty. */
    sealsAt: number | null;
    /** True between "the last peer vanished" and "their tape is closed and
     *  the hold has started". A leaver is removed from `peers` immediately
     *  but their recording can take seconds to finalize (ffmpeg's exit, up
     *  to the SIGKILL backstop), and the same socket death broadcasts lobby
     *  state right inside that gap. Without this the lobby saw empty
     *  participants with no deadline yet and rendered "flatlines in ~0s" —
     *  a countdown that had not started, which then jumped back up to the
     *  full window a moment later. */
    finalizing: boolean;
    /** Subset of participants whose device told us it was backgrounded. */
    away: string[];
  }[] {
    return [...this.rooms.values()].map((room) => ({
      roomId: room.id,
      participants: [...room.peers.values()].map((p) => p.name),
      away: [...room.peers.values()].filter((p) => p.away).map((p) => p.name),
      startedAt: room.startedAt,
      sealsAt: this.lingerTimers.get(room.id)?.sealsAt ?? null,
      finalizing: room.peers.size === 0 && !this.lingerTimers.has(room.id),
    }));
  }

  isActive(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  async getOrCreateRoom(roomId: string): Promise<Room> {
    let room = this.rooms.get(roomId);
    // Someone came back inside the linger window: cancel the pending seal
    // and let them straight back into the same construct.
    const pending = this.lingerTimers.get(roomId);
    if (pending) {
      clearTimeout(pending.timer);
      this.lingerTimers.delete(roomId);
      console.log(`[room ${roomId}] rejoined while empty — hold released, not sealing`);
    }
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

  /** Called when a peer leaves. Returns true if that emptied the room and it
   *  is now being held open; the actual seal fires later via onSealed(). */
  holdOpenIfEmpty(room: Room): boolean {
    if (!room.isEmpty || !this.rooms.has(room.id)) return false;
    if (this.lingerTimers.has(room.id)) return true;
    // NOTHING is written to disk during the hold. `isSealed()` is defined as
    // "metadata.json exists", so writing it early would mark the room sealed
    // forever while it is still hot and rejoinable — the two states must not
    // overlap. The tracks are already on disk (recordings stop on leave); a
    // crash inside this window loses only the metadata, and the window is
    // seconds.
    const sealsAt = Date.now() + EMPTY_ROOM_LINGER_MS;
    const timer = setTimeout(() => {
      this.lingerTimers.delete(room.id);
      if (!room.isEmpty || !this.rooms.has(room.id)) return;
      this.rooms.delete(room.id);
      room.close();
      console.log(`[room ${room.id}] closed`);
      this.sealedHandler?.(room);
    }, EMPTY_ROOM_LINGER_MS);
    this.lingerTimers.set(room.id, { timer, sealsAt });
    console.log(
      `[room ${room.id}] empty — holding the channel open for ${Math.round(EMPTY_ROOM_LINGER_MS / 1000)}s before sealing`,
    );
    return true;
  }
}
