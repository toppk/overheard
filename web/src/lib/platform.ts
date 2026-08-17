/**
 * A coarse description of what the caller is running on, for the server log.
 *
 * The point is to make "this only ever happens on iPadOS Safari" a question
 * the log can answer, instead of something you reconstruct from memory days
 * later. Deliberately NOT a fingerprint: major versions only, no full UA
 * string, no screen metrics, no device labels, nothing that distinguishes
 * two people running the same OS and browser.
 */
export function describePlatform(): string {
  const ua = navigator.userAgent;
  const touch = navigator.maxTouchPoints ?? 0;
  const major = (re: RegExp): string => ua.match(re)?.[1] ?? '';

  let os = 'unknown OS';
  let form = 'desktop';
  const appleVer = (): string => {
    const m = ua.match(/OS (\d+)[._](\d+)/);
    return m ? ` ${m[1]}.${m[2]}` : '';
  };

  if (/iPhone/.test(ua)) {
    os = `iOS${appleVer()}`;
    form = 'phone';
  } else if (/iPad/.test(ua)) {
    os = `iPadOS${appleVer()}`;
    form = 'tablet';
  } else if (/Macintosh/.test(ua) && touch > 1) {
    // iPadOS 13+ Safari claims to be a Mac by default. Touch points are what
    // give it away, and the distinction matters: the audio-session and
    // capture-lifecycle bugs are iPad ones, not Mac ones.
    os = 'iPadOS (mac-mode UA)';
    form = 'tablet';
  } else if (/Macintosh|Mac OS X/.test(ua)) {
    const m = ua.match(/Mac OS X (\d+)[._](\d+)/);
    os = m ? `macOS ${m[1]}.${m[2]}` : 'macOS';
  } else if (/Android/.test(ua)) {
    os = `Android ${major(/Android (\d+)/)}`.trim();
    form = /Mobile/.test(ua) ? 'phone' : 'tablet';
  } else if (/Windows NT/.test(ua)) {
    os = `Windows NT ${major(/Windows NT ([\d.]+)/)}`.trim();
  } else if (/Linux|X11/.test(ua)) {
    os = 'Linux';
  }

  // Order matters: several browsers carry the others' tokens on purpose.
  let browser = 'unknown browser';
  if (/Edg\//.test(ua)) browser = `Edge ${major(/Edg\/(\d+)/)}`;
  else if (/OPR\//.test(ua)) browser = `Opera ${major(/OPR\/(\d+)/)}`;
  else if (/Firefox\//.test(ua)) browser = `Firefox ${major(/Firefox\/(\d+)/)}`;
  // On iOS every browser is WebKit underneath, which is why an "it works in
  // Chrome" report from an iPhone means nothing — say so in the log.
  else if (/CriOS\//.test(ua)) browser = `Chrome ${major(/CriOS\/(\d+)/)} (iOS WebKit)`;
  else if (/FxiOS\//.test(ua)) browser = `Firefox ${major(/FxiOS\/(\d+)/)} (iOS WebKit)`;
  else if (/EdgiOS\//.test(ua)) browser = `Edge ${major(/EdgiOS\/(\d+)/)} (iOS WebKit)`;
  else if (/Chrome\//.test(ua)) browser = `Chrome ${major(/Chrome\/(\d+)/)}`;
  else if (/Version\/[\d.]+.*Safari/.test(ua)) browser = `Safari ${major(/Version\/(\d+)/)}`;
  else if (/Safari\//.test(ua)) browser = 'Safari';

  // Brave ships a Chrome UA; this object is the only cheap tell.
  if ((navigator as { brave?: unknown }).brave) browser = `Brave (${browser})`;

  const bits = [os, browser, form];
  // Installed-to-homescreen changes audio and lifecycle behaviour on iOS
  // enough that a bug report without it is ambiguous.
  if (window.matchMedia?.('(display-mode: standalone)')?.matches) bits.push('standalone');
  return bits.join(' · ');
}
