"use strict";
const { parseSmartQuery, extensionMatches, matchesSource, matchesTopic, keyPath, softwareEvidence } = require("./smart-query.cjs");
const { isRecyclePath } = require("./recycle-path.cjs");

const recordKey = r => r.type==="download" ? "download:"+r.file.id
  : r.type==="ntfs" ? "ntfs:"+r.file.drive+":"+r.file.id : "local:"+keyPath(r.file.path);
function livePath(record){
  if(record.type==="download") return record.file.manager==="motw"&&record.file.pathStatus==="present" ? record.file.path : "";
  if(record.type==="ntfs") return !record.file.cached&&!record.file.directory&&!isRecyclePath(record.file.path)?record.file.path:"";
  return record.file.currentPath||(record.file.status==="present"?record.file.path:"");
}
function fitsFile(record,plan){
  const f=record.file;
  if(record.type==="ntfs"&&(f.directory||isRecyclePath(f.path)))return false;
  if(!extensionMatches(f.name,plan.extensions))return false;
  if(plan.favorites&&!f.favorite)return false;
  if(plan.status==="present"&&!livePath(record))return false;
  return true;
}
async function mapBounded(rows,fn,limit=8){
  let i=0;const results=new Array(rows.length);
  await Promise.all(Array.from({length:Math.min(limit,rows.length)},async()=>{
    while(i<rows.length){const n=i++;results[n]=await fn(rows[n]);}
  }));
  return results;
}
async function smartRecovery(raw, deps, { useModel=true, now=Date.now() }={}){
  const plan=parseSmartQuery(raw,now), notes=[], records=new Map();
  let semanticIndexed=0, semanticUsed=false, truncated=false;
  const add=(record,evidence)=>{
    const key=recordKey(record);
    const prev=records.get(key);
    if(prev){if(!prev.evidence.includes(evidence))prev.evidence.push(evidence);return;}
    const category=plan.category==="software"?softwareEvidence(record.file.name):null;
    records.set(key,{...record,evidence:[evidence,...(category?.label?[category.label]:[])]});
  };
  if(plan.category==="software")notes.push("安装包和可执行文件优先展示；压缩包作为可能的软件候选，未解包核验内容。");
  if(plan.category==="courseware")notes.push("课件按演示文稿和 PDF 类型召回，结合文件名及所属目录判断主题。");
  let candidates=[];
  if(plan.recorded){
    let rows=await deps.sources(plan);
    const counts={};
    rows=rows.filter(row=>{counts[row.manager]=(counts[row.manager]||0)+1;return counts[row.manager]<=120;});
    truncated=Object.values(counts).some(n=>n>120);
    const checked=await mapBounded(rows,async row=>{
      try { return await deps.resolveSource(row,plan.favorites); } catch {return {...row,pathStatus:"unknown"};}
    });
    candidates=checked.filter(row=>row&&matchesSource(row,plan)&&(!plan.favorites||Boolean(row.favorite)))
      .map(file=>({type:"download",file}));
    for(const r of candidates)if(matchesTopic(r.file,plan.topic))add(r,plan.topic?"主题与来源记录匹配":"来源记录匹配");
    if(plan.range)notes.push("时间按记录依据匹配：Chrome 为下载时间；Windows 来源与旧下载器记录为首次观察时间。");
    if(plan.status==="missing")notes.push("已删除筛选使用已核验的 Windows 历史状态，包含回收站中的文件。");
    if(plan.favorites)notes.push("来源与收藏联合查询仅使用已核验的现存文件。");
  }else{
    const queries=plan.topic?[plan.topic]:plan.favorites?[""]:plan.extensions.map(x=>"."+x);
    if(!queries.length)notes.push("请补充文件名、主题或类型以缩小范围。");
    for(const query of queries){
      const found=await deps.files(query,plan.favorites);
      if(found.length>=100)truncated=true;
      for(const record of found)if(fitsFile(record,plan))add(record,"文件名、索引或收藏匹配");
    }
    if(plan.category&&plan.topic&&deps.context){
      try{
        const contextual=await deps.context(plan);
        if(contextual.length>=201)truncated=true;
        for(const r of contextual)if(fitsFile(r,plan))add(r,"所属目录与主题匹配");
      }catch{notes.push("目录上下文检索暂不可用，已保留其他匹配结果。");}
    }
  }
  if(plan.topic&&useModel){
    const scope=plan.recorded?[...new Set(candidates.map(livePath).filter(Boolean).map(keyPath))]:undefined;
    if(plan.recorded&&!scope.length)notes.push("历史文件没有可核验的现存正文，按已有文件名和来源检索。");
    else if(!await deps.modelReady())notes.push("正文模型或正文索引尚未就绪，本次使用文件名和来源检索。");
    else{
      try{
        const sem=await deps.semantic(plan.topic,{paths:scope,extensions:plan.extensions,favorites:plan.favorites&&!plan.recorded});
        semanticUsed=true;semanticIndexed=sem.indexed;truncated ||= Boolean(sem.truncated);
        const byPath=new Map();
        for(const file of sem.files){if(file.status!=="present"&&!file.currentPath)continue;const path=keyPath(file.currentPath||file.path);byPath.set(path,file);}
        if(plan.recorded){
          for(const r of candidates)if(byPath.has(keyPath(livePath(r)))&&livePath(r)){
            // Re-check before attaching semantic evidence to a recorded identity.
            const current=await deps.resolveSource(r.file,plan.favorites);
            if(current?.pathStatus==="present"&&keyPath(current.path)===keyPath(r.file.path)&&matchesSource(current,plan))
              add({type:"download",file:current},"本地正文语义匹配");
          }
        }else for(const file of sem.files){
          const r={type:"local",file};
          if(fitsFile(r,plan))add(r,"本地正文语义匹配");
        }
        if(!semanticIndexed)notes.push("当前约束范围内没有已索引的正文。");
      }catch{notes.push("本地正文语义检索暂不可用，已保留文件名与来源匹配结果。");}
    }
  }
  // Prefer results supported by both channels. Deduplicate live records by
  // path without collapsing distinct historical download identities.
  const merged=new Map();
  for(const r of records.values()){
    const path=livePath(r),key=path?"live:"+keyPath(path):recordKey(r);
    const prev=merged.get(key);
    if(!prev){merged.set(key,r);continue;}
    const chosen=r.type==="download"?r:prev.type==="download"?prev:r.type==="local"?r:prev;
    merged.set(key,{...chosen,evidence:[...new Set([...prev.evidence,...r.evidence])]});
  }
  const result=[...merged.values()].sort((a,b)=>(plan.category==="software"?softwareEvidence(b.file.name).rank-softwareEvidence(a.file.name).rank:0) || b.evidence.length-a.evidence.length ||
    Number(Boolean(livePath(b)))-Number(Boolean(livePath(a))) ||
    a.file.name.localeCompare(b.file.name)||recordKey(a).localeCompare(recordKey(b)));
  return {plan,records:result.slice(0,200),notes,semanticIndexed,semanticUsed,truncated:truncated||result.length>200};
}
module.exports={smartRecovery};
