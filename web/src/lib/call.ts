import { Device } from 'mediasoup-client';
import type { Transport } from 'mediasoup-client/types';
import { diag } from './diag';

type Signal = (type: string, data?: Record<string, unknown>) => Promise<any>;

export interface CallEvents {
  onStatus: (status: string) => void;
  onPeerListChanged: (peers: { peerId: string; name: string }[]) => void;
  /** Local mic level in [0, 1], called ~60x/s while in the call. */
  onLevel?: (level: number) => void;
}

export class Call {
  private ws!: WebSocket;
  private device = new Device();
  private sendTransport: Transport | null = null;
  private recvTransport: Transport | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private peers = new Map<string, { name: string }>();
  private audioEls = new Map<string, HTMLAudioElement>();
  private pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private nextRequestId = 1;
  private events: CallEvents;
  private audioCtx: AudioContext | null = null;
  private levelRaf = 0;

  constructor(events: CallEvents) {
    this.events = events;
  }

  async join(roomId: string, name: string): Promise<void> {
    this.events.onStatus('requesting microphone…');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.micTrack = stream.getAudioTracks()[0];
    this.startLevelMeter(stream);

    this.events.onStatus('connecting…');
    await this.connectWebSocket();

    const joinInfo = await this.signal('join', { roomId, name });
    await this.device.load({ routerRtpCapabilities: joinInfo.routerRtpCapabilities });

    this.sendTransport = await this.createTransport('send');
    this.recvTransport = await this.createTransport('recv');

    this.events.onStatus('publishing microphone…');
    await this.sendTransport.produce({ track: this.micTrack });

    for (const peer of joinInfo.peers) {
      this.peers.set(peer.peerId, { name: peer.name });
      for (const producerId of peer.producerIds) {
        await this.consume(peer.peerId, producerId);
      }
    }
    this.emitPeers();
    this.events.onStatus('in call');
  }

  get muted(): boolean {
    return this.micTrack ? !this.micTrack.enabled : false;
  }

  toggleMute(): boolean {
    if (this.micTrack) this.micTrack.enabled = !this.micTrack.enabled;
    return this.muted;
  }

  private startLevelMeter(stream: MediaStream): void {
    if (!this.events.onLevel) return;
    // Called from the join-button click handler, so the AudioContext is
    // allowed to start (matters on iOS Safari).
    this.audioCtx = new AudioContext();
    const analyser = this.audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    this.audioCtx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      // Map -60..0 dBFS onto 0..1 so quiet speech still registers.
      const db = 20 * Math.log10(rms + 1e-8);
      this.events.onLevel!(Math.min(1, Math.max(0, (db + 60) / 60)));
      this.levelRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  leave(): void {
    try {
      this.signal('leave');
    } catch {}
    cancelAnimationFrame(this.levelRaf);
    this.audioCtx?.close().catch(() => {});
    this.micTrack?.stop();
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.ws?.close();
    for (const el of this.audioEls.values()) el.remove();
    this.audioEls.clear();
    this.peers.clear();
    this.emitPeers();
    this.events.onStatus('left');
  }

  private connectWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      diag('call ws: connecting');
      this.ws = new WebSocket(`${proto}://${location.host}/ws`);
      this.ws.onopen = () => {
        diag('call ws: open');
        resolve();
      };
      this.ws.onerror = () => {
        diag('call ws: error');
        reject(new Error('websocket connection failed'));
      };
      this.ws.onclose = () => {
        diag('call ws: closed');
        this.events.onStatus('disconnected');
      };
      this.ws.onmessage = (ev) => this.handleMessage(JSON.parse(ev.data));
    });
  }

  private signal: Signal = (type, data = {}) => {
    return new Promise((resolve, reject) => {
      const requestId = this.nextRequestId++;
      this.pendingRequests.set(requestId, { resolve, reject });
      this.ws.send(JSON.stringify({ type, requestId, ...data }));
    });
  };

  private handleMessage(msg: any): void {
    if (msg.type === 'response') {
      const pending = this.pendingRequests.get(msg.requestId);
      if (!pending) return;
      this.pendingRequests.delete(msg.requestId);
      if (msg.error) {
        diag(`signal response error: ${msg.error}`);
        pending.reject(new Error(msg.error));
      } else pending.resolve(msg.data);
      return;
    }
    diag(`call event: ${msg.type}`, { peer: msg.name ?? msg.peerId });
    if (msg.type === 'peerJoined') {
      this.peers.set(msg.peerId, { name: msg.name });
      this.emitPeers();
    } else if (msg.type === 'peerLeft') {
      this.peers.delete(msg.peerId);
      const el = this.audioEls.get(msg.peerId);
      if (el) {
        el.remove();
        this.audioEls.delete(msg.peerId);
      }
      this.emitPeers();
    } else if (msg.type === 'newProducer') {
      this.peers.set(msg.peerId, { name: msg.name });
      this.emitPeers();
      void this.consume(msg.peerId, msg.producerId);
    }
  }

  private async createTransport(direction: 'send' | 'recv'): Promise<Transport> {
    const params = await this.signal('createTransport', { direction });
    const options = {
      id: params.transportId,
      iceParameters: params.iceParameters,
      iceCandidates: params.iceCandidates,
      dtlsParameters: params.dtlsParameters,
    };
    const transport =
      direction === 'send'
        ? this.device.createSendTransport(options)
        : this.device.createRecvTransport(options);

    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.signal('connectTransport', { transportId: transport.id, dtlsParameters })
        .then(() => callback())
        .catch(errback);
    });

    if (direction === 'send') {
      transport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
        this.signal('produce', { transportId: transport.id, kind, rtpParameters })
          .then(({ producerId }) => callback({ id: producerId }))
          .catch(errback);
      });
    }
    return transport;
  }

  private async consume(peerId: string, producerId: string): Promise<void> {
    if (!this.recvTransport) return;
    const params = await this.signal('consume', {
      transportId: this.recvTransport.id,
      producerId,
      rtpCapabilities: this.device.rtpCapabilities,
    });
    const consumer = await this.recvTransport.consume({
      id: params.consumerId,
      producerId: params.producerId,
      kind: params.kind,
      rtpParameters: params.rtpParameters,
    });
    await this.signal('resumeConsumer', { consumerId: consumer.id });
    diag(`consuming audio from peer ${peerId}`);

    const el = document.createElement('audio');
    el.autoplay = true;
    el.srcObject = new MediaStream([consumer.track]);
    document.body.appendChild(el);
    this.audioEls.set(peerId, el);
    // iOS Safari sometimes needs an explicit play() after a user gesture.
    el.play().catch(() => {});
  }

  private emitPeers(): void {
    this.events.onPeerListChanged(
      [...this.peers.entries()].map(([peerId, p]) => ({ peerId, name: p.name })),
    );
  }
}
