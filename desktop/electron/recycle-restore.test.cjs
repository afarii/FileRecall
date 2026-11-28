"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { restoreRememberedFile, payloadPath } = require("./recycle-restore.cjs");

const original = "F:\\Downloads\\abc.dat";
const recycled = "F:\\$Recycle.Bin\\S-1-5-21-123\\$RABC.dat";
const row = { volume:"volume-a", frn:"123", identity:"original", path:original };
function fixture({occupied=false, wrongIdentity=false, replaceBeforeInvoke=false, complete=true} = {}) {
  let calls=0, restored=false, invoked=[];
  const current = { volume:row.volume, id:row.frn, path:recycled, identity:row.identity };
  return {
    invoked,
    deps: {
      lookup: async () => {
        calls++;
        return {...current,identity:wrongIdentity || (replaceBeforeInvoke && calls>1) ? "replacement" : row.identity};
      },
      verify: async target => target.path===original && !restored ? null : target,
      stat: async () => {
        if(occupied) return {};
        throw Object.assign(new Error("not found"),{code:"ENOENT"});
      },
      invoke: async path => { invoked.push(path); restored=complete; },
      wait: async () => {}, attempts:2,
    },
  };
}

test("restore targets the exact recycled payload, verifies returned file identity", async () => {
  assert.equal(payloadPath(recycled),true);
  assert.equal(payloadPath("F:\\Downloads\\$Report.dat"),false);
  assert.equal(payloadPath("F:\\$Recycle.Bin\\S-1-5-21-123\\$IABC.dat"),false);
  const f=fixture();
  assert.deepEqual(await restoreRememberedFile(row,f.deps),{ok:true});
  assert.deepEqual(f.invoked,[recycled]);
});

test("restore rejects occupied destinations, stale identities and permanently deleted records", async () => {
  for(const options of [{occupied:true},{wrongIdentity:true},{replaceBeforeInvoke:true}]) {
    const f=fixture(options);
    assert.equal((await restoreRememberedFile(row,f.deps)).ok,false);
    assert.deepEqual(f.invoked,[]);
  }
  for(const invalid of [{...row,deleted:1},{...row,path:recycled},{...row,path:"C:\\abc.dat"}]) {
    const f=fixture();
    assert.equal((await restoreRememberedFile(invalid,f.deps)).ok,false);
    assert.deepEqual(f.invoked,[]);
  }
});

test("restore dispatch alone does not imply success", async () => {
  const f=fixture({complete:false});
  const result=await restoreRememberedFile(row,f.deps);
  assert.equal(result.ok,false);
  assert.match(result.message,/尚未确认/);
  assert.deepEqual(f.invoked,[recycled]);
});
