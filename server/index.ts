import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { config } from './config.js';
import { RoomManager, type Peer, type Room } from './room.js';
import { Lobby } from './lobby.js';
import { generateRoomName } from './roomNames.js';
import { isSealed, readMetadata } from './archives.js';
import { transcribeRoom, transcriptionStatus } from './transcriber.js';
import {
  initDb,
  upsertArchive,
  getRecentCached,
  queryArchives,
  participantFacets,
} from './db.js';

const roomManager = new RoomManager();
const lobby = new Lobby(() => {
  const recent = getRecentCached();
  return {
    rooms: roomManager.listLive(),
    archives: recent.archives,
    archiveTotal: recent.total,
  };
});

const app = express();
const webDist = path.resolve('web/dist');
// Without this, browsers heuristically cache pages/bundles and users bounce
// between stale and fresh builds ("glitchy" navigation). Everything must
// revalidate; it's all served off local disk anyway.
app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache');
  next();
});
app.use(express.static(webDist));
// Everyone is a superuser: all recordings and transcripts are public.
app.use('/recordings', express.static(path.resolve(config.recordingsDir)));

// Astro builds /chat and /archive as static pages; ids live in the URL path.
app.get('/chat/:room', (_req, res) => res.sendFile(path.join(webDist, 'chat/index.html')));
app.get('/storage', (_req, res) => res.sendFile(path.join(webDist, 'storage/index.html')));

function conversationPath(roomId: string): string {
  return path.join(config.recordingsDir, roomId, 'transcripts', 'conversation.md');
}

// The transcript as plain markdown — the one-URL door for agents.
app.get(/^\/archive\/([a-zA-Z0-9_-]+)\.md$/, (req, res) => {
  const roomId = req.params[0];
  const p = conversationPath(roomId);
  if (fs.existsSync(p)) return res.type('text/markdown').send(fs.readFileSync(p, 'utf8'));
  if (readMetadata(roomId)) {
    return res
      .status(404)
      .type('text/plain')
      .send(`no transcript yet (status: ${transcriptionStatus(roomId)})`);
  }
  res.status(404).type('text/plain').send('no such archive');
});

// The human URL is universal: proper q-ranked content negotiation (a client
// preferring markdown gets markdown), and the HTML branch server-renders
// the transcript into the shell so browser-like fetchers (WebFetch) that
// genuinely prefer HTML still receive real content, JS or not. The client
// app hydrates over the server-rendered block.
const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function archiveHtml(roomId: string): string {
  const html = fs.readFileSync(path.join(webDist, 'archive/index.html'), 'utf8');
  const p = conversationPath(roomId);
  if (!fs.existsSync(p)) return html;
  const ssr =
    `<article id="ssr-transcript"><pre class="transcript">${escapeHtml(fs.readFileSync(p, 'utf8'))}</pre>` +
    `<p><a href="/archive/${roomId}.md">transcript (markdown)</a> ` +
    `<a href="/recordings/${roomId}/transcripts/canonical.json">structured dump (json)</a></p></article>`;
  const placeholder = '<p class="narrative">reading cold storage…</p>';
  if (!html.includes(placeholder)) {
    console.warn('[archive] SSR placeholder missing from built page; serving shell');
    return html;
  }
  return html.replace(placeholder, ssr);
}

app.get('/archive/:room', (req, res) => {
  const roomId = req.params.room.replace(/[^a-zA-Z0-9_-]/g, '');
  const best = req.accepts(['text/markdown', 'text/html', 'application/json']);
  if (best === 'text/markdown') {
    const p = conversationPath(roomId);
    if (fs.existsSync(p)) return res.type('text/markdown').send(fs.readFileSync(p, 'utf8'));
  }
  if (best === 'application/json') {
    const meta = readMetadata(roomId);
    if (!meta) return res.status(404).json({ error: 'no such archive' });
    const p = conversationPath(roomId);
    return res.json({
      metadata: meta,
      transcript: transcriptionStatus(roomId),
      conversation: fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null,
    });
  }
  res.type('text/html').send(archiveHtml(roomId));
});

// Machine-readable front door for agents.
app.get('/llms.txt', (_req, res) => {
  res.type('text/plain').send(`# overheard

Self-hosted voice rooms with per-speaker recording and honest post-meeting
transcripts. Every finished conversation ("archive") is public on this
instance. Terminology: rooms are "constructs"; a finished room is
"flatlined"/sealed (permanent); transcription is "wintermute".

## Get a transcript (start here)
- GET /archive/{room-id}.md          — transcript as plain markdown
- GET /archive/{room-id}             — same, via content negotiation
                                       (non-HTML Accept gets markdown)
- GET /api/archives/{room-id}        — JSON: { metadata, transcript,
                                       conversation } where metadata has
                                       tracks[] and events[] (join/leave/
                                       mute/unmute/deafen, room-relative ms)

## Find conversations
- GET /api/archives                  — list archives (newest first);
                                       params: q (full-text search over
                                       transcripts), handles (comma-sep,
                                       must all be present),
                                       since (ABSOLUTE: epoch ms or ISO
                                       8601 — sealed at/after that
                                       instant; use this to poll for new
                                       meetings), sinceMs (RELATIVE:
                                       sealed within the last N ms),
                                       minDurMs, maxDurMs, offset, limit.
                                       Returns { total, rows }; total is
                                       matched count, rows is the page.
- GET /api/storage/facets            — participant handles with room counts

## Raw audio
- GET /recordings/{room-id}/{track-file}  — per-speaker Ogg/Opus; track
                                            paths are in metadata.tracks[]

## Notes for agents
- transcript status values: none | running | done | failed. Poll
  /api/archives until done after a room ends (~seconds to minutes).
- participant_id values are PER-ROOM, not stable identities. Display
  names/aliases are self-claimed. There is no identity system yet.
- Transcript format: "**name**" speaker headers, "(mm:ss) text" utterances,
  "*[ name action — mm:ss ]*" stage directions, "*[overlapping]*" marks
  genuine simultaneous speech.
- Timestamps are room-relative; absolute start is metadata.started_at (UTC).
`);
});

// Cold-storage browser + agent list endpoint: filters + FTS over transcripts.
const storageHandler = async (req: express.Request, res: express.Response) => {
  const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : undefined;
  const handles = typeof req.query.handles === 'string' && req.query.handles
    ? req.query.handles.split(',').filter(Boolean)
    : undefined;
  const num = (v: unknown) => (typeof v === 'string' && v !== '' ? Number(v) : undefined);
  // `since` is absolute: epoch ms or anything Date.parse understands.
  let sinceEpochMs: number | undefined;
  if (typeof req.query.since === 'string' && req.query.since !== '') {
    const asNum = Number(req.query.since);
    sinceEpochMs = Number.isFinite(asNum) ? asNum : Date.parse(req.query.since);
    if (!Number.isFinite(sinceEpochMs)) {
      return res.status(400).json({ error: 'since must be epoch ms or an ISO 8601 date' });
    }
  }
  try {
    const result = await queryArchives({
      q,
      handles,
      sinceMs: num(req.query.sinceMs),
      sinceEpochMs,
      minDurMs: num(req.query.minDurMs),
      maxDurMs: num(req.query.maxDurMs),
      offset: num(req.query.offset),
      limit: num(req.query.limit),
    });
    res.json(result);
  } catch (err) {
    console.error('[api/storage] query failed:', err);
    res.status(500).json({ error: 'query failed' });
  }
};
app.get('/api/storage', storageHandler);
app.get('/api/archives', storageHandler);

app.get('/api/storage/facets', async (_req, res) => {
  res.json({ handles: await participantFacets() });
});

app.get('/api/dig', (_req, res) => {
  const roomId = generateRoomName((name) => roomManager.isActive(name) || isSealed(name));
  res.json({ roomId });
});

app.get('/api/archives/:room', (req, res) => {
  const roomId = req.params.room.replace(/[^a-zA-Z0-9_-]/g, '');
  const meta = readMetadata(roomId);
  if (!meta) return res.status(404).json({ error: 'no such archive' });
  const transcriptPath = path.join(config.recordingsDir, roomId, 'transcripts', 'conversation.md');
  res.json({
    metadata: meta,
    transcript: transcriptionStatus(roomId),
    conversation: fs.existsSync(transcriptPath) ? fs.readFileSync(transcriptPath, 'utf8') : null,
  });
});

// (Re)summon the scribe for a sealed room — e.g. rooms recorded before
// auto-transcription existed, or after a failure.
app.post('/api/archives/:room/transcribe', (req, res) => {
  const roomId = req.params.room.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!readMetadata(roomId)) return res.status(404).json({ error: 'no such archive' });
  const started = startScribe(roomId);
  res.json({ started, status: transcriptionStatus(roomId) });
});

function startScribe(roomId: string): boolean {
  const started = transcribeRoom(roomId, (status) => {
    void upsertArchive(roomId).then(() => lobby.broadcastState());
    lobby.announce(
      status === 'done'
        ? `wintermute commits the transcript of ${roomId} to cold storage.`
        : `wintermute chokes on ${roomId}. (transcription failed)`,
    );
  });
  if (started) lobby.announce(`wintermute wakes to parse ${roomId}.`);
  return started;
}

// Use HTTPS when certs exist (required for mic access from non-localhost,
// e.g. iPad Safari on the LAN). Generate with scripts/gen-certs.sh.
let server: http.Server | https.Server;
const certFile = 'certs/cert.pem';
const keyFile = 'certs/key.pem';
if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
  server = https.createServer(
    { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) },
    app,
  );
  console.log('using HTTPS (certs/ found)');
} else {
  server = http.createServer(app);
  console.log('using HTTP (no certs/ found; mic only works on localhost)');
}

const wss = new WebSocketServer({ server, path: '/ws' });

interface SessionState {
  room: Room | null;
  peer: Peer | null;
  inLobby: boolean;
}

wss.on('connection', (ws: WebSocket) => {
  const state: SessionState = { room: null, peer: null, inLobby: false };

  ws.on('message', async (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      const result = await handleRequest(ws, state, msg);
      ws.send(JSON.stringify({ type: 'response', requestId: msg.requestId, data: result ?? {} }));
    } catch (err: any) {
      const message = String(err?.message ?? err);
      if (message !== 'sealed') console.error(`[ws] error handling ${msg.type}:`, err);
      ws.send(JSON.stringify({ type: 'response', requestId: msg.requestId, error: message }));
    }
  });

  ws.on('close', () => {
    if (state.inLobby) lobby.leave(ws);
    void leaveRoom(state);
  });
});

async function leaveRoom(state: SessionState): Promise<void> {
  const { room, peer } = state;
  if (!room || !peer) return;
  state.room = null;
  state.peer = null;
  await room.removePeer(peer.id);
  room.broadcast(null, { type: 'peerLeft', peerId: peer.id, name: peer.name });
  console.log(`[room ${room.id}] ${peer.name} left (${room.peers.size} remaining)`);
  const sealed = await roomManager.closeRoomIfEmpty(room);
  if (sealed) {
    await upsertArchive(room.id);
    lobby.announce(`The last channel closes; construct ${room.id} flatlines into cold storage.`);
    if (room.finishedRecordings.length > 0) startScribe(room.id);
  } else {
    lobby.announce(`${peer.name} drops the line from ${room.id}.`);
  }
}

async function handleRequest(ws: WebSocket, state: SessionState, msg: any): Promise<unknown> {
  switch (msg.type) {
    case 'lobby.join': {
      const name = String(msg.name ?? 'a stranger').slice(0, 64);
      state.inLobby = true;
      lobby.join(ws, name);
      return lobby.state();
    }

    case 'join': {
      const roomId = String(msg.roomId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
      if (!roomId) throw new Error('invalid room id');
      const name = String(msg.name ?? 'anonymous').slice(0, 64);
      const existed = roomManager.isActive(roomId);
      const room = await roomManager.getOrCreateRoom(roomId); // throws 'sealed'
      const peer = room.addPeer(randomUUID().slice(0, 8), name, ws);
      state.room = room;
      state.peer = peer;
      console.log(`[room ${room.id}] ${name} joined as ${peer.id}`);
      room.broadcast(peer.id, { type: 'peerJoined', peerId: peer.id, name });
      lobby.announce(
        existed
          ? `${name} patches into ${room.id}.`
          : `${name} spins up a construct: ${room.id}.`,
      );
      return {
        peerId: peer.id,
        audio: config.audio,
        routerRtpCapabilities: room.router.rtpCapabilities,
        peers: [...room.peers.values()]
          .filter((p) => p.id !== peer.id)
          .map((p) => ({
            peerId: p.id,
            name: p.name,
            producerIds: [...p.producers.keys()],
          })),
      };
    }

    case 'createTransport': {
      const { room, peer } = requireJoined(state);
      const transport = await room.createWebRtcTransport(peer);
      return {
        transportId: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      };
    }

    case 'connectTransport': {
      const { peer } = requireJoined(state);
      const transport = peer.transports.get(msg.transportId);
      if (!transport) throw new Error('unknown transport');
      await transport.connect({ dtlsParameters: msg.dtlsParameters });
      return {};
    }

    case 'produce': {
      const { room, peer } = requireJoined(state);
      const transport = peer.transports.get(msg.transportId);
      if (!transport) throw new Error('unknown transport');
      const producer = await transport.produce({
        kind: msg.kind,
        rtpParameters: msg.rtpParameters,
      });
      peer.producers.set(producer.id, producer);
      room.broadcast(peer.id, {
        type: 'newProducer',
        peerId: peer.id,
        name: peer.name,
        producerId: producer.id,
      });
      // Per-speaker recording: every producer gets its own local file.
      await room.startRecording(peer, producer);
      return { producerId: producer.id };
    }

    case 'consume': {
      const { room, peer } = requireJoined(state);
      if (!room.router.canConsume({ producerId: msg.producerId, rtpCapabilities: msg.rtpCapabilities })) {
        throw new Error('cannot consume');
      }
      const transport = peer.transports.get(msg.transportId);
      if (!transport) throw new Error('unknown transport');
      const consumer = await transport.consume({
        producerId: msg.producerId,
        rtpCapabilities: msg.rtpCapabilities,
        paused: true,
      });
      peer.consumers.set(consumer.id, consumer);
      return {
        consumerId: consumer.id,
        producerId: msg.producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      };
    }

    case 'clockPing': {
      return { serverTime: Date.now() };
    }

    case 'clockOffset': {
      const { peer } = requireJoined(state);
      const offset = Number(msg.offsetMs);
      if (Number.isFinite(offset) && Math.abs(offset) < 24 * 3600 * 1000) {
        peer.clockOffsetMs = offset;
        console.log(`[room] ${peer.name} clock offset ${offset.toFixed(0)}ms (rtt ${msg.rttMs}ms)`);
      }
      return {};
    }

    case 'muteState': {
      const { room, peer } = requireJoined(state);
      room.addEvent(peer, msg.muted ? 'mute' : 'unmute', Number(msg.clientTimeMs) || undefined);
      return {};
    }

    case 'deafenState': {
      const { room, peer } = requireJoined(state);
      room.addEvent(peer, msg.deafened ? 'deafen' : 'undeafen', Number(msg.clientTimeMs) || undefined);
      return {};
    }

    case 'resumeConsumer': {
      const { peer } = requireJoined(state);
      const consumer = peer.consumers.get(msg.consumerId);
      if (!consumer) throw new Error('unknown consumer');
      await consumer.resume();
      return {};
    }

    case 'leave': {
      await leaveRoom(state);
      return {};
    }

    default:
      throw new Error(`unknown request type: ${msg.type}`);
  }
}

function requireJoined(state: SessionState): { room: Room; peer: Peer } {
  if (!state.room || !state.peer) throw new Error('not joined');
  return { room: state.room, peer: state.peer };
}

await roomManager.init();
await initDb();
server.listen(config.httpPort, () => {
  const proto = server instanceof https.Server ? 'https' : 'http';
  console.log(`overheard listening on ${proto}://localhost:${config.httpPort}`);
  console.log(`announced IPs for WebRTC: ${config.announcedIps.join(', ')}`);
});
