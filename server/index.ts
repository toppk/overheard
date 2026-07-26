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
import { isSealed, listArchives, readMetadata } from './archives.js';
import { transcribeRoom, transcriptionStatus } from './transcriber.js';

const roomManager = new RoomManager();
const lobby = new Lobby(() => ({
  rooms: roomManager.listLive(),
  archives: listArchives(),
}));

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
app.get('/archive/:room', (_req, res) => res.sendFile(path.join(webDist, 'archive/index.html')));

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
  if (room.isEmpty) {
    await roomManager.closeRoomIfEmpty(room);
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
server.listen(config.httpPort, () => {
  const proto = server instanceof https.Server ? 'https' : 'http';
  console.log(`overheard listening on ${proto}://localhost:${config.httpPort}`);
  console.log(`announced IP for WebRTC: ${config.announcedIp}`);
});
