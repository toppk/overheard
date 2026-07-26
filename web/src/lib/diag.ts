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

export function getHandle(): string | null {
  const name = localStorage.getItem('overheard-name');
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
