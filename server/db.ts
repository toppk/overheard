import * as fs from 'node:fs';
import * as path from 'node:path';
import { connect } from '@tursodatabase/database';
import { config } from './config.js';
import { listArchives, readMetadata } from './archives.js';
import { transcriptionStatus } from './transcriber.js';

/**
 * Cold-storage index: Turso (embedded) with native FTS over transcripts and
 * participant handles. The filesystem stays the source of truth; this is a
 * rebuildable index for browsing and search.
 */

// Snippet markers replaced client-side after HTML-escaping (never send
// markup that could smuggle transcript content into the DOM unescaped).
export const MARK_OPEN = '\u0001';
export const MARK_CLOSE = '\u0002';

type Db = Awaited<ReturnType<typeof connect>>;
let db: Db | null = null;
let ftsAvailable = false;

export interface ArchiveRow {
  roomId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  participants: string[];
  trackCount: number;
  transcript: string;
  snippet?: string;
}

interface RecentCache {
  archives: ArchiveRow[];
  total: number;
}
let recentCache: RecentCache = { archives: [], total: 0 };

export function getRecentCached(): RecentCache {
  return recentCache;
}

export async function initDb(): Promise<void> {
  const dbPath = process.env.DB_PATH ?? 'data/overheard.db';
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = await connect(dbPath, { experimental: ['index_method'] });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS archives (
      room_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      participants_json TEXT NOT NULL,
      participants_text TEXT NOT NULL,
      track_count INTEGER NOT NULL,
      transcript_status TEXT NOT NULL,
      transcript TEXT NOT NULL DEFAULT ''
    )
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS archive_participants (
      room_id TEXT NOT NULL,
      handle TEXT NOT NULL,
      PRIMARY KEY (room_id, handle)
    )
  `);
  try {
    await db.exec(
      'CREATE INDEX IF NOT EXISTS idx_archives_fts ON archives USING fts (participants_text, transcript)',
    );
    ftsAvailable = true;
  } catch (err) {
    console.warn('[db] FTS index unavailable, falling back to LIKE search:', err);
  }
  await syncAllFromDisk();
  console.log(`[db] cold-storage index ready at ${dbPath} (fts: ${ftsAvailable})`);
}

/** Rebuild/refresh every archive row from the recordings directory. */
export async function syncAllFromDisk(): Promise<void> {
  for (const summary of listArchives()) {
    await upsertArchive(summary.roomId);
  }
  await refreshRecentCache();
}

export async function upsertArchive(roomId: string): Promise<void> {
  if (!db) return;
  const meta = readMetadata(roomId);
  if (!meta) return;
  const participants = [
    ...new Set((meta.tracks ?? []).map((t: any) => String(t.display_name))),
  ] as string[];
  const transcriptPath = path.join(
    config.recordingsDir,
    roomId,
    'transcripts',
    'conversation.md',
  );
  const transcript = fs.existsSync(transcriptPath)
    ? fs.readFileSync(transcriptPath, 'utf8')
    : '';
  const durationMs = Math.max(
    0,
    new Date(meta.ended_at).getTime() - new Date(meta.started_at).getTime(),
  );
  await (await db.prepare(
      `INSERT OR REPLACE INTO archives
       (room_id, started_at, ended_at, duration_ms, participants_json,
        participants_text, track_count, transcript_status, transcript)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )).run(
      roomId,
      meta.started_at,
      meta.ended_at,
      durationMs,
      JSON.stringify(participants),
      participants.join(' '),
      (meta.tracks ?? []).length,
      transcriptionStatus(roomId),
      transcript,
    );
  await (await db.prepare('DELETE FROM archive_participants WHERE room_id = ?')).run(roomId);
  const insertParticipant = await db.prepare(
    'INSERT OR IGNORE INTO archive_participants (room_id, handle) VALUES (?, ?)',
  );
  for (const handle of participants) {
    await insertParticipant.run(roomId, handle);
  }
  await refreshRecentCache();
}

function rowToArchive(r: any): ArchiveRow {
  return {
    roomId: r.room_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: r.duration_ms,
    participants: JSON.parse(r.participants_json),
    trackCount: r.track_count,
    transcript: r.transcript_status,
    snippet: r.snippet ?? undefined,
  };
}

async function refreshRecentCache(): Promise<void> {
  if (!db) return;
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const rows = await (await db.prepare(
      `SELECT *, NULL AS snippet FROM archives WHERE ended_at >= ? ORDER BY ended_at DESC LIMIT 100`,
    )).all(since);
  const total: any = await (await db.prepare('SELECT COUNT(*) AS c FROM archives')).get();
  recentCache = { archives: rows.map(rowToArchive), total: Number(total?.c ?? 0) };
}

export interface StorageQuery {
  q?: string;
  handles?: string[];
  sinceMs?: number; // only archives sealed within the last N ms
  minDurMs?: number;
  maxDurMs?: number;
  offset?: number;
  limit?: number;
}

export async function queryArchives(
  query: StorageQuery,
): Promise<{ total: number; rows: ArchiveRow[] }> {
  if (!db) return { total: 0, rows: [] };
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.sinceMs) {
    where.push('ended_at >= ?');
    params.push(new Date(Date.now() - query.sinceMs).toISOString());
  }
  if (query.minDurMs !== undefined) {
    where.push('duration_ms >= ?');
    params.push(query.minDurMs);
  }
  if (query.maxDurMs !== undefined) {
    where.push('duration_ms < ?');
    params.push(query.maxDurMs);
  }
  for (const handle of query.handles ?? []) {
    where.push('EXISTS (SELECT 1 FROM archive_participants ap WHERE ap.room_id = archives.room_id AND ap.handle = ?)');
    params.push(handle);
  }
  let select = '*, NULL AS snippet';
  let order = 'ended_at DESC';
  if (query.q) {
    if (ftsAvailable) {
      where.push('fts_match(participants_text, transcript, ?)');
      params.push(query.q);
      select = `*, fts_highlight(transcript, '${MARK_OPEN}', '${MARK_CLOSE}', ?) AS snippet`;
      order = 'fts_score(participants_text, transcript, ?) DESC';
    } else {
      where.push("(transcript LIKE '%' || ? || '%' OR participants_text LIKE '%' || ? || '%')");
      params.push(query.q, query.q);
    }
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(100, Math.max(1, query.limit ?? 20));
  const offset = Math.max(0, query.offset ?? 0);

  const totalRow: any = await (await db.prepare(`SELECT COUNT(*) AS c FROM archives ${whereSql}`)).get(...(params as any[]));

  // Assemble params for the select: snippet+score args wrap the WHERE args.
  const selectParams: unknown[] = [];
  if (query.q && ftsAvailable) selectParams.push(query.q); // fts_highlight
  selectParams.push(...params);
  if (query.q && ftsAvailable) selectParams.push(query.q); // fts_score in ORDER BY
  const rows = await (await db.prepare(
      `SELECT ${select} FROM archives ${whereSql} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
    )).all(...(selectParams as any[]));

  return {
    total: Number(totalRow?.c ?? 0),
    rows: rows.map((r: any) => ({ ...rowToArchive(r), snippet: makeSnippet(r.snippet) })),
  };
}

/** Cut a short window around the first highlight marker. */
function makeSnippet(highlighted: string | null): string | undefined {
  if (!highlighted) return undefined;
  const idx = highlighted.indexOf(MARK_OPEN);
  if (idx < 0) return undefined;
  const start = Math.max(0, idx - 70);
  const end = Math.min(highlighted.length, idx + 90);
  return (
    (start > 0 ? '…' : '') +
    highlighted.slice(start, end).replace(/\s+/g, ' ') +
    (end < highlighted.length ? '…' : '')
  );
}

export async function participantFacets(): Promise<{ handle: string; rooms: number }[]> {
  if (!db) return [];
  const rows = await (await db.prepare(
      `SELECT handle, COUNT(*) AS rooms FROM archive_participants
       GROUP BY handle ORDER BY rooms DESC, handle LIMIT 40`,
    )).all();
  return rows.map((r: any) => ({ handle: r.handle, rooms: Number(r.rooms) }));
}
