/**
 * SEGV/SIGABRT reproducer for neug native addon.
 *
 * Root cause: neug's napi_register_module_v1 calls InitGoogleLogging()
 * unconditionally. glog is process-global — the second worker thread that
 * loads the addon hits "Check failed: !IsGoogleLoggingInitialized()" and aborts.
 *
 * This is the exact failure mode in vitest (thread pool) and any Node.js
 * worker_threads usage.
 *
 * Run: arch -arm64 node neug-segv-repro.js
 * Expected: all workers complete. Actual: worker 1 aborts.
 */
const { Worker, isMainThread, workerData } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (isMainThread) {
  let completed = 0;
  const total = 3;
  function spawnNext() {
    if (completed >= total) {
      console.log(`All ${total} workers done.`);
      return;
    }
    const w = new Worker(__filename, { workerData: { id: completed } });
    w.on('message', (msg) => console.log(msg));
    w.on('error', (err) => console.error('Worker error:', err.message));
    w.on('exit', (code) => {
      if (code !== 0) console.error(`Worker ${completed} crashed (code ${code})`);
      completed++;
      spawnNext();
    });
  }
  spawnNext();
} else {
  const neug = require('neug');
  const id = workerData.id;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `neug-repro-${id}-`));
  const dbPath = path.join(tmpDir, 'test.neug');
  const db = new neug.Database({ databasePath: dbPath, mode: 'w' });
  const conn = db.connect();
  conn.execute('CREATE NODE TABLE IF NOT EXISTS T (id STRING, PRIMARY KEY(id))');
  conn.execute("CREATE (:T {id: 'x'})");
  conn.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  require('worker_threads').parentPort.postMessage(`worker ${id}: ok`);
}
