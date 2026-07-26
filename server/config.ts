import * as os from 'node:os';

function detectLanIp(): string {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

export const config = {
  httpPort: Number(process.env.PORT ?? 3000),
  // IP announced to WebRTC clients. Set MEDIASOUP_ANNOUNCED_IP when clients
  // connect from other machines (e.g. an iPad on the LAN).
  announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP ?? detectLanIp(),
  rtcMinPort: Number(process.env.RTC_MIN_PORT ?? 40000),
  rtcMaxPort: Number(process.env.RTC_MAX_PORT ?? 40100),
  recordingsDir: process.env.RECORDINGS_DIR ?? 'recordings',
  // Local UDP ports ffmpeg listens on to receive RTP from mediasoup.
  recordRtpPortStart: 45000,
  mediaCodecs: [
    {
      kind: 'audio' as const,
      mimeType: 'audio/opus',
      clockRate: 48000,
      channels: 2,
    },
  ],
};
