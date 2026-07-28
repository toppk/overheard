/**
 * Client-side activity diagnostics. Everything user-visible the app does
 * lands in the browser console with a timestamp, so a session can be
 * reconstructed by copy-pasting the console output.
 */
export function diag(...args: unknown[]): void {
  const t = new Date();
  const ts = `${t.toTimeString().slice(0, 8)}.${String(t.getMilliseconds()).padStart(3, '0')}`;
  console.log(`[overheard ${ts}]`, ...args);
}

/** Ghosts are guests, not residents: their session fades on its own. */
const GHOST_HANDLE = 'null-handle';
const GHOST_TTL_MS = 4 * 60 * 60 * 1000;

export function getHandle(): string | null {
  const expires = localStorage.getItem('overheard-ghost-expires');
  if (expires && Date.now() > Number(expires)) {
    diag('ghost session expired: burning handle');
    localStorage.removeItem('overheard-ghost-expires');
    localStorage.removeItem('overheard-name');
  }
  let name = localStorage.getItem('overheard-name');
  if (name === GHOST_HANDLE && !localStorage.getItem('overheard-ghost-expires')) {
    // A null-handle stored before ghosts had expiries (or with the expiry
    // key lost) would haunt the grid forever; burn it.
    diag('legacy ghost handle with no expiry: burning it');
    localStorage.removeItem('overheard-name');
    name = null;
  }
  diag(`localStorage read: handle = ${name === null ? 'null (not set)' : JSON.stringify(name)}`);
  return name;
}

export function setHandle(name: string): void {
  diag(`localStorage write: handle = ${JSON.stringify(name)}`);
  localStorage.setItem('overheard-name', name);
  // A named operator is not a ghost; any pending fade is void.
  localStorage.removeItem('overheard-ghost-expires');
}

export function setGhostHandle(): string {
  diag(`localStorage write: ghost handle, fades in ${GHOST_TTL_MS / 3_600_000}h`);
  localStorage.setItem('overheard-name', GHOST_HANDLE);
  localStorage.setItem('overheard-ghost-expires', String(Date.now() + GHOST_TTL_MS));
  return GHOST_HANDLE;
}

export function clearHandle(): void {
  diag('localStorage clear: handle removed');
  localStorage.removeItem('overheard-name');
  localStorage.removeItem('overheard-ghost-expires');
}
