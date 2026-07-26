import * as fs from 'node:fs';
import * as path from 'node:path';
import { config } from './config.js';
import { transcriptionStatus } from './transcriber.js';

export interface ArchiveSummary {
  roomId: string;
  startedAt: string;
  endedAt: string;
  participants: string[];
  trackCount: number;
  transcript: 'none' | 'running' | 'done' | 'failed';
}

/** A room is sealed forever once its metadata.json exists on disk. */
export function isSealed(roomId: string): boolean {
  return fs.existsSync(path.join(config.recordingsDir, roomId, 'metadata.json'));
}

export function readMetadata(roomId: string): any | null {
  const p = path.join(config.recordingsDir, roomId, 'metadata.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function listArchives(): ArchiveSummary[] {
  if (!fs.existsSync(config.recordingsDir)) return [];
  const archives: ArchiveSummary[] = [];
  for (const entry of fs.readdirSync(config.recordingsDir)) {
    const meta = readMetadata(entry);
    if (!meta) continue;
    archives.push({
      roomId: meta.room_id ?? entry,
      startedAt: meta.started_at,
      endedAt: meta.ended_at,
      participants: [...new Set((meta.tracks ?? []).map((t: any) => String(t.display_name)))] as string[],
      trackCount: (meta.tracks ?? []).length,
      transcript: transcriptionStatus(entry),
    });
  }
  archives.sort((a, b) => (a.endedAt < b.endedAt ? 1 : -1));
  return archives;
}
