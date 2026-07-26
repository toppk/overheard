// Loopback test of the recording pipeline: inject a sine tone as an Opus RTP
// producer via PlainTransport, record it with recorder.ts, verify the ogg.
import { spawn } from 'node:child_process';
import * as mediasoup from 'mediasoup';
import { config } from '../server/config.js';
import { recordProducer } from '../server/recorder.js';

const worker = await mediasoup.createWorker({ rtcMinPort: 41000, rtcMaxPort: 41100 });
const router = await worker.createRouter({ mediaCodecs: config.mediaCodecs });

// Ingest transport: comedia lets mediasoup learn ffmpeg's source address.
const ingest = await router.createPlainTransport({
  listenIp: '127.0.0.1',
  rtcpMux: false,
  comedia: true,
});
console.log(`ingest listening on ${ingest.tuple.localPort}`);

const producer = await ingest.produce({
  kind: 'audio',
  rtpParameters: {
    codecs: [
      {
        mimeType: 'audio/opus',
        payloadType: 101,
        clockRate: 48000,
        channels: 2,
        parameters: { 'sprop-stereo': 1 },
      },
    ],
    encodings: [{ ssrc: 11111111 }],
  },
});

const rec = await recordProducer({
  router,
  producer,
  roomId: 'loopback-test',
  roomStartedAt: Date.now(),
  participantId: 'fake1',
  displayName: 'Sine Tone',
});

// 5 seconds of 440 Hz sine, encoded to opus RTP, sent to the ingest transport.
const send = spawn('ffmpeg', [
  '-nostdin', '-loglevel', 'error', '-re',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
  '-ac', '2', '-c:a', 'libopus',
  '-ssrc', '11111111', '-payload_type', '101',
  '-f', 'rtp', `rtp://127.0.0.1:${ingest.tuple.localPort}?rtcpport=${ingest.rtcpTuple?.localPort}`,
]);
send.stderr.on('data', (d) => console.error(`[send] ${d}`));
await new Promise((r) => setTimeout(r, 2500));
console.log('producer stats:', JSON.stringify(await producer.getStats()));
await new Promise((r) => send.once('exit', r));
console.log('sender finished');

// stop() resolves only once ffmpeg has exited and the ogg is finalized —
// probing immediately is the point: it's what the room-close → scribe path
// relies on.
const stopStart = Date.now();
await rec.stop();
console.log(`stop() finalized the track in ${Date.now() - stopStart}ms`);
producer.close();
worker.close();

// Verify the recorded file; the probe result is the test result (CI runs this).
const probe = spawn('ffprobe', [
  '-v', 'error', '-show_entries', 'format=duration,format_name',
  '-of', 'default=noprint_wrappers=1',
  `recordings/loopback-test/${rec.file}`,
], { stdio: ['ignore', 'inherit', 'inherit'] });
const probeCode: number = await new Promise((r) => probe.once('exit', r));
if (probeCode !== 0) {
  console.error('FAIL: recorded file is not a valid audio file');
  process.exit(1);
}
console.log('PASS: recording pipeline produced a valid file');
process.exit(0);
