import { Device } from 'mediasoup-client';
import type { Transport } from 'mediasoup-client/types';
import { diag } from './diag';

type Signal = (type: string, data?: Record<string, unknown>) => Promise<any>;

export interface CallEvents {
  onStatus: (status: string) => void;
  onPeerListChanged: (peers: { peerId: string; name: string }[]) => void;
  /** Outgoing (mic) and incoming (room mix) levels in [0, 1], ~60x/s. */
  onLevels?: (tx: number, rx: number) => void;
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
  private rxAnalyser: AnalyserNode | null = null;
  private rxSources = new Map<string, MediaStreamAudioSourceNode>();
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

  private deafened = false;

  /**
   * Deafen: stop hearing the room while still transmitting. Local playback
   * mute only — primarily a diagnostics/testing aid (two devices in one
   * physical room without feedback), but reported to the net like mutes are.
   */
  toggleDeafen(): boolean {
    const clientTimeMs = Date.now();
    this.deafened = !this.deafened;
    for (const el of this.audioEls.values()) el.muted = this.deafened;
    diag(`deafen toggled: ${this.deafened}`);
    this.signal('deafenState', { deafened: this.deafened, clientTimeMs }).catch(() => {});
    return this.deafened;
  }

  toggleMute(): boolean {
    // Capture the wallclock BEFORE touching the track: this is the client's
    // claim of when the audio actually dropped/resumed, stored alongside the
    // server receipt time so the transcript can place it on the audio
    // timeline rather than at notification arrival.
    const clientTimeMs = Date.now();
    if (this.micTrack) this.micTrack.enabled = !this.micTrack.enabled;
    this.signal('muteState', { muted: this.muted, clientTimeMs }).catch(() => {});
    return this.muted;
  }

  private startLevelMeter(stream: MediaStream): void {
    if (!this.events.onLevels) return;
    // Called from the join-button click handler, so the AudioContext is
    // allowed to start (matters on iOS Safari).
    this.audioCtx = new AudioContext();
    const txAnalyser = this.audioCtx.createAnalyser();
    txAnalyser.fftSize = 1024;
    this.audioCtx.createMediaStreamSource(stream).connect(txAnalyser);
    // Incoming tracks are tapped into this analyser as they arrive (see
    // consume()); analysis only — playback stays on the <audio> elements,
    // so the RX meter keeps reading even while deafened.
    this.rxAnalyser = this.audioCtx.createAnalyser();
    this.rxAnalyser.fftSize = 1024;

    const buf = new Float32Array(txAnalyser.fftSize);
    const levelOf = (analyser: AnalyserNode): number => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      // Map -60..0 dBFS onto 0..1 so quiet speech still registers.
      const db = 20 * Math.log10(rms + 1e-8);
      return Math.min(1, Math.max(0, (db + 60) / 60));
    };
    const tick = () => {
      this.events.onLevels!(levelOf(txAnalyser), levelOf(this.rxAnalyser!));
      this.levelRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  leave(): void {
    try {
      this.signal('leave');
    } catch {}
    cancelAnimationFrame(this.levelRaf);
    for (const src of this.rxSources.values()) src.disconnect();
    this.rxSources.clear();
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
      const src = this.rxSources.get(msg.peerId);
      if (src) {
        src.disconnect();
        this.rxSources.delete(msg.peerId);
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

    // The VU meter only proves the mic works locally; this proves (or
    // disproves) that media is actually flowing to the server.
    transport.on('connectionstatechange', (state) => {
      diag(`${direction} transport connection: ${state}`);
      if (direction === 'send') {
        if (state === 'connected') this.events.onStatus('on channel — carrier confirmed');
        else if (state === 'failed' || state === 'disconnected')
          this.events.onStatus(`NO CARRIER — audio not reaching the grid (${state})`);
      }
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
    el.muted = this.deafened;
    const stream = new MediaStream([consumer.track]);
    el.srcObject = stream;
    document.body.appendChild(el);
    this.audioEls.set(peerId, el);
    // iOS Safari sometimes needs an explicit play() after a user gesture.
    el.play().catch(() => {});
    if (this.audioCtx && this.rxAnalyser) {
      const src = this.audioCtx.createMediaStreamSource(stream);
      src.connect(this.rxAnalyser);
      this.rxSources.set(peerId, src);
    }
  }

  private emitPeers(): void {
    this.events.onPeerListChanged(
      [...this.peers.entries()].map(([peerId, p]) => ({ peerId, name: p.name })),
    );
  }
}
