import * as os from 'node:os';

function detectIps(): string[] {
  const ips: string[] = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips.length ? ips : ['127.0.0.1'];
}

export const config = {
  httpPort: Number(process.env.PORT ?? 3000),
  // IPs announced to WebRTC clients as ICE candidates. Defaults to every
  // non-internal IPv4 on the machine (e.g. public + LAN), so remote and
  // local clients each find a reachable path. Override with a
  // comma-separated MEDIASOUP_ANNOUNCED_IPS (or single MEDIASOUP_ANNOUNCED_IP).
  announcedIps: (process.env.MEDIASOUP_ANNOUNCED_IPS ?? process.env.MEDIASOUP_ANNOUNCED_IP)
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean) ?? detectIps(),
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
