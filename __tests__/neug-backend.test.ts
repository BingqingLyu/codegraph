/**
 * NeuG Backend — tests using the real neug native package.
 *
 * Verifies NeuGQueryBuilder's CRUD operations, search, and graph traversal
 * against a real NeuG database. Skipped when the neug package is not installed
 * or when running on a non-ARM64 architecture.
 *
 * Run directly:
 *   arch -arm64 npx tsx __tests__/neug-backend.test.ts
 *
 * Or via npm:
 *   npm run test:neug
 *
 * NOTE: Cannot run through vitest because neug's C++ runtime SEGVs on
 * process exit, which vitest's worker pool treats as a crash.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ─── Minimal test harness ────────────────────────────────────

let _passed = 0;
let _failed = 0;
let _skipped = 0;
const _errors: string[] = [];

function describe(name: string, fn: () => void | Promise<void>): void {
  console.log(`\n  ${name}`);
  // Execute synchronously — nested describes are immediate
  const result = fn();
  if (result && typeof (result as any).then === 'function') {
    throw new Error('Top-level describe must be sync');
  }
}

interface TestContext {
  qb: any;
  beforeEachFns: (() => void)[];
}

let _ctx: TestContext;
let _beforeEachFns: (() => void)[] = [];

function beforeEach(fn: () => void): void {
  _beforeEachFns.push(fn);
}

function it(name: string, fn: () => void | Promise<void>): void {
  for (const bef of _beforeEachFns) bef();
  try {
    const result = fn();
    if (result && typeof (result as any).then === 'function') {
      throw new Error('Async tests not supported in this harness');
    }
    _passed++;
    console.log(`    ✓ ${name}`);
  } catch (e: any) {
    _failed++;
    const msg = e?.message ?? String(e);
    _errors.push(`${name}: ${msg}`);
    console.log(`    ✗ ${name} — ${msg}`);
  }
}

function expect(actual: any) {
  return {
    toBe(expected: any) {
      if (actual !== expected)
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    toEqual(expected: any) {
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    toBeNull() {
      if (actual !== null)
        throw new Error(`Expected null, got ${JSON.stringify(actual)}`);
    },
    not: {
      toBeNull() {
        if (actual === null)
          throw new Error(`Expected non-null, got null`);
      },
    },
    toBeGreaterThanOrEqual(n: number) {
      if (actual < n)
        throw new Error(`Expected >= ${n}, got ${actual}`);
    },
    toContain(item: any) {
      if (!Array.isArray(actual) || !actual.includes(item))
        throw new Error(`Expected array to contain ${JSON.stringify(item)}`);
    },
  };
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  let neug: any;
  try {
    neug = require('neug');
  } catch {
    console.log('\n  ⚠ neug package not installed — skipping all tests\n');
    process.exit(0);
  }

  if (process.arch !== 'arm64') {
    console.log(`\n  ⚠ neug requires ARM64, current arch is ${process.arch} — skipping\n`);
    console.log('    Hint: run with "arch -arm64 npx tsx __tests__/neug-backend.test.ts"\n');
    process.exit(0);
  }

  const { NeuGQueryBuilder, NeuGConnectionWrapper } = await import('../src/db/neug-backend');

  console.log('\nNeuG Backend Tests (real neug package)\n');

  // Single DB instance to avoid SEGV from repeated open/close
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neug-test-'));
  const dbPath = path.join(tmpDir, 'test.neug');
  const db = new neug.Database({ databasePath: dbPath, mode: 'w' });
  const conn = db.connect();
  const wrapper = new NeuGConnectionWrapper(conn);
  const qb = new NeuGQueryBuilder(wrapper);
  qb.initSchema();

  type Node = Parameters<typeof qb.insertNode>[0];
  const mkNode = (overrides: Partial<Node> & { id: string; name: string }): Node => ({
    kind: 'function',
    filePath: '/src/app.ts',
    language: 'typescript',
    ...overrides,
  } as Node);

  const clearAll = () => { qb.clear(); qb.clearCache(); };

  // ── Node CRUD ────────────────────────────────────────────

  describe('Node operations', () => {
    _beforeEachFns = [clearAll];

    it('insertNode + getNodeById round-trips correctly', () => {
      qb.insertNode(mkNode({ id: 'fn::myFunc', name: 'myFunc' }));
      const found = qb.getNodeById('fn::myFunc');
      expect(found).not.toBeNull();
      expect(found!.id).toBe('fn::myFunc');
      expect(found!.kind).toBe('function');
      expect(found!.name).toBe('myFunc');
      expect(found!.filePath).toBe('/src/app.ts');
    });

    it('insertNode upserts without duplicating (MERGE)', () => {
      qb.insertNode(mkNode({ id: 'fn::a', name: 'v1' }));
      qb.insertNode(mkNode({ id: 'fn::a', name: 'v2' }));
      expect(qb.getNodeById('fn::a')!.name).toBe('v2');
      expect(qb.getAllNodes().length).toBe(1);
    });

    it('insertNode preserves edges on upsert', () => {
      qb.insertNode(mkNode({ id: 'fn::a', name: 'a' }));
      qb.insertNode(mkNode({ id: 'fn::b', name: 'b' }));
      qb.insertEdge({ source: 'fn::a', target: 'fn::b', kind: 'calls' });
      qb.insertNode(mkNode({ id: 'fn::a', name: 'a_updated' }));
      const edges = qb.getOutgoingEdges('fn::a');
      expect(edges.length).toBe(1);
      expect(edges[0].target).toBe('fn::b');
    });

    it('getNodeById returns null for missing node', () => {
      expect(qb.getNodeById('nonexistent')).toBeNull();
    });

    it('getNodesByIds returns a Map of found nodes', () => {
      qb.insertNode(mkNode({ id: 'fn::a', name: 'a' }));
      qb.insertNode(mkNode({ id: 'fn::b', name: 'b' }));
      const result = qb.getNodesByIds(['fn::a', 'fn::b', 'missing']);
      expect(result.size).toBe(2);
      expect(result.get('fn::a')!.name).toBe('a');
    });

    it('getNodesByFile returns nodes in a given file', () => {
      qb.insertNode(mkNode({ id: 'fn::a', name: 'a' }));
      qb.insertNode(mkNode({ id: 'fn::b', name: 'b', filePath: '/src/other.ts' }));
      qb.insertNode(mkNode({ id: 'fn::c', name: 'c' }));
      expect(qb.getNodesByFile('/src/app.ts').length).toBe(2);
    });

    it('getNodesByKind filters by kind', () => {
      qb.insertNode(mkNode({ id: 'fn::a', name: 'a', kind: 'function' }));
      qb.insertNode(mkNode({ id: 'cls::B', name: 'B', kind: 'class' }));
      expect(qb.getNodesByKind('function').length).toBe(1);
      expect(qb.getNodesByKind('class').length).toBe(1);
    });

    it('deleteNode removes node', () => {
      qb.insertNode(mkNode({ id: 'fn::a', name: 'a' }));
      qb.deleteNode('fn::a');
      expect(qb.getNodeById('fn::a')).toBeNull();
    });

    it('deleteNodesByFile removes all nodes in a file', () => {
      qb.insertNode(mkNode({ id: 'fn::a', name: 'a', filePath: '/x.ts' }));
      qb.insertNode(mkNode({ id: 'fn::b', name: 'b', filePath: '/x.ts' }));
      qb.insertNode(mkNode({ id: 'fn::c', name: 'c', filePath: '/y.ts' }));
      qb.deleteNodesByFile('/x.ts');
      expect(qb.getNodesByFile('/x.ts').length).toBe(0);
      expect(qb.getNodeById('fn::c')).not.toBeNull();
    });
  });

  // ── Edge CRUD ────────────────────────────────────────────

  describe('Edge operations', () => {
    _beforeEachFns = [clearAll, () => {
      qb.insertNode(mkNode({ id: 'fn::a', name: 'a' }));
      qb.insertNode(mkNode({ id: 'fn::b', name: 'b' }));
    }];

    it('insertEdge + getOutgoingEdges', () => {
      qb.insertEdge({ source: 'fn::a', target: 'fn::b', kind: 'calls' });
      const out = qb.getOutgoingEdges('fn::a');
      expect(out.length).toBe(1);
      expect(out[0].source).toBe('fn::a');
      expect(out[0].target).toBe('fn::b');
      expect(out[0].kind).toBe('calls');
    });

    it('getIncomingEdges', () => {
      qb.insertEdge({ source: 'fn::a', target: 'fn::b', kind: 'calls' });
      expect(qb.getIncomingEdges('fn::b').length).toBe(1);
      expect(qb.getIncomingEdges('fn::b')[0].source).toBe('fn::a');
    });

    it('getOutgoingEdges filters by kind', () => {
      qb.insertEdge({ source: 'fn::a', target: 'fn::b', kind: 'calls' });
      qb.insertEdge({ source: 'fn::a', target: 'fn::b', kind: 'references' });
      expect(qb.getOutgoingEdges('fn::a', ['calls']).length).toBe(1);
    });

    it('deleteEdgesBySource removes all edges', () => {
      qb.insertEdge({ source: 'fn::a', target: 'fn::b', kind: 'calls' });
      qb.insertEdge({ source: 'fn::a', target: 'fn::b', kind: 'references' });
      qb.deleteEdgesBySource('fn::a');
      expect(qb.getOutgoingEdges('fn::a').length).toBe(0);
    });

    it('findEdgesBetweenNodes returns edges within a set', () => {
      qb.insertNode(mkNode({ id: 'fn::c', name: 'c' }));
      qb.insertEdge({ source: 'fn::a', target: 'fn::b', kind: 'calls' });
      qb.insertEdge({ source: 'fn::b', target: 'fn::c', kind: 'calls' });
      const edges = qb.findEdgesBetweenNodes(['fn::a', 'fn::b']);
      expect(edges.length).toBe(1);
      expect(edges[0].source).toBe('fn::a');
    });
  });

  // ── File operations ──────────────────────────────────────

  describe('File operations', () => {
    _beforeEachFns = [clearAll];

    it('upsertFile + getFileByPath', () => {
      qb.upsertFile({ path: '/a.ts', contentHash: 'abc', language: 'typescript', size: 1024, modifiedAt: 1000, indexedAt: 2000, nodeCount: 5 });
      const f = qb.getFileByPath('/a.ts');
      expect(f).not.toBeNull();
      expect(f!.contentHash).toBe('abc');
      expect(f!.nodeCount).toBe(5);
    });

    it('upsertFile updates existing file (MERGE)', () => {
      qb.upsertFile({ path: '/a.ts', contentHash: 'v1', language: 'typescript', size: 100, modifiedAt: 1, indexedAt: 1, nodeCount: 1 });
      qb.upsertFile({ path: '/a.ts', contentHash: 'v2', language: 'typescript', size: 200, modifiedAt: 2, indexedAt: 2, nodeCount: 3 });
      expect(qb.getAllFiles().length).toBe(1);
      expect(qb.getAllFiles()[0].contentHash).toBe('v2');
    });

    it('getAllFiles returns all indexed files', () => {
      qb.upsertFile({ path: '/a.ts', contentHash: 'a', language: 'typescript', size: 100, modifiedAt: 1, indexedAt: 1, nodeCount: 1 });
      qb.upsertFile({ path: '/b.ts', contentHash: 'b', language: 'typescript', size: 200, modifiedAt: 2, indexedAt: 2, nodeCount: 2 });
      expect(qb.getAllFiles().length).toBe(2);
    });

    it('deleteFile removes file and its nodes', () => {
      qb.upsertFile({ path: '/a.ts', contentHash: 'a', language: 'typescript', size: 100, modifiedAt: 1, indexedAt: 1, nodeCount: 1 });
      qb.insertNode(mkNode({ id: 'fn::x', name: 'x', filePath: '/a.ts' }));
      qb.deleteFile('/a.ts');
      expect(qb.getFileByPath('/a.ts')).toBeNull();
      expect(qb.getNodesByFile('/a.ts').length).toBe(0);
    });

    it('getAllFilePaths returns sorted paths', () => {
      qb.upsertFile({ path: '/b.ts', contentHash: 'b', language: 'typescript', size: 1, modifiedAt: 1, indexedAt: 1, nodeCount: 0 });
      qb.upsertFile({ path: '/a.ts', contentHash: 'a', language: 'typescript', size: 1, modifiedAt: 1, indexedAt: 1, nodeCount: 0 });
      expect(qb.getAllFilePaths()).toEqual(['/a.ts', '/b.ts']);
    });
  });

  // ── Metadata ─────────────────────────────────────────────

  describe('Metadata operations', () => {
    _beforeEachFns = [clearAll];

    it('setMetadata + getMetadata', () => {
      qb.setMetadata('backend', 'neug');
      expect(qb.getMetadata('backend')).toBe('neug');
    });

    it('setMetadata upserts (MERGE)', () => {
      qb.setMetadata('key', 'v1');
      qb.setMetadata('key', 'v2');
      expect(qb.getMetadata('key')).toBe('v2');
    });

    it('getMetadata returns null for missing key', () => {
      expect(qb.getMetadata('nonexistent')).toBeNull();
    });

    it('getAllMetadata returns all entries', () => {
      qb.setMetadata('backend', 'neug');
      qb.setMetadata('version', '1.0');
      const all = qb.getAllMetadata();
      expect(all.backend).toBe('neug');
      expect(all.version).toBe('1.0');
    });
  });

  // ── Unresolved References ────────────────────────────────

  describe('Unresolved references', () => {
    _beforeEachFns = [clearAll];

    it('insertUnresolvedRef + getUnresolvedReferences', () => {
      qb.insertUnresolvedRef({
        fromNodeId: 'fn::a', referenceName: 'unknownFn', referenceKind: 'calls',
        line: 10, column: 5, filePath: '/a.ts', language: 'typescript',
      });
      const refs = qb.getUnresolvedReferences();
      expect(refs.length).toBe(1);
      expect(refs[0].referenceName).toBe('unknownFn');
    });

    it('getUnresolvedReferencesCount', () => {
      qb.insertUnresolvedRef({ fromNodeId: 'fn::a', referenceName: 'x', referenceKind: 'calls', line: 1, column: 0 });
      qb.insertUnresolvedRef({ fromNodeId: 'fn::b', referenceName: 'y', referenceKind: 'calls', line: 2, column: 0 });
      expect(qb.getUnresolvedReferencesCount()).toBe(2);
    });

    it('clearUnresolvedReferences removes all', () => {
      qb.insertUnresolvedRef({ fromNodeId: 'fn::a', referenceName: 'x', referenceKind: 'calls', line: 1, column: 0 });
      qb.clearUnresolvedReferences();
      expect(qb.getUnresolvedReferencesCount()).toBe(0);
    });
  });

  // ── Stats ────────────────────────────────────────────────

  describe('getStats', () => {
    _beforeEachFns = [clearAll];

    it('returns correct counts and breakdowns', () => {
      qb.insertNode(mkNode({ id: 'fn::a', name: 'a', kind: 'function' }));
      qb.insertNode(mkNode({ id: 'cls::B', name: 'B', kind: 'class' }));
      qb.insertEdge({ source: 'fn::a', target: 'cls::B', kind: 'references' });
      qb.upsertFile({ path: '/a.ts', contentHash: 'a', language: 'typescript', size: 100, modifiedAt: 1, indexedAt: 1, nodeCount: 1 });
      const stats = qb.getStats();
      expect(stats.nodeCount).toBe(2);
      expect(stats.edgeCount).toBe(1);
      expect(stats.fileCount).toBe(1);
      expect(stats.nodesByKind.function).toBe(1);
      expect(stats.nodesByKind.class).toBe(1);
      expect(stats.edgesByKind.references).toBe(1);
    });
  });

  // ── Search ───────────────────────────────────────────────

  describe('searchNodes', () => {
    _beforeEachFns = [clearAll, () => {
      qb.insertNode(mkNode({ id: 'fn::handleRequest', name: 'handleRequest', filePath: '/src/server.ts' }));
      qb.insertNode(mkNode({ id: 'fn::handleError', name: 'handleError', filePath: '/src/errors.ts' }));
      qb.insertNode(mkNode({ id: 'cls::Handler', name: 'Handler', kind: 'class', filePath: '/src/handler.ts' }));
    }];

    it('finds nodes by name substring (CONTAINS)', () => {
      const results = qb.searchNodes('handle');
      expect(results.length).toBeGreaterThanOrEqual(2);
      const names = results.map((r: any) => r.node.name);
      expect(names).toContain('handleRequest');
      expect(names).toContain('handleError');
    });

    it('respects kind filter', () => {
      const results = qb.searchNodes('Handle', { kinds: ['class'] });
      expect(results.length).toBe(1);
      expect(results[0].node.kind).toBe('class');
    });
  });

  // ── Clear ────────────────────────────────────────────────

  describe('clear', () => {
    _beforeEachFns = [];

    it('removes all nodes, files, and unresolved refs', () => {
      qb.insertNode(mkNode({ id: 'fn::a', name: 'a' }));
      qb.upsertFile({ path: '/a.ts', contentHash: 'a', language: 'typescript', size: 100, modifiedAt: 1, indexedAt: 1, nodeCount: 1 });
      qb.insertUnresolvedRef({ fromNodeId: 'fn::a', referenceName: 'x', referenceKind: 'calls', line: 1, column: 0 });
      qb.clear();
      expect(qb.getAllNodes().length).toBe(0);
      expect(qb.getAllFiles().length).toBe(0);
      expect(qb.getUnresolvedReferencesCount()).toBe(0);
    });
  });

  // ── GraphTraverser ───────────────────────────────────────

  describe('GraphTraverser integration', () => {
    _beforeEachFns = [clearAll];

    it('BFS traversal works across call chain', () => {
      qb.insertNode(mkNode({ id: 'fn::a', name: 'a' }));
      qb.insertNode(mkNode({ id: 'fn::b', name: 'b' }));
      qb.insertNode(mkNode({ id: 'fn::c', name: 'c' }));
      qb.insertEdge({ source: 'fn::a', target: 'fn::b', kind: 'calls' });
      qb.insertEdge({ source: 'fn::b', target: 'fn::c', kind: 'calls' });

      const { GraphTraverser } = require('../src/graph/traversal');
      const traverser = new GraphTraverser(qb as any);
      const result = traverser.traverseBFS('fn::a', { maxDepth: 3 });
      expect(result.nodes.size).toBe(3);
      expect(result.edges.length).toBe(2);
    });

    it('getCallers works', () => {
      qb.insertNode(mkNode({ id: 'fn::a', name: 'a' }));
      qb.insertNode(mkNode({ id: 'fn::b', name: 'b' }));
      qb.insertEdge({ source: 'fn::a', target: 'fn::b', kind: 'calls' });

      const { GraphTraverser } = require('../src/graph/traversal');
      const traverser = new GraphTraverser(qb as any);
      const callers = traverser.getCallers('fn::b');
      expect(callers.length).toBe(1);
      expect(callers[0].node.id).toBe('fn::a');
    });
  });

  // ── New methods (getNodeAndEdgeCount, findByName, executeCypher) ──

  describe('getNodeAndEdgeCount', () => {
    it('returns correct counts', () => {
      qb.insertNode(mkNode({ id: 'fn::count1', name: 'count1' }));
      qb.insertNode(mkNode({ id: 'fn::count2', name: 'count2' }));
      qb.insertEdge({ source: 'fn::count1', target: 'fn::count2', kind: 'calls' });

      const counts = qb.getNodeAndEdgeCount();
      expect(counts.nodes).toBeGreaterThanOrEqual(2);
      expect(counts.edges).toBeGreaterThanOrEqual(1);
    });
  });

  describe('findNodesByExactName', () => {
    it('finds nodes by exact name match', () => {
      qb.insertNode(mkNode({ id: 'fn::exactA', name: 'exactAlpha' }));
      qb.insertNode(mkNode({ id: 'fn::exactB', name: 'exactBeta' }));

      const results = qb.findNodesByExactName(['exactAlpha']);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r: any) => r.node.name === 'exactAlpha')).toBe(true);
    });

    it('returns empty for non-existent names', () => {
      const results = qb.findNodesByExactName(['nonExistentXYZ123']);
      expect(results.length).toBe(0);
    });
  });

  describe('findNodesByNameSubstring', () => {
    it('finds nodes by substring', () => {
      qb.insertNode(mkNode({ id: 'fn::subFoo', name: 'mySubstringFoo' }));

      const results = qb.findNodesByNameSubstring('SubstringFoo');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r: any) => r.node.name === 'mySubstringFoo')).toBe(true);
    });

    it('returns empty for non-matching substring', () => {
      const results = qb.findNodesByNameSubstring('zzzzNonExistent999');
      expect(results.length).toBe(0);
    });
  });

  describe('executeCypher', () => {
    it('executes raw Cypher and returns rows', () => {
      qb.insertNode(mkNode({ id: 'fn::cypRaw', name: 'cypherRawTest' }));

      const rows = qb.executeCypher("MATCH (n:CodeNode {name: 'cypherRawTest'}) RETURN n.name");
      expect(rows.length).toBe(1);
      expect(rows[0][0]).toBe('cypherRawTest');
    });

    it('returns empty for no-match query', () => {
      const rows = qb.executeCypher("MATCH (n:CodeNode {name: 'doesNotExist999'}) RETURN n.name");
      expect(rows.length).toBe(0);
    });
  });

  // ── Summary ──────────────────────────────────────────────

  console.log(`\n  ${_passed} passed, ${_failed} failed`);
  if (_errors.length > 0) {
    console.log('\n  Failures:');
    for (const e of _errors) console.log(`    - ${e}`);
  }
  console.log('');

  // Cleanup
  try { conn.close(); } catch {}
  try { db.close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // Exit before C++ destructors run (neug SEGVs on process.exit otherwise)
  process.exit(_failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
