import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from './config.js';

type Status = 'none' | 'running' | 'done' | 'failed';

const active = new Map<string, Status>();

function pythonBin(): string {
  const venv = path.resolve('.venv/bin/python');
  return fs.existsSync(venv) ? venv : 'python3';
}

export function transcriptionStatus(roomId: string): Status {
  const inMemory = active.get(roomId);
  if (inMemory === 'running' || inMemory === 'failed') return inMemory;
  const done = fs.existsSync(
    path.join(config.recordingsDir, roomId, 'transcripts', 'conversation.md'),
  );
  return done ? 'done' : 'none';
}

/**
 * Kick off offline transcription for a sealed room. Fire-and-forget; the
 * scribe works in the background and must never affect live calls.
 */
export function transcribeRoom(
  roomId: string,
  onFinished: (status: 'done' | 'failed') => void,
): boolean {
  if (process.env.TRANSCRIBE_DISABLED) return false;
  if (active.get(roomId) === 'running') return false;
  const roomDir = path.join(config.recordingsDir, roomId);
  const meta = path.join(roomDir, 'metadata.json');
  if (!fs.existsSync(meta)) return false;
  const model = process.env.TRANSCRIBE_MODEL ?? 'small';

  active.set(roomId, 'running');
  const logPath = path.join(roomDir, 'transcribe.log');
  const log = fs.openSync(logPath, 'w');
  const child = spawn(
    pythonBin(),
    ['transcription/transcribe.py', roomDir, '--model', model],
    { stdio: ['ignore', log, log] },
  );
  console.log(`[scribe] started for ${roomId} (model=${model}, pid=${child.pid})`);
  child.on('exit', (code) => {
    fs.closeSync(log);
    const status = code === 0 ? 'done' : 'failed';
    active.set(roomId, status);
    console.log(`[scribe] ${roomId}: ${status} (exit ${code}); log at ${logPath}`);
    onFinished(status);
  });
  child.on('error', (err) => {
    active.set(roomId, 'failed');
    console.error(`[scribe] ${roomId}: failed to spawn:`, err);
    onFinished('failed');
  });
  return true;
}
