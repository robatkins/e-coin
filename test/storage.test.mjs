import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeSnapshot,decodeSnapshot,loadSnapshot } from "../src/storage.mjs";

test("snapshot envelope round-trips and detects payload corruption",()=>{
  const ledger={accounts:{ec1test:{balance:1,nonce:0}},blocks:[],pending:[],totalSupply:1,burned:0};
  const encoded=encodeSnapshot(ledger);
  assert.deepEqual(decodeSnapshot(encoded).ledger,ledger);
  const tampered=encoded.replace('"balance": 1','"balance": 2');
  assert.throws(()=>decodeSnapshot(tampered),/checksum/i);
});

test("legacy raw snapshots remain readable for migration",()=>{
  const ledger={accounts:{},blocks:[],pending:[],totalSupply:0,burned:0};
  const decoded=decodeSnapshot(JSON.stringify(ledger));
  assert.equal(decoded.legacy,true);
  assert.deepEqual(decoded.ledger,ledger);
});

test("loader recovers from backup and fails closed when no valid generation exists",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"ecoin-storage-"));
  const primary=join(directory,"ledger.json"); const backup=join(directory,"ledger.backup.json");
  const ledger={accounts:{},blocks:[],pending:[],totalSupply:0,burned:0};
  try {
    await writeFile(primary,"{corrupt"); await writeFile(backup,encodeSnapshot(ledger));
    const recovered=await loadSnapshot(primary,backup);
    assert.equal(recovered.source,"backup"); assert.deepEqual(recovered.snapshot,ledger);
    await writeFile(backup,"also corrupt");
    await assert.rejects(()=>loadSnapshot(primary,backup),/No valid ledger snapshot/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
