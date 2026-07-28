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

// 'overheard-name' is the logged-in operator identity; the preferred
// default name offered by the login form lives separately in
// 'overheard-last-handle'. Keep that split — the pending ACL scheme
// (TODO.md) hangs permissions off the identity, not the convenience.

export function getHandle(): string | null {
  let name = localStorage.getItem('overheard-name');
  if (name === 'null-handle') {
    // Leftover from the short-lived ghost-session experiment: an unnamed
    // session is no longer a valid identity.
    diag('legacy ghost handle: burning it');
    localStorage.removeItem('overheard-name');
    localStorage.removeItem('overheard-ghost-expires');
    name = null;
  }
  diag(`localStorage read: handle = ${name === null ? 'null (not set)' : JSON.stringify(name)}`);
  return name;
}

export function setHandle(name: string): void {
  diag(`localStorage write: handle = ${JSON.stringify(name)}`);
  localStorage.setItem('overheard-name', name);
}

export function clearHandle(): void {
  diag('localStorage clear: handle removed');
  localStorage.removeItem('overheard-name');
}
