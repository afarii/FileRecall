"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseSmartQuery,domainMatches,extensionMatches } = require("./smart-query.cjs");
const { smartRecovery } = require("./smart-recovery.cjs");
const { MotwMemory } = require("./motw-memory.cjs");
const { DownloadSources } = require("./download-sources.cjs");
const now=new Date(2026,10,28,17,30).getTime();

test("natural language extracts combined constraints and local calendar dates",()=>{
  const p=parseSmartQuery("上个月从 GitHub 下载的操作系统资料",now);
  assert.equal(p.domain,"github.com");
  assert.equal(p.topic,"操作系统");
  assert.equal(p.recorded,true);
  assert.equal(p.range.from,new Date(2026,9,1).getTime());
  assert.equal(p.range.until,new Date(2026,10,1).getTime());
  const week=parseSmartQuery("上周下载的 PDF",now);
  assert.deepEqual(week.extensions,["pdf"]);
  assert.equal(week.topic,"");
  assert.equal(week.range.from,new Date(2026,10,16).getTime());
  assert.equal(week.range.until,new Date(2026,10,23).getTime());
  assert.equal(parseSmartQuery("之前下载但已经删除的实验报告",now).status,"missing");
  assert.equal(parseSmartQuery("我收藏的算法课件",now).topic,"算法");
  assert.equal(parseSmartQuery("我收藏的算法课件",now).favorites,true);
  assert.equal(parseSmartQuery("从 testfile.cc 下载的文件",now).domain,"testfile.cc");
  assert.equal(parseSmartQuery("report.pdf",now).topic,"report.pdf");
  assert.throws(()=>parseSmartQuery("今天和昨天下载的文件",now),/一个时间/);
  assert.throws(()=>parseSmartQuery("从某个不认识的网站下载的资料",now),/域名/);
  assert.equal(domainMatches("cdn.github.com","github.com"),true);
  assert.equal(domainMatches("github.com.evil.test","github.com"),false);
  assert.equal(extensionMatches("abc.pdf.exe",["pdf"]),false);
});

test("smart source SQL applies time/domain/type before cap, alternate host matches",t=>{
  const memory=new MotwMemory(":memory:");
  t.after(()=>memory.close());
  const evidence={hostUrl:"https://cdn.github.com/x",referrerUrl:"https://example.org/"};
  for(let i=1;i<=130;i++)memory.save({volume:"a",id:String(i),identity:String(i),path:"C:\\junk\\x.exe"},evidence,now);
  memory.save({volume:"a",id:"201",identity:"201",path:"C:\\a\\kernel.pdf"},evidence,now-100);
  memory.save({volume:"a",id:"202",identity:"202",path:"C:\\a\\wrong.pdf"},{hostUrl:"https://github.com.evil.test/x"},now);
  memory.save({volume:"a",id:"203",identity:"203",path:"C:\\a\\old.pdf"},evidence,now-86400000*90);
  const plan=parseSmartQuery("今天从 Github 下载的 PDF",now);
  assert.deepEqual(memory.smartCandidates(plan).map(x=>x.name),["kernel.pdf"]);
  assert.equal(memory.smartCandidates(plan)[0].sourceDomainMatched,true);
  const downloads=new DownloadSources(":memory:");
  t.after(()=>downloads.close());
  downloads.importAria2([
    {gid:"1",index:"1",path:"C:\\a\\a.pdf",uri:"https://cdn.github.com/x"},
    {gid:"2",index:"1",path:"C:\\a\\b.pdf",uri:"https://github.com.evil.test/x"},
  ]);
  assert.deepEqual(downloads.smartCandidates({...plan,range:null}).map(x=>x.name),["a.pdf"]);
});

const source=(id, name, extra={})=>({id,name,path:"C:\\Downloads\\"+name,startedAt:now,manager:"motw",domain:"github.com",sourceTitle:"https://github.com/",pathStatus:"present",...extra});
const local=(name,extra={})=>({path:"C:\\Downloads\\"+name,name,status:"present",favorite:0,...extra});
test("smart recovery preserves strict source filters and skips model for metadata-only queries",async()=>{
  let calls=0;
  const deps={
    sources:async()=>[source("1","abc.pdf"),source("2","abc.exe"),source("3","abc.pdf",{domain:"other.org",sourceTitle:"https://other.org/"}),source("4","abc.pdf",{startedAt:now-86400000*60}),source("5","forgot.pdf")],
    resolveSource:async r=>r.id==="5"?null:r,
    files:async()=>{throw Error("unnecessary filename scan");},
    modelReady:async()=>{calls++;return true;},
    semantic:async()=>{calls++;throw Error("unnecessary inference");},
  };
  const result=await smartRecovery("今天从 GitHub 下载的 PDF",deps,{now});
  assert.deepEqual(result.records.map(r=>r.file.id),["1"]);
  assert.equal(calls,0);
  assert.equal(result.semanticUsed,false);
});
test("source semantic supplement cannot escape verified path, type or deletion constraints",async()=>{
  const a=source("1","notes.pdf"), b=source("2","deleted.pdf",{pathStatus:"missing"}), c=source("3","other.pdf",{domain:"other.org",sourceTitle:"https://other.org/"});
  let scope;
  const deps={
    sources:async()=>[a,b,c],
    resolveSource:async r=>r,
    files:async()=>[],
    modelReady:async()=>true,
    semantic:async(topic,opts)=>{
      assert.equal(topic,"操作系统");
      scope=opts.paths;
      return {files:[local("notes.pdf"),local("other.pdf"),local("deleted.pdf")],indexed:3,truncated:false};
    },
  };
  const result=await smartRecovery("从 GitHub 下载的操作系统 PDF",deps,{now});
  assert.deepEqual(scope,["c:\\downloads\\notes.pdf"]);
  assert.deepEqual(result.records.map(r=>r.file.id),["1"]);
  assert.equal(result.semanticUsed,true);
  const deleted=await smartRecovery("已删除的 PDF",deps,{now});
  assert.deepEqual(deleted.records.map(r=>r.file.id),["2"]);
  assert.equal(deleted.semanticUsed,false);
});
test("local smart search preserves favorite/type constraints and model fallback",async()=>{
  const deps={
    sources:async()=>[],
    resolveSource:async r=>r,
    files:async(query,fav)=>{
      assert.equal(query,"算法");assert.equal(fav,true);
      return [{type:"local",file:local("算法课件.pdf",{favorite:1})},{type:"local",file:local("算法课件.docx",{favorite:1})},{type:"local",file:local("算法课件2.pdf")}];
    },
    modelReady:async()=>false,
    semantic:async()=>{throw Error("should not run");},
  };
  const result=await smartRecovery("我收藏的算法课件 PDF",deps,{now});
  assert.deepEqual(result.records.map(r=>r.file.name),["算法课件.pdf"]);
  assert.equal(result.semanticUsed,false);
  assert.ok(result.notes.some(n=>n.includes("尚未就绪")));
});


test("software category matches source packages without treating software engineering as a category",async()=>{
  const plan=parseSmartQuery("github下载的软件",now);
  assert.equal(plan.topic,"");
  assert.equal(plan.category,"software");
  assert.equal(plan.domain,"github.com");
  assert.ok(plan.extensions.includes("exe"));
  assert.ok(plan.extensions.includes("zip"));
  assert.equal(parseSmartQuery("关于软件工程的课件",now).category,"courseware");
  assert.match(parseSmartQuery("关于软件工程的课件",now).topic,/软件工程/);
  const deps={
    sources:async()=>[source("zip","TangoFlux-main.zip"),source("exe","setup.exe"),source("msi","tool.msi"),source("pdf","notes.pdf"),source("wrong","bad.exe",{domain:"other.org",sourceTitle:"https://other.org/"})],
    resolveSource:async r=>r,
    files:async()=>{throw Error("unneeded filename search");},
    modelReady:async()=>{throw Error("unneeded model");},
    semantic:async()=>{throw Error("unneeded inference");},
  };
  const r=await smartRecovery("github下载的软件",deps,{now});
  assert.deepEqual(r.records.map(x=>x.file.id),["exe","msi","zip"]);
  assert.ok(r.records[2].evidence.some(x=>x.includes("内容未核验")));
  assert.equal(r.semanticUsed,false);
});


test("courseware search combines subject and parent directory, without model inference",async()=>{
  const p=parseSmartQuery("算法的课件",now);
  assert.equal(p.topic,"算法");
  assert.equal(p.category,"courseware");
  assert.deepEqual(p.extensions,["ppt","pptx","pdf","odp"]);
  assert.deepEqual(parseSmartQuery("算法课件 PDF",now).extensions,["pdf"]);
  const chapter=(id,name)=>({type:"ntfs",file:{id,drive:"E",path:"E:\\算法设计与分析\\"+name,name,cached:false,directory:false}});
  const first=chapter("1","第1讲-算法绪论.pptx"),second=chapter("2","第3讲-分治法.ppt"),third=chapter("3","第4讲-动态规划.pptx");
  const deps={
    files:async query=>{assert.equal(query,"算法");return [first];},
    context:async plan=>{assert.equal(plan.topic,"算法");return [first,second,third,chapter("4","作业.docx")];},
    modelReady:async()=>{throw Error("model disabled");},
  };
  const result=await smartRecovery("算法的课件",deps,{now,useModel:false});
  assert.equal(result.records.length,3);
  assert.ok(result.records.some(r=>r.file.id==="2"&&r.evidence.includes("所属目录与主题匹配")));
  assert.equal(result.records.find(r=>r.file.id==="1").evidence.length,2);
});
