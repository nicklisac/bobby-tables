# wa-sqlite-jspi (vendored)

Vendored wa-sqlite JSPI runtime — custom build with sqlite-vec + FTS5 + JSPI
(see commit `d3072d5`). The WASM and glue `.mjs` are built **externally** and
dropped into this directory; there is no build script in this repo.

---

## ⚠️ LOCAL PATCH: JSPI async-export list in `wa-sqlite-jspi.mjs`

`wa-sqlite-jspi.mjs` carries a **local modification that is not upstream**.

The glue code's `Asyncify.instrumentWasmExports` wraps exports matching an
`exportPattern` regex with `WebAssembly.promising()` — that wrapping is what
lets a function *suspend* (JSPI) when it reaches the async IDB VFS. The stock
list only covers the query lifecycle:

```
sqlite3_close | sqlite3_finalize | sqlite3_open_v2 | sqlite3_prepare* |
sqlite3_reset | sqlite3_step | main | __main_argc_argv
```

Cartridge export/import (`src/cartridge.js`) additionally needs:

```
sqlite3_backup_init | sqlite3_backup_step | sqlite3_backup_finish |
sqlite3_serialize | sqlite3_deserialize
```

Without them, any cartridge operation that touches the IDB-backed live DB
throws `SuspendError: trying to suspend without WebAssembly.promising`.

### If you rebuild or re-vendor `wa-sqlite-jspi.mjs`, reapply the patch

Replace the `exportPattern` line with:

```js
var exportPattern=/^(sqlite3_close|sqlite3_finalize|sqlite3_open_v2|sqlite3_prepare|sqlite3_prepare16|sqlite3_prepare_v2|sqlite3_prepare16_v2|sqlite3_prepare_v3|sqlite3_prepare16_v3|sqlite3_reset|sqlite3_step|sqlite3_backup_init|sqlite3_backup_step|sqlite3_backup_finish|sqlite3_serialize|sqlite3_deserialize|main|__main_argc_argv)$/;
```

### Verify the patch is present

```sh
grep -c 'sqlite3_backup_init|sqlite3_backup_step' vendor/wa-sqlite-jspi/wa-sqlite-jspi.mjs
# 1 = patched · 0 = needs reapplying
```

### Long-term fix

If the WASM is ever rebuilt from source, add the five functions above to the
build's async-export list directly, so the glue file no longer needs patching.
