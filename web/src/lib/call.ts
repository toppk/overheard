import { Device } from 'mediasoup-client';
import type { Transport, Producer, Consumer } from 'mediasoup-client/types';
import { diag } from './diag';
import { describePlatform } from './platform';

type Signal = (type: string, data?: Record<string, unknown>) => Promise<any>;

/** Extra delay before each successive ICE restart. A culled NAT binding
 *  often needs seconds-to-tens-of-seconds before a fresh pair will stick,
 *  so hammering it every stats beat only burns the budget. Length of this
 *  array is the total attempt budget. */
const RECOVERY_BACKOFF_MS = [0, 8000, 20000, 45000];

/** A TCP socket can stay `OPEN` long after the far side is gone, and every
 *  caller of signal() awaits it. Without a deadline one dead request wedges
 *  recovery — and the resync/ICE-restart paths below exist precisely for
 *  moments when the network is misbehaving. */
const SIGNAL_TIMEOUT_MS = 10000;

/** Delay before each successive attempt to get the microphone back, capped
 *  at the last value and then retried at that interval for as long as the
 *  call lasts. The mic can be handed back at any moment (the other app
 *  hangs up), so unlike an ICE restart this never gives up — the only exit
 *  is success or the user revoking permission outright. */
const MIC_REACQUIRE_BACKOFF_MS = [0, 2000, 5000, 10000, 20000];

/** How long a mic fault must persist before we stop waiting for the
 *  platform to hand the track back and go take a new one. ~15s at the 3s
 *  carrier beat.
 *
 *  Kept short because the graceful paths ('unmute') and the hard path
 *  ('ended') both fire on their own — this window only covers a platform
 *  that does neither and says nothing. iPadOS was observed doing BOTH on
 *  different runs of the same test (2026-08-07), so nothing here may
 *  assume which one it will be. */
const MIC_FAULT_PATIENCE_BEATS = 3;

/** Delay before each attempt to rebuild a dropped session. The server holds
 *  an emptied room open for ~30s, so the whole ladder has to fit inside that
 *  window with room to spare — getting back into the SAME construct is the
 *  entire point, and a room that has sealed cannot be rejoined at any speed. */
const RECONNECT_BACKOFF_MS = [500, 2000, 4000, 8000];

export interface CallEvents {
  onStatus: (status: string) => void;
  onPeerListChanged: (peers: { peerId: string; name: string }[]) => void;
  /** Outgoing (mic) and incoming (room mix) levels in [0, 1], ~60x/s. */
  onLevels?: (tx: number, rx: number) => void;
  /** Non-null when RTP has stopped flowing (the VU meter can't tell you this). */
  onCarrier?: (problem: string | null) => void;
  /** True while incoming audio is blocked by the browser awaiting a tap. */
  onAudioBlocked?: (blocked: boolean) => void;
  /** Fired for each automatic reconnect attempt after a mid-call drop. */
  onReconnecting?: (attempt: number, max: number) => void;
  /** Automatic reconnection gave up: either the construct sealed before we
   *  got back, or the attempts ran out. The UI must now offer a way back in
   *  rather than leaving a dead in-call screen up. */
  onDisconnected?: (reason?: 'sealed' | 'exhausted') => void;
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
  private producer: Producer | null = null;
  private consumersByPeer = new Map<string, Consumer>();
  private blockedEls = new Set<HTMLAudioElement>();
  private gestureArmed = false;
  private carrierTimer = 0;
  private lastTxBytes = 0;
  private lastRxBytes = 0;
  private txStalls = 0;
  private rxStalls = 0;
  private carrierMsg: string | null = null;
  private recoveryAttempts = 0;
  private recoveryInFlight = false;
  private lastRecoveryMs = 0;
  private recoveryExhausted = false;
  private consumedProducers = new Set<string>();
  private resyncInFlight = false;
  private beats = 0;
  private signalingDead = false;
  private joined = false;
  private leaving = false;
  private roomId = '';
  private displayName = '';
  private reconnecting = false;
  private reconnectAttempts = 0;
  private micReacquireInFlight = false;
  private micReacquireAttempts = 0;
  private lastMicReacquireMs = 0;
  private micPermissionLost = false;
  private micFaultBeats = 0;
  private micWatch: AbortController | null = null;
  private txAnalyser: AnalyserNode | null = null;
  private txSource: MediaStreamAudioSourceNode | null = null;
  private wakeLock: { release(): Promise<void> } | null = null;
  private onVisible = () => {
    if (document.visibilityState !== 'visible') {
      // The hidden half of the transition, which used to be ignored entirely.
      // This is the LAST moment the socket is reliably alive before an iOS
      // lock freezes the page, so it is the only chance to tell the server
      // what is happening. Without it the room keeps claiming we are on
      // channel until TCP eventually gives up — ~12s of the lobby lying.
      this.trace('page hidden (screen lock, app switch, or tab change)');
      this.signal('away', { away: true }).catch(() => {});
      return;
    }
    if (this.joined) this.signal('away', { away: false }).catch(() => {});
    void this.acquireWakeLock();
    // The lock that froze this page probably also killed the socket. Coming
    // back is both the first moment a reconnect can work and the moment the
    // hold window is ticking, so restart the ladder from the top rather than
    // resuming a backoff that expired while we were frozen.
    if (!this.joined && !this.leaving && this.roomId) {
      this.reconnectAttempts = 0;
      void this.reconnect('became visible');
      return;
    }
    // A backgrounded tab can have its timers throttled and its websocket
    // starved; coming back is exactly when we may have missed a producer.
    void this.resync('became visible');
    // Returning from another app on iOS: the audio session may have been
    // taken and handed back with playback still suspended.
    void this.resumePlayback('became visible');
    // Coming back to the app is the strongest available signal that whatever
    // took the microphone is done with it — don't sit out the patience
    // window when the user has already told us by switching back. On the
    // iPad test this was ~6s of the delay before the voice returned.
    // A denial that happened while we were backgrounded says nothing about
    // what the user will allow now that they can actually see the prompt —
    // and they may have just granted it. Never let it stay latched.
    this.micPermissionLost = false;
    if (this.micFault()) void this.reacquireMic('became visible');
  };

  constructor(events: CallEvents) {
    this.events = events;
  }

  async join(roomId: string, name: string): Promise<void> {
    // Remembered so a reconnect can rebuild the same session without the UI
    // having to drive it.
    this.roomId = roomId;
    this.displayName = name;

    this.events.onStatus('requesting microphone…');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.micTrack = stream.getAudioTracks()[0];
    this.watchMicTrack();
    this.startLevelMeter(stream);

    this.events.onStatus('connecting…');
    await this.connectWebSocket();
    await this.establish();

    this.events.onStatus('in call');
    this.startCarrierWatch();
    void this.acquireWakeLock();
    document.addEventListener('visibilitychange', this.onVisible);
  }

  /** Everything from "we have a socket" to "we are on channel", isolated so
   *  a reconnect can re-run it. Assumes the mic and the level meter already
   *  exist; the Device is loaded at most once (mediasoup throws on a second
   *  load, and the router's capabilities do not change between joins). */
  private async establish(): Promise<void> {
    // Platform travels with the join so it lands next to the participant id
    // that every later log line is keyed by — "which device was 085570f0?"
    // should never again be a thing you reconstruct from memory.
    const joinInfo = await this.signal('join', {
      roomId: this.roomId,
      name: this.displayName,
      platform: describePlatform(),
    });

    // Measure our clock offset against the server (NTP-style single ping)
    // so event claims can be translated onto the server clock. Half the
    // round trip is the residual error bound.
    const t0 = Date.now();
    const { serverTime } = await this.signal('clockPing');
    const t1 = Date.now();
    const offsetMs = serverTime - (t0 + t1) / 2;
    diag(`clock sync: offset ${offsetMs.toFixed(0)}ms, rtt ${t1 - t0}ms`);
    this.signal('clockOffset', { offsetMs, rttMs: t1 - t0 }).catch(() => {});

    if (!this.device.loaded) {
      await this.device.load({ routerRtpCapabilities: joinInfo.routerRtpCapabilities });
    }

    this.sendTransport = await this.createTransport('send');
    this.recvTransport = await this.createTransport('recv');

    this.events.onStatus('publishing microphone…');
    // A screen lock can end the capture track while we are away, so the mic
    // may need replacing before it can be published again.
    await this.ensureMicTrack();
    const opusMaxAverageBitrate = joinInfo.audio?.opusMaxAverageBitrate ?? 96000;
    diag(`producing mic (opus maxAverageBitrate=${opusMaxAverageBitrate}, fec=on, dtx=off)`);
    this.producer = await this.sendTransport.produce({
      track: this.micTrack,
      codecOptions: {
        // Bitrate is deployment policy (OPUS_BITRATE env on the server).
        opusMaxAverageBitrate,
        // Inband FEC conceals packet loss; effectively free.
        opusFec: true,
        // DTX stays OFF as an invariant: continuous packets during silence
        // are what keep the recording timeline and mute detection honest.
        opusDtx: false,
      },
    });

    for (const peer of joinInfo.peers) {
      this.peers.set(peer.peerId, { name: peer.name });
      for (const producerId of peer.producerIds) {
        await this.consume(peer.peerId, producerId);
      }
    }
    this.emitPeers();
    this.joined = true;
    this.signalingDead = false;
    this.txStalls = 0;
    this.rxStalls = 0;
    this.lastTxBytes = 0;
    this.lastRxBytes = 0;
    this.resetRecovery();
    this.trace(
      `patched in as ${this.displayName}: transports up, ${joinInfo.peers.length} peer(s) consumed`,
    );
  }

  /** Guarantee a live capture track, replacing a dead one. Used on reconnect,
   *  where the same lock that dropped the socket has usually ended the mic. */
  private async ensureMicTrack(): Promise<void> {
    if (this.micTrack && this.micTrack.readyState === 'live') return;
    const wasMuted = this.muted;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('no microphone available');
    track.enabled = !wasMuted;
    this.micTrack?.stop();
    this.micTrack = track;
    this.watchMicTrack();
    this.retapLevelMeter(stream);
    this.trace(`microphone replaced for reconnect${wasMuted ? ' (still muted)' : ''}`);
  }

  /** diag() into the local console AND relay to the server log, so remote
   *  devices (iPads have no reachable console) can be debugged after the fact. */
  private trace(line: string): void {
    diag(line);
    try {
      // room/name as a fallback label: traces during a reconnect arrive
      // before the server has re-associated this socket with a peer.
      this.signal('trace', { line, room: this.roomId, name: this.displayName }).catch(() => {});
    } catch {}
  }

  /** Keep the screen on while patched in: on iOS, screen lock suspends mic
   *  capture and the room hears silence. Best-effort — not all browsers. */
  private async acquireWakeLock(): Promise<void> {
    const wl = (navigator as { wakeLock?: { request(type: string): Promise<any> } }).wakeLock;
    if (!wl) return;
    try {
      this.wakeLock = await wl.request('screen');
      this.trace('wake lock acquired: screen stays on while on channel');
    } catch (err) {
      this.trace(`wake lock refused: ${(err as Error)?.name}`);
    }
  }

  /** The mic's own events fire the instant another app seizes the device,
   *  rather than up to one stats beat later. Trace only — the watch below
   *  is what decides what to tell the user. */
  private watchMicTrack(): void {
    const t = this.micTrack;
    if (!t) return;
    // A replaced track keeps firing at its old listeners — one duplicate
    // trace per reacquisition, seen in the 2026-08-13 logs.
    this.micWatch?.abort();
    this.micWatch = new AbortController();
    const { signal } = this.micWatch;
    t.addEventListener(
      'mute',
      () => this.trace('mic source stopped delivering (another app likely seized the microphone)'),
      { signal },
    );
    t.addEventListener(
      'unmute',
      () => {
        this.trace('mic source is delivering again');
        // The platform handed it back on its own; no reacquire needed, but the
        // banner must stop saying MIC SEIZED right now, not on the next beat.
        this.refreshMicCarrier();
      },
      { signal },
    );
    // 'ended' is terminal for this track — the only way back is a new one.
    t.addEventListener(
      'ended',
      () => {
        this.trace('mic track ended (device disconnected, revoked, or taken by another app)');
        void this.reacquireMic('track ended');
      },
      { signal },
    );
  }

  /** Why has TX stalled — the microphone, or the network?
   *
   *  bytesSent alone cannot tell you: a mic seized by another app (a phone
   *  call, Signal, Siri) flatlines the counter in exactly the same shape a
   *  blackholed UDP path does. Blaming "network likely eating UDP" for a
   *  local device-arbitration problem sends people to debug their router.
   *  Ask the track first; only fall through to the network once the source
   *  is proven live.
   *
   *  `track.muted` is the browser's flag for "the source is not currently
   *  delivering" and is a different thing from our own mute button, which
   *  is `track.enabled` (see `get muted()` below). */
  private micFault(): string | null {
    const t = this.micTrack;
    if (!t) return null;
    if (t.readyState === 'ended')
      return 'MIC GONE — the microphone was disconnected or taken away. Not a network problem; reaching for it again — no need to drop the line';
    if (t.muted)
      return 'MIC SEIZED — another app is holding your microphone (a phone call, Signal, Siri). Not a network problem; close the other app and your voice comes back on its own';
    return null;
  }

  /** The VU meter only proves the mic works locally. This proves packets:
   *  if RTP byte counters stop advancing, surface it instead of letting a
   *  lively TX meter suggest a working channel (UDP-hostile networks,
   *  transient blackouts). Our own mute doesn't false-alarm — DTX is off,
   *  so a muted mic still ships silence frames. */
  private startCarrierWatch(): void {
    this.carrierTimer = window.setInterval(async () => {
      try {
        // With the signaling socket gone there is no session left to
        // diagnose: mic faults, ICE restarts and resyncs are all
        // meaningless, and every recovery path below would fail anyway.
        // onclose has already said the honest thing.
        if (this.ws.readyState !== WebSocket.OPEN) return;
        let tx = 0;
        if (this.producer && !this.producer.closed) {
          for (const s of (await this.producer.getStats()).values() as Iterable<any>)
            if (s.type === 'outbound-rtp') tx += s.bytesSent ?? 0;
        }
        let rx = 0;
        for (const c of this.consumersByPeer.values())
          for (const s of (await c.getStats()).values() as Iterable<any>)
            if (s.type === 'inbound-rtp') rx += s.bytesReceived ?? 0;

        this.txStalls = tx > this.lastTxBytes ? 0 : this.txStalls + 1;
        this.rxStalls = this.consumersByPeer.size === 0 || rx > this.lastRxBytes ? 0 : this.rxStalls + 1;
        this.lastTxBytes = tx;
        this.lastRxBytes = rx;

        // Attribute a stalled TX to the mic before reaching for the network.
        const micFault = this.micFault();
        const txNetworkDead = !micFault && this.txStalls >= 2;
        const rxNetworkDead = this.rxStalls >= 2;
        const networkDead = txNetworkDead || rxNetworkDead;

        const dead: string[] = [];
        if (micFault) dead.push(micFault);
        else if (txNetworkDead) dead.push('TX dead — your voice is NOT reaching the grid');
        if (rxNetworkDead) dead.push('RX dead — nothing is arriving from the grid');

        const msg = dead.length
          ? `NO CARRIER: ${dead.join('; ')}.${networkDead ? ' (network likely eating UDP)' : ''}`
          : null;
        if (msg !== this.carrierMsg) {
          this.carrierMsg = msg;
          this.events.onCarrier?.(msg);
          this.trace(msg ? `carrier lost: ${msg}` : 'carrier restored: RTP flowing again');
        }

        // Only a network fault is recoverable by re-running ICE; a seized
        // mic needs the user, and no candidate pair will fix it.
        if (networkDead) void this.considerIceRestart(txNetworkDead, rxNetworkDead);
        else this.resetRecovery();

        // A mic fault the platform hasn't resolved on its own: an ended
        // track never comes back, and a 'muted' one only unmutes if the OS
        // bothers to say so — which it may never do once the other app has
        // let go. Past the patience window, stop waiting and take a new one.
        if (micFault) {
          if (++this.micFaultBeats >= MIC_FAULT_PATIENCE_BEATS || this.micTrack?.readyState === 'ended') {
            void this.reacquireMic(this.micTrack?.readyState === 'ended' ? 'track ended' : 'mic held too long');
          }
        } else if (this.micFaultBeats) {
          this.micFaultBeats = 0;
          this.micReacquireAttempts = 0;
        }

        // Every 5th beat (~15s): prove the signaling socket still answers.
        // A zombie ws is the nastiest failure here because it looks healthy
        // — media keeps flowing, so nothing complains, while peerJoined /
        // newProducer / peerLeft are silently dropped and the call rots.
        if (++this.beats % 5 === 0) void this.heartbeat();
      } catch {
        // getStats can fail transiently mid-teardown; skip the beat.
      }
    }, 3000);
  }

  private async heartbeat(): Promise<void> {
    try {
      await this.signal('clockPing');
      if (this.signalingDead) {
        this.signalingDead = false;
        this.trace('signaling socket is answering again');
        // We were deaf to room events for a while; re-derive what we missed.
        void this.resync('signaling recovered');
      }
    } catch {
      if (!this.signalingDead) {
        this.signalingDead = true;
        this.trace('signaling socket not answering — room events are being missed');
        this.events.onStatus(
          'SIGNAL LOST — the exchange is not answering; drop the line and patch back in',
        );
      }
    }
  }

  /** Take a fresh microphone and swap it into the live producer.
   *
   *  A MediaStreamTrack that reaches 'ended' is dead permanently — it cannot
   *  be restarted, only replaced. When another app seizes the mic the
   *  platform either hands the track back (an 'unmute' event, nothing to do)
   *  or kills it outright, and which you get depends on the OS audio stack;
   *  PipeWire tearing down and recreating the node ends it. In that second
   *  case the call was left permanently silent on a perfectly healthy
   *  transport, and the only cure was to leave and rejoin.
   *
   *  getUserMedia gives a NEW track and producer.replaceTrack swaps it in
   *  underneath: the producer, transport, recording and room all survive, so
   *  the far side hears a gap rather than a reconnect, and the tape gets no
   *  second track. */
  private async reacquireMic(reason: string): Promise<void> {
    if (this.micReacquireInFlight || this.micPermissionLost) return;
    if (!this.producer || this.producer.closed) return;
    // Capture is suspended while the page is hidden (an iOS screen lock is
    // the common case), so getUserMedia here cannot succeed — and it is
    // worse than merely futile: iOS answers a prompt it cannot show with
    // NotAllowedError, which would latch the microphone as permanently
    // denied for the rest of the call. Wait for the page to come back;
    // onVisible retries immediately.
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    const wait =
      MIC_REACQUIRE_BACKOFF_MS[
        Math.min(this.micReacquireAttempts, MIC_REACQUIRE_BACKOFF_MS.length - 1)
      ];
    if (this.micReacquireAttempts && Date.now() - this.lastMicReacquireMs < wait) return;

    this.micReacquireInFlight = true;
    this.micReacquireAttempts++;
    this.lastMicReacquireMs = Date.now();
    try {
      this.trace(`reacquiring microphone (attempt ${this.micReacquireAttempts}, ${reason})`);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('no audio track in replacement stream');
      if (track.readyState === 'ended' || track.muted) {
        // Handed a dead or still-seized track: the other app has not let go.
        track.stop();
        throw new Error(track.muted ? 'replacement mic is still held' : 'replacement mic arrived ended');
      }
      // The user's own mute is policy and must survive the swap; it lives on
      // the track, so the new one has to be told.
      const wasMuted = this.muted;
      track.enabled = !wasMuted;
      await this.producer.replaceTrack({ track });
      this.micTrack?.stop();
      this.micTrack = track;
      this.watchMicTrack();
      this.retapLevelMeter(stream);
      this.micReacquireAttempts = 0;
      this.micFaultBeats = 0;
      // The same interruption that took the mic also suspends playback.
      void this.resumePlayback('mic reacquired');
      this.refreshMicCarrier();
      this.trace(`microphone reacquired and swapped into the live producer${wasMuted ? ' (still muted)' : ''}`);
      this.events.onStatus(
        wasMuted ? 'microphone back — still muted' : 'microphone back — you are live again',
      );
    } catch (err) {
      const name = (err as Error)?.name ?? '';
      if (name === 'NotAllowedError') {
        // A hard denial will not change on retry; stop and say so.
        this.micPermissionLost = true;
        this.trace('microphone permission denied — cannot reacquire');
        this.events.onStatus('MIC DENIED — grant microphone access, then drop the line and patch back in');
      } else {
        this.trace(`microphone reacquire failed: ${name || (err as Error)?.message || String(err)}`);
      }
    } finally {
      this.micReacquireInFlight = false;
    }
  }

  /** Tear down everything tied to a dead socket, keeping what survives it:
   *  the loaded Device, the mic, and the AudioContext with its analysers. */
  private teardownSession(): void {
    this.producer = null;
    this.consumersByPeer.clear();
    this.consumedProducers.clear();
    this.blockedEls.clear();
    for (const src of this.rxSources.values()) src.disconnect();
    this.rxSources.clear();
    for (const el of this.audioEls.values()) el.remove();
    this.audioEls.clear();
    this.peers.clear();
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.sendTransport = null;
    this.recvTransport = null;
    this.emitPeers();
  }

  /** Rebuild the session in place after the line drops.
   *
   *  This is what makes a screen lock survivable. The server holds an
   *  emptied room open for a short window; before this existed, that window
   *  was spent waiting for a human to notice, unlock, and tap — which almost
   *  never fit. A client that reconnects on its own fits easily, and the
   *  interruption becomes a gap in the tape instead of the end of a meeting.
   *
   *  Known cost: the server sees a NEW peer, so a reconnect adds a second
   *  track for the same speaker (see TODO). Better than losing the room. */
  private async reconnect(reason: string): Promise<void> {
    if (this.reconnecting || this.leaving || !this.roomId) return;
    this.reconnecting = true;
    try {
      while (this.reconnectAttempts < RECONNECT_BACKOFF_MS.length) {
        // While the page is hidden (an iOS lock) timers are frozen and
        // getUserMedia cannot succeed; onVisible restarts this properly.
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
          this.trace('reconnect paused until the page is visible again');
          return;
        }
        const wait = RECONNECT_BACKOFF_MS[this.reconnectAttempts];
        this.reconnectAttempts++;
        this.events.onReconnecting?.(this.reconnectAttempts, RECONNECT_BACKOFF_MS.length);
        this.events.onStatus(
          `line dropped — reconnecting (${this.reconnectAttempts}/${RECONNECT_BACKOFF_MS.length})…`,
        );
        await new Promise((r) => setTimeout(r, wait));
        if (this.leaving) return;
        try {
          this.teardownSession();
          await this.connectWebSocket();
          await this.establish();
          this.reconnectAttempts = 0;
          this.trace(`reconnected and back on channel (${reason})`);
          this.events.onStatus('back on channel');
          this.events.onCarrier?.(null);
          this.carrierMsg = null;
          void this.resumePlayback('reconnected');
          return;
        } catch (err) {
          const message = (err as Error)?.message ?? String(err);
          this.diagOnly(`reconnect attempt failed: ${message}`);
          if (message === 'sealed') {
            // The hold window closed before we got back. No number of
            // retries brings a sealed construct back; say so and stop.
            this.events.onDisconnected?.('sealed');
            return;
          }
        }
      }
      this.events.onDisconnected?.('exhausted');
    } finally {
      this.reconnecting = false;
    }
  }

  /** diag() without the server relay — used where the socket is known dead
   *  and a trace would only queue another doomed send. */
  private diagOnly(line: string): void {
    diag(line);
  }

  /** Clear the carrier banner the instant the microphone is live again.
   *
   *  The banner is otherwise only rebuilt on the 3s beat, which on the iPad
   *  test (2026-08-07) left it reading MIC SEIZED for 2.6s after the voice
   *  was already back — on the tape as "it works, but it still says mic
   *  seized". Being told you are broken while you are talking is its own
   *  bug: it teaches people to distrust the banner exactly when it matters.
   *
   *  Only clears what it can vouch for — a live mic and incoming RTP. A real
   *  TX network fault re-asserts itself within a couple of beats. */
  private refreshMicCarrier(): void {
    if (this.micFault() || this.rxStalls >= 2) return;
    this.txStalls = 0;
    this.micFaultBeats = 0;
    if (this.carrierMsg === null) return;
    this.carrierMsg = null;
    this.events.onCarrier?.(null);
    this.trace('carrier restored: microphone is live again');
  }

  private resetRecovery(): void {
    if (this.recoveryAttempts && !this.recoveryInFlight) {
      this.trace('carrier recovered; ICE restart budget reset');
    }
    this.recoveryAttempts = 0;
    this.recoveryExhausted = false;
    this.lastRecoveryMs = 0;
  }

  /** Get a fresh 5-tuple without making the user leave and rejoin.
   *
   *  A UDP-hostile network (CGNAT rebinding, a stateful firewall culling an
   *  idle-looking flow) kills the *specific* candidate pair ICE settled on.
   *  Because the handshake already succeeded, nothing ever re-runs it — the
   *  transport sits in `connected` on a dead path indefinitely. That is why
   *  leaving and rejoining "magically" fixed it, and why switching devices
   *  did too: both build new transports on new ports. restartIce buys the
   *  same new ports while keeping the room, the producer and the recording
   *  intact — no second track in metadata, no gap in the tape, no rejoin. */
  private async considerIceRestart(txDead: boolean, rxDead: boolean): Promise<void> {
    if (this.recoveryInFlight) return;
    if (this.recoveryAttempts >= RECOVERY_BACKOFF_MS.length) {
      if (!this.recoveryExhausted) {
        this.recoveryExhausted = true;
        this.trace('ICE restart budget exhausted — the path is not coming back on its own');
        this.events.onStatus('NO CARRIER — automatic recovery failed; drop the line and patch back in');
      }
      return;
    }
    if (Date.now() - this.lastRecoveryMs < RECOVERY_BACKOFF_MS[this.recoveryAttempts]) return;

    this.recoveryInFlight = true;
    this.recoveryAttempts++;
    this.lastRecoveryMs = Date.now();
    const targets: [Transport | null, string][] = [];
    if (txDead) targets.push([this.sendTransport, 'send']);
    if (rxDead) targets.push([this.recvTransport, 'recv']);
    try {
      for (const [transport, label] of targets) {
        if (!transport || transport.closed) continue;
        this.trace(
          `ICE restart ${this.recoveryAttempts}/${RECOVERY_BACKOFF_MS.length} on ${label} transport: asking for a fresh candidate pair`,
        );
        const { iceParameters } = await this.signal('restartIce', { transportId: transport.id });
        await transport.restartIce({ iceParameters });
        this.trace(`ICE restart issued on ${label} transport; watching for RTP`);
      }
      // Cheap insurance: if anything was missed while the path was dark,
      // this repairs it rather than waiting for the next visibility change.
      void this.resync('after ICE restart');
    } catch (err) {
      this.trace(`ICE restart failed: ${(err as Error)?.message ?? String(err)}`);
    } finally {
      this.recoveryInFlight = false;
    }
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
    this.txAnalyser = txAnalyser;
    this.txSource = this.audioCtx.createMediaStreamSource(stream);
    this.txSource.connect(txAnalyser);
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

  /** Recover local playback after an audio-session interruption.
   *
   *  iOS doesn't only take the microphone when another app grabs the audio
   *  session — it suspends the AudioContext and pauses the <audio> elements
   *  too. Getting the mic back therefore isn't enough: without this you can
   *  talk again but still can't hear anyone, and the meters read zero, which
   *  is indistinguishable from the bug you just fixed. Playback that the
   *  browser refuses without a gesture falls into the existing
   *  tap-anywhere path rather than being swallowed. */
  private async resumePlayback(reason: string): Promise<void> {
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      try {
        await this.audioCtx.resume();
        this.trace(`audio context resumed (${reason})`);
      } catch {
        this.trace(`audio context refused to resume (${reason}) — held until next tap`);
        this.armGestureRetry();
      }
    }
    for (const [peerId, el] of this.audioEls) {
      if (!el.paused) continue;
      el.play().then(
        () => this.trace(`playback resumed for peer ${peerId} (${reason})`),
        (err) => {
          this.trace(
            `playback refused for peer ${peerId} (${(err as Error)?.name}) — held until next tap`,
          );
          this.blockedEls.add(el);
          this.events.onAudioBlocked?.(true);
          this.armGestureRetry();
        },
      );
    }
  }

  /** Point the TX meter at a replacement mic stream. Without this the meter
   *  keeps reading the dead track and sits at zero forever, which looks
   *  exactly like the failure we just recovered from. */
  private retapLevelMeter(stream: MediaStream): void {
    if (!this.audioCtx || !this.txAnalyser) return;
    this.txSource?.disconnect();
    this.txSource = this.audioCtx.createMediaStreamSource(stream);
    this.txSource.connect(this.txAnalyser);
  }

  leave(): void {
    // Idempotent: 'beforeunload' and 'pagehide' both fire on some browsers,
    // and the leave button can race either of them.
    if (this.leaving) return;
    this.leaving = true;
    this.joined = false;
    // Fire-and-forget, but signal() can now reject (timeout / dead socket)
    // and an unhandled rejection on the way out helps nobody.
    try {
      this.signal('leave').catch(() => {});
    } catch {}
    clearInterval(this.carrierTimer);
    this.recoveryAttempts = 0;
    this.recoveryInFlight = false;
    this.recoveryExhausted = false;
    this.carrierMsg = null;
    this.beats = 0;
    this.signalingDead = false;
    this.resyncInFlight = false;
    this.micReacquireInFlight = false;
    this.micReacquireAttempts = 0;
    this.micPermissionLost = false;
    this.micFaultBeats = 0;
    this.txSource?.disconnect();
    this.txSource = null;
    this.txAnalyser = null;
    document.removeEventListener('visibilitychange', this.onVisible);
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    this.producer = null;
    this.consumersByPeer.clear();
    this.consumedProducers.clear();
    this.blockedEls.clear();
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
      // Detach the outgoing socket first: a replaced socket's onclose would
      // otherwise fire mid-reconnect and start a second one.
      if (this.ws) {
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.onmessage = null;
        try {
          this.ws.close();
        } catch {}
      }
      this.pendingRequests.clear();
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
        this.signalingDead = true;
        // Every TX/RX stall from here is a symptom of this, not an
        // independent fault. Leaving a stale "network likely eating UDP"
        // banner up sends people to debug a network that is fine, for a
        // call that no longer exists.
        if (this.carrierMsg) {
          this.carrierMsg = null;
          this.events.onCarrier?.(null);
        }
        // Only for a drop we did not ask for. An intentional leave closes
        // the socket too, and that page is on its way out anyway.
        if (this.joined && !this.leaving) {
          this.joined = false;
          this.events.onStatus('line dropped — reconnecting…');
          void this.reconnect('socket closed');
        } else if (!this.leaving) {
          this.events.onStatus('disconnected');
        }
      };
      this.ws.onmessage = (ev) => this.handleMessage(JSON.parse(ev.data));
    });
  }

  private signal: Signal = (type, data = {}) => {
    return new Promise((resolve, reject) => {
      const requestId = this.nextRequestId++;
      const timer = window.setTimeout(() => {
        if (!this.pendingRequests.delete(requestId)) return;
        reject(new Error(`'${type}' timed out after ${SIGNAL_TIMEOUT_MS}ms`));
      }, SIGNAL_TIMEOUT_MS);
      this.pendingRequests.set(requestId, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.ws.send(JSON.stringify({ type, requestId, ...data }));
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        reject(err as Error);
      }
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
    this.trace(`call event: ${msg.type} (${msg.name ?? msg.peerId ?? ''})`);
    if (msg.type === 'peerJoined') {
      this.peers.set(msg.peerId, { name: msg.name });
      this.emitPeers();
    } else if (msg.type === 'peerLeft') {
      this.dropPeer(msg.peerId);
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
      this.trace(`${direction} transport connection: ${state}`);
      if (direction === 'send') {
        if (state === 'connected') this.events.onStatus('on channel — carrier confirmed');
        else if (state === 'failed' || state === 'disconnected')
          this.events.onStatus(`NO CARRIER — audio not reaching the grid (${state})`);
      }
      // 'failed' is ICE's own verdict that the pair is unusable — act on it
      // rather than waiting for the byte counters to reach the same answer.
      if (state === 'failed') {
        void this.considerIceRestart(direction === 'send', direction === 'recv');
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

  /** Forget a peer and everything hanging off them. Shared by the peerLeft
   *  event and resync(), which must reach the same end state. */
  private dropPeer(peerId: string): void {
    this.peers.delete(peerId);
    const consumer = this.consumersByPeer.get(peerId);
    if (consumer) this.consumedProducers.delete(consumer.producerId);
    this.consumersByPeer.delete(peerId);
    const el = this.audioEls.get(peerId);
    if (el) {
      el.remove();
      this.audioEls.delete(peerId);
      this.blockedEls.delete(el);
    }
    const src = this.rxSources.get(peerId);
    if (src) {
      src.disconnect();
      this.rxSources.delete(peerId);
    }
  }

  /** Re-pull the room's peers and producers, then consume whatever we are
   *  missing.
   *
   *  A missed `newProducer` leaves you permanently deaf to one person with
   *  no error raised anywhere: the event fires once and is never repeated.
   *  It can be missed for many reasons — a throttled background tab, a
   *  websocket hiccup, an autoplay refusal, a bug not yet found. Rather
   *  than chase each cause, re-derive the truth from the server and repair
   *  the difference. This is the useful half of what "just rejoin" was
   *  doing, without the rejoin. */
  private async resync(reason: string): Promise<void> {
    if (this.resyncInFlight) return;
    this.resyncInFlight = true;
    try {
      const { peers } = await this.signal('sync');
      const live = new Set<string>();
      let repaired = 0;
      for (const p of peers as { peerId: string; name: string; producerIds: string[] }[]) {
        live.add(p.peerId);
        this.peers.set(p.peerId, { name: p.name });
        for (const producerId of p.producerIds) {
          if (this.consumedProducers.has(producerId)) continue;
          await this.consume(p.peerId, producerId);
          repaired++;
        }
      }
      // Anyone who left while we were not listening for it.
      let dropped = 0;
      for (const peerId of [...this.peers.keys()]) {
        if (!live.has(peerId)) {
          this.dropPeer(peerId);
          dropped++;
        }
      }
      this.emitPeers();
      this.trace(
        repaired || dropped
          ? `resync (${reason}): consumed ${repaired} missing producer(s), dropped ${dropped} stale peer(s)`
          : `resync (${reason}): already consistent`,
      );
    } catch (err) {
      this.trace(`resync (${reason}) failed: ${(err as Error)?.message ?? String(err)}`);
    } finally {
      this.resyncInFlight = false;
    }
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
    this.consumersByPeer.set(peerId, consumer);
    this.consumedProducers.add(params.producerId);
    this.trace(`consuming audio from peer ${peerId}`);

    const el = document.createElement('audio');
    el.autoplay = true;
    el.muted = this.deafened;
    const stream = new MediaStream([consumer.track]);
    el.srcObject = stream;
    document.body.appendChild(el);
    this.audioEls.set(peerId, el);
    // Autoplay is only guaranteed near a user gesture. An element created
    // long after the last tap (someone re-patching in) can be refused —
    // iPad Safari especially. Never swallow that: hold the channel, tell
    // the UI, and retry on the next tap anywhere.
    el.play().then(
      () => this.trace(`audio channel open from peer ${peerId}`),
      (err) => {
        this.trace(`audio play refused for peer ${peerId} (${(err as Error)?.name}) — held until next tap`);
        this.blockedEls.add(el);
        this.events.onAudioBlocked?.(true);
        this.armGestureRetry();
      },
    );
    if (this.audioCtx && this.rxAnalyser) {
      const src = this.audioCtx.createMediaStreamSource(stream);
      src.connect(this.rxAnalyser);
      this.rxSources.set(peerId, src);
    }
  }

  private armGestureRetry(): void {
    if (this.gestureArmed) return;
    this.gestureArmed = true;
    document.addEventListener(
      'pointerdown',
      () => {
        this.gestureArmed = false;
        const held = [...this.blockedEls];
        this.blockedEls.clear();
        for (const el of held) {
          el.play().then(
            () => this.trace('held audio channel opened by tap'),
            () => this.blockedEls.add(el),
          );
        }
        // Report once the retries settle; re-arm if any are still held.
        setTimeout(() => {
          if (this.blockedEls.size) this.armGestureRetry();
          else this.events.onAudioBlocked?.(false);
        }, 250);
      },
      { once: true },
    );
  }

  private emitPeers(): void {
    this.events.onPeerListChanged(
      [...this.peers.entries()].map(([peerId, p]) => ({ peerId, name: p.name })),
    );
  }
}
