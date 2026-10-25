import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";

import type { Env } from "../src/env";
import { cleanupCompletedNarrationPcm, cleanupNarrationPcm, tryCleanupNarrationPcm } from "../src/lib/pcmCleanup";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function setup() {
  const db = new Database(":memory:");
  databases.push(db);
  for (const migration of ["001_initial", "002_publication_branded_artwork", "003_durable_narration", "004_pcm_cleanup"]) {
    db.exec(readFileSync(new URL(`../../api/schema/${migration}.sql`, import.meta.url), "utf8"));
  }
  db.run("INSERT INTO publications (id,source_url,feed_url,normalized_url,url_hash,slug) VALUES (1,'s','f','n','h','slug')");
  const objects = new Map<string, number>();
  const deleted: string[] = [];
  let deleteCalls = 0;
  let failDeleteCall = -1;
  const env = {
    DB: {
      prepare(sql: string) {
        let values: (string | number | null)[] = [];
        return {
          bind(...args: typeof values) { values = args; return this; },
          async first() { return db.query(sql).get(...values); },
          async all() { return { results: db.query(sql).all(...values) }; },
          async run() { return db.query(sql).run(...values); }
        };
      }
    },
    AUDIO_BUCKET: {
      async head(key: string) { return objects.has(key) ? { size: objects.get(key) } : null; },
      async delete(keys: string[]) {
        deleteCalls++;
        if (deleteCalls === failDeleteCall) throw new Error("R2 temporarily unavailable");
        for (const key of keys) { objects.delete(key); deleted.push(key); }
      }
    }
  } as unknown as Env;
  function seed(id = "job", status = "succeeded", count = 2) {
    const postId = Number(db.query("SELECT count(*) AS count FROM posts").get()!.count) + 1;
    const audioKey = `episodes/1/${postId}.mp3`;
    db.run("INSERT INTO posts (id,publication_id,post_key,status,narration_job_id,audio_key) VALUES (?1,1,?2,'ready',?2,?3)", [postId,id,audioKey]);
    db.run(`INSERT INTO narration_jobs (id,post_id,publication_id,provider,model,voice,status,total_chunks,completed_chunks)
      VALUES (?1,?2,1,'fish_audio','model','voice',?3,?4,?4)`, [id,postId,status,count]);
    objects.set(audioKey, 1000);
    for (let i = 0; i < count; i++) {
      const key = `narration-chunks/${id}/${i}.pcm`;
      db.run(`INSERT INTO narration_chunks (narration_job_id,chunk_index,chunk_key,label,text,r2_key,status)
        VALUES (?1,?2,'chunk','label','text',?3,'succeeded')`, [id,i,key]);
      objects.set(key, 100);
    }
    return audioKey;
  }
  const cleaned = (id = "job") => db.query("SELECT pcm_cleaned_at FROM narration_jobs WHERE id=?1").get(id)!.pcm_cleaned_at;
  return { db, env, objects, deleted, seed, cleaned, failOnDelete: (call: number) => { failDeleteCall = call; } };
}

test("deletes completed PCM once, preserving MP3 and narration metadata", async () => {
  const f = setup();
  const mp3 = f.seed();
  expect(await cleanupNarrationPcm(f.env, "job")).toBe(2);
  expect(f.objects.has(mp3)).toBe(true);
  expect(f.objects.size).toBe(1);
  expect(f.cleaned()).not.toBeNull();
  expect(f.db.query("SELECT count(*) AS count FROM narration_chunks").get()!.count).toBe(2);
  expect(await cleanupNarrationPcm(f.env, "job")).toBe(0);
  expect(f.deleted.length).toBe(2);
});

test("keeps recovery chunks for queued, running, assembling, and failed narrations", async () => {
  const f = setup();
  for (const status of ["queued", "running", "assembling", "failed"]) f.seed(status, status);
  await cleanupCompletedNarrationPcm(f.env);
  for (const status of ["queued", "running", "assembling", "failed"]) expect(await cleanupNarrationPcm(f.env, status)).toBe(0);
  expect(f.deleted).toEqual([]);
});

test("requires a saved nonempty final MP3 and ready post", async () => {
  const f = setup();
  const mp3 = f.seed();
  f.objects.delete(mp3);
  expect(await cleanupNarrationPcm(f.env, "job")).toBe(0);
  f.objects.set(mp3, 0);
  expect(await cleanupNarrationPcm(f.env, "job")).toBe(0);
  f.objects.set(mp3, 1000);
  f.db.run("UPDATE posts SET status='narrating'");
  expect(await cleanupNarrationPcm(f.env, "job")).toBe(0);
  expect(f.deleted).toEqual([]);
  expect(f.cleaned()).toBeNull();
});

test("retries partial deletion without changing successful narration state", async () => {
  const f = setup();
  const mp3 = f.seed("job", "succeeded", 101);
  f.failOnDelete(2);
  const log = spyOn(console, "warn").mockImplementation(() => {});
  try { await tryCleanupNarrationPcm(f.env, "job"); } finally { log.mockRestore(); }
  expect(f.cleaned()).toBeNull();
  expect(f.db.query("SELECT status FROM narration_jobs").get()!.status).toBe("succeeded");
  expect(f.objects.size).toBe(2);
  await cleanupCompletedNarrationPcm(f.env);
  expect(f.cleaned()).not.toBeNull();
  expect(f.objects.size).toBe(1);
  expect(f.objects.has(mp3)).toBe(true);
});

test("never deletes an unexpected object key in a chunk manifest", async () => {
  const f = setup();
  const mp3 = f.seed();
  f.db.run("UPDATE narration_chunks SET r2_key=?1 WHERE chunk_index=0", [mp3]);
  await expect(cleanupNarrationPcm(f.env, "job")).rejects.toThrow("Unexpected PCM key");
  expect(f.deleted).toEqual([]);
  expect(f.objects.has(mp3)).toBe(true);
});

test("bounds each scheduled run and progresses past missing outputs", async () => {
  const f = setup();
  for (let i = 0; i < 12; i++) {
    const key = f.seed(`job-${String(i).padStart(2, "0")}`);
    if (i < 10) f.objects.delete(key);
  }
  await cleanupCompletedNarrationPcm(f.env);
  expect(f.deleted.length).toBe(0);
  await cleanupCompletedNarrationPcm(f.env);
  expect(f.deleted.length).toBe(4);
});
