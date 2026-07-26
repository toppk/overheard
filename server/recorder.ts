import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as mediasoup from 'mediasoup';
import { config } from './config.js';

// Simple pool of even UDP ports for RTP listeners (rtcp = rtp + 1).
let nextPort = config.recordRtpPortStart;
function allocPortPair(): number {
  const port = nextPort;
  nextPort += 2;
  return port;
}

export interface TrackRecording {
  participantId: string;
  displayName: string;
  file: string;
  roomTimeStartMs: number;
  roomTimeEndMs?: number;
  stop: () => Promise<void>;
}

/**
 * Records a single audio producer to an Ogg/Opus file on local disk.
 * mediasoup sends the producer's RTP over a PlainTransport to a local UDP
 * port where ffmpeg listens (driven by a generated SDP file).
 *
 * ffmpeg's UDP shutdown is inherently racy (SIGINT vs blocked read vs
 * rw_timeout), so we don't depend on it: -flush_packets keeps every
 * finished ogg page on disk continuously, making the file valid no matter
 * how ffmpeg dies — a missing EOS page only drops the last <=1s of audio.
 */
export async function recordProducer(opts: {
  router: mediasoup.types.Router;
  producer: mediasoup.types.Producer;
  roomId: string;
  roomStartedAt: number;
  participantId: string;
  displayName: string;
}): Promise<TrackRecording> {
  const { router, producer, roomId, roomStartedAt, participantId, displayName } = opts;

  const dir = path.join(config.recordingsDir, roomId, 'tracks');
  fs.mkdirSync(dir, { recursive: true });

  const rtpPort = allocPortPair();
  const roomTimeStartMs = Date.now() - roomStartedAt;
  const base = `${participantId}-${roomTimeStartMs}`;
  const oggFile = path.join(dir, `${base}.ogg`);
  const sdpFile = path.join(dir, `${base}.sdp`);

  const transport = await router.createPlainTransport({
    listenIp: '127.0.0.1',
    rtcpMux: false,
    comedia: false,
  });
  await transport.connect({ ip: '127.0.0.1', port: rtpPort, rtcpPort: rtpPort + 1 });

  const consumer = await transport.consume({
    producerId: producer.id,
    rtpCapabilities: router.rtpCapabilities,
    paused: true,
  });

  const codec = consumer.rtpParameters.codecs[0];
  const payloadType = codec.payloadType;
  const sdp = [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=overheard-recording',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    `m=audio ${rtpPort} RTP/AVP ${payloadType}`,
    `a=rtpmap:${payloadType} opus/48000/2`,
    `a=rtcp:${rtpPort + 1}`,
    'a=recvonly',
    '',
  ].join('\n');
  fs.writeFileSync(sdpFile, sdp);

  const ffmpeg: ChildProcess = spawn(
    'ffmpeg',
    [
      '-nostdin',
      '-loglevel', process.env.DEBUG_RECORDER ? 'debug' : 'warning',
      // Unblock ffmpeg's UDP read once packets stop so shutdown can proceed.
      '-rw_timeout', '5000000',
      '-protocol_whitelist', 'file,udp,rtp',
      '-i', sdpFile,
      '-map', '0:a:0',
      '-c:a', 'copy',
      // Durability: cap ogg pages at 100ms and push each completed page to
      // disk immediately. The file is then valid at all times and loses at
      // most ~100ms of tail regardless of how ffmpeg exits.
      '-flush_packets', '1',
      '-page_duration', '100000',
      '-f', 'ogg',
      '-y', oggFile,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  ffmpeg.stderr?.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    if (line) console.log(`[ffmpeg ${participantId}] ${line}`);
  });
  ffmpeg.on('exit', (code, signal) => {
    console.log(`[ffmpeg ${participantId}] exited code=${code} signal=${signal}`);
  });

  // Give ffmpeg a moment to bind its UDP port before media flows.
  await new Promise((r) => setTimeout(r, 500));
  await consumer.resume();

  console.log(`[rec] recording ${displayName} (${participantId}) -> ${oggFile}`);

  let stopped = false;
  const recording: TrackRecording = {
    participantId,
    displayName,
    file: path.relative(path.join(config.recordingsDir, roomId), oggFile),
    roomTimeStartMs,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      recording.roomTimeEndMs = Date.now() - roomStartedAt;
      consumer.close();
      transport.close();
      // Ask ffmpeg to finish; whether it exits via SIGINT, rw_timeout, or
      // the SIGKILL backstop does not affect file validity (flush_packets),
      // but WAIT for the exit before resolving: callers (room close ->
      // scribe) must never read a file another process still has open.
      ffmpeg.kill('SIGINT');
      await new Promise<void>((resolve) => {
        if (ffmpeg.exitCode !== null || ffmpeg.signalCode !== null) {
          resolve();
          return;
        }
        const t = setTimeout(() => ffmpeg.kill('SIGKILL'), 7000);
        ffmpeg.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
      fs.rmSync(sdpFile, { force: true });
      console.log(`[rec] recording finalized for ${displayName} (${participantId})`);
    },
  };
  return recording;
}
