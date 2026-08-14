# Ticket 5 Research: In-Browser Vector Search & Embedding Pipeline

**Ticket:** [Ticket 5: Native Vector Search Integration (`sqlite-vec`)](../WAYFINDER_MAP.md)
**Date:** 2026-08-14
**Method:** Research subagent (web research against sqlite-vec GitHub + Transformers.js docs)
**Status:** Findings final — app-layer design graduated to Ticket 20

---

## 1. `vec0` Virtual Table API Surface

`vec0` supports four column kinds: **vector columns**, **primary key**, **partition key columns**, **metadata columns**, and **auxiliary columns** (`+` prefix).

```sql
CREATE VIRTUAL TABLE vec_documents USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  document_id INTEGER PARTITION KEY,
  contents_embedding FLOAT[384] DISTANCE_METRIC=cosine,
  category TEXT,              -- metadata: filterable in WHERE
  +contents TEXT              -- auxiliary: returned w/o JOIN, not filterable
);
```

### Column rules & limits
- Vector types: `float[N]` (default), `int8[N]`, `bit[N]`. Max **8192 dims**, max 16 vector / 16 metadata / 16 auxiliary / 4 partition-key columns.
- `chunk_size` option: vector packing into shadow BLOBs, positive, divisible by 8 (default 1024, max 8192).
- NaN/Infinity rejected on insert.
- Shadow tables: `t_chunks`, `t_rowids`, `t_vector_chunksNN`, `t_auxiliary`, `t_metadatachunksNN`.

### KNN query syntax
`vec0` intercepts `MATCH` on the vector column; requires `k = ?` constraint or `LIMIT`.

```sql
-- Preferred (portable) pattern
SELECT chunk_id, document_id, category, contents, distance
FROM vec_documents
WHERE contents_embedding MATCH :query_vec
  AND k = 5
  AND document_id = 42          -- partition filter (fast)
  AND category = 'engineering'; -- metadata filter

-- Alternative
SELECT chunk_id, contents, distance
FROM vec_documents
WHERE contents_embedding MATCH :query_vec
ORDER BY distance
LIMIT 5;
```

Rules: one `MATCH` per query; `ORDER BY distance` ascending only; query vector as raw IEEE-754 BLOB, JSON string, or via `vec_f32(?)`.

### Distance metrics & scalar functions
- Metrics: `l2` (default), `cosine` (1 − cos sim), `l1`.
- Scalars: `vec_distance_l2/cosine/l1/hamming(a,b)`, `vec_f32/vec_int8/vec_bit(v)`, `vec_normalize(v)`, `vec_slice(v,s,e)` (Matryoshka), `vec_quantize_binary(v)`, `vec_quantize_int8(v,'unit')`, `vec_length(v)`, `vec_type(v)`, `vec_to_json(v)`, `vec_each(v)` (table-valued).

### Views & triggers
- `vec0` works inside views (pass `MATCH`/`k` through).
- Triggers on **regular tables** can insert into `vec0`; do not define triggers *on* `vec0` — drive sync from the primary relational tables.

Sources: [sqlite-vec repo](https://github.com/asg017/sqlite-vec), [vec0 features](https://github.com/asg017/sqlite-vec/blob/main/site/features/vec0.md), [KNN guide](https://github.com/asg017/sqlite-vec/blob/main/site/features/knn.md), [API reference](https://github.com/asg017/sqlite-vec/blob/main/site/api-reference.md)

---

## 2. In-Browser Embedding Options

| Model | Dims | q8 size | fp32 size | WASM CPU latency | WebGPU latency | Context | License |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **`Xenova/all-MiniLM-L6-v2`** ⭐ | 384 | 23 MB | 90 MB | ~12–25 ms | ~2–5 ms | 256 tok | Apache-2.0 |
| `Xenova/bge-small-en-v1.5` | 384 | 33 MB | 133 MB | ~18–35 ms | ~3–7 ms | 512 tok | MIT |
| `Xenova/gte-small` | 384 | 33 MB | 133 MB | ~18–35 ms | ~3–7 ms | 512 tok | Apache-2.0 |
| `nomic-ai/nomic-embed-text-v1.5` | 64–768 (Matryoshka) | 70 MB | 274 MB | ~45–90 ms | ~8–15 ms | 8192 tok | Apache-2.0 |
| `Snowflake/snowflake-arctic-embed-xs` | 384 | 22 MB | 88 MB | ~10–20 ms | ~2–4 ms | 512 tok | Apache-2.0 |

### Frameworks
- **Transformers.js v3** (`@huggingface/transformers`, ~180 KB JS + 3–5 MB wasm assets): built-in CacheStorage/IDB model caching, pure-JS tokenizers, one-flag WebGPU↔WASM fallback. **Recommended.**
- **Raw `onnxruntime-web`**: ~100 KB JS but you must vendor tokenizer + pooling/normalization yourself. Only worth it to shave ~50–80 KB.
- **WebLLM**: generative LLMs only; 1–4 GB VRAM; wrong tool for micro-embeddings.

```javascript
import { pipeline } from '@huggingface/transformers';
const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
  device: navigator.gpu ? 'webgpu' : 'wasm',
  dtype: 'q8',
});
const out = await extractor(text, { pooling: 'mean', normalize: true });
// out.data → Float32Array(384)
```

Sources: [Transformers.js docs](https://huggingface.co/docs/transformers.js), [npm package](https://www.npmjs.com/package/@huggingface/transformers)

---

## 3. Storage & Index Strategy (1k–100k chunks)

`vec0` (v0.1.x) is an **exact brute-force flat scan**, SIMD-accelerated (WASM SIMD128 in browser). No ANN index shipped (DiskANN/IVF experimental upstream).

| Chunks (384-dim f32) | Data size | Flat-scan time (WASM SIMD) |
| :---: | :---: | :---: |
| 1,000 | ~1.5 MB | < 0.5 ms |
| 10,000 | ~15 MB | ~2–6 ms |
| 50,000 | ~77 MB | ~12–25 ms |
| 100,000 | ~154 MB | ~30–65 ms |

**Verdict:** brute force is fine to ~50k chunks (100% recall, zero index lag). Beyond that, use a `PARTITION KEY` (e.g. `document_id`) to shard the scan to ≤5k vectors per query.

**Chunking guidance:** 300–500 tokens (~1,200–2,000 chars) per chunk, 10–15% overlap (~150–200 chars). Store chunk text in an auxiliary column (`+contents`) to avoid JOINs.

---

## 4. Integration Pattern: Async Embedding UDF (wa-sqlite JSPI)

JSPI async UDFs suspend WASM while inference runs; the promise resolution resumes the stack with the result.

### ⚠️ CRITICAL PITFALL — TypedArray corruption
`sqlite3.result_blob` does `HEAPU8.subarray(ptr).set(value)`. Passing a **`Float32Array`** directly makes `Uint8Array.set` truncate each float to a byte (`0.87 → 0`), destroying the vector. Always wrap in a byte view:

```javascript
const byteView = new Uint8Array(
  floatArray.buffer, floatArray.byteOffset, floatArray.byteLength
);
sqlite3.result_blob(context, byteView);
```

### Code sketch

```javascript
// 1. Singleton embedding service
class EmbeddingService {
  static instance = null;
  static async getExtractor() {
    if (!EmbeddingService.instance) {
      EmbeddingService.instance = await pipeline(
        'feature-extraction', 'Xenova/all-MiniLM-L6-v2',
        { device: navigator.gpu ? 'webgpu' : 'wasm', dtype: 'q8' }
      );
    }
    return EmbeddingService.instance;
  }
  static async embed(text) {
    const out = await (await EmbeddingService.getExtractor())(text, { pooling: 'mean', normalize: true });
    return out.data; // Float32Array(384)
  }
}

// 2. Async UDF: embed_text(text) -> vector BLOB
await sqlite3.create_function(db, 'embed_text', 1, SQLITE_UTF8, null,
  async (context, args) => {
    const text = sqlite3.value_text(args[0]);
    if (!text) { sqlite3.result_null(context); return; }
    const vec = await EmbeddingService.embed(text);   // suspends WASM
    sqlite3.result_blob(context,
      new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength));
  });

// 3. Ingestion — UDF usable directly in SQL
// INSERT INTO vec_documents(document_id, contents_embedding, +contents)
// VALUES (?, embed_text(?), ?);

// 4. Semantic search
// SELECT chunk_id, contents, distance FROM vec_documents
// WHERE contents_embedding MATCH embed_text(?) AND k = 5;
```

---

## 5. Recommendations (resolution of Ticket 5)

1. **Model:** `Xenova/all-MiniLM-L6-v2`, `dtype: 'q8'` (23 MB, cached after first load), **384 dims**, **cosine** distance.
2. **Table:** `vec0(chunk_id PK, document_id PARTITION KEY, contents_embedding FLOAT[384] DISTANCE_METRIC=cosine, +contents TEXT)` — partition key from day one (free insurance past 50k chunks).
3. **Indexing:** brute-force flat SIMD scan; no ANN needed at browser scale.
4. **Bridge:** async JSPI UDF `embed_text()`; return vector via `result_blob` with `Uint8Array` view of the Float32Array buffer.
5. **Chunking:** 1,200–2,000 chars, 150–200 char overlap; chunk text in `+contents`.

Open design decisions (graduated to **Ticket 20**): tool registration in `tools`, document ingestion flow (which sources get embedded), `search_similar` agent tool shape, lazy model-load UX.
