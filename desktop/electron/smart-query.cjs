"use strict";

const aliases = { github:"github.com", gitlab:"gitlab.com", gitee:"gitee.com", 知乎:"zhihu.com", 哔哩哔哩:"bilibili.com", bilibili:"bilibili.com", 百度网盘:"pan.baidu.com", arxiv:"arxiv.org", huggingface:"huggingface.co" };
const types = [
  [/(?:\bpdf\b)/ig,["pdf"]],
  [/(?:\bpptx?\b|幻灯片|演示文稿)/ig,["ppt","pptx"]],
  [/(?:\bdocx?\b|\bword\b)/ig,["doc","docx"]],
  [/(?:\bxlsx?\b|\bexcel\b|电子表格)/ig,["xls","xlsx","csv"]],
  [/(?:压缩包|\bzip\b|\brar\b|\b7z\b)/ig,["zip","rar","7z"]],
  [/(?:图片|照片)/g,["png","jpg","jpeg","webp","gif","bmp"]],
  [/(?:\btxt\b|\bmarkdown\b|\bmd\b)/ig,["txt","md"]],
];
function dateRange(label, now) {
  const end = new Date(now), start = new Date(now);
  start.setHours(0,0,0,0);
  let until = end.getTime()+1;
  if (label==="昨天") { until=start.getTime(); start.setDate(start.getDate()-1); }
  else if (label==="今天") {}
  else if (label==="上周" || label==="本周" || label==="这周") {
    start.setDate(start.getDate()-((start.getDay()+6)%7));
    if(label==="上周"){until=start.getTime();start.setDate(start.getDate()-7);}
  } else if(label==="上个月" || label==="上月" || label==="本月" || label==="这个月") {
    start.setDate(1);
    if(label==="上个月"||label==="上月"){until=start.getTime();start.setMonth(start.getMonth()-1);}
  } else {
    const days = Number(/(\d+)/.exec(label)?.[1] || (label==="最近" ? 7 : 30));
    start.setDate(start.getDate()-Math.max(0,Math.min(days,365)-1));
  }
  return { from:start.getTime(), until, label };
}
function parseSmartQuery(raw, now=Date.now()) {
  if(typeof raw!=="string" || !raw.trim() || raw.length>200) throw new Error("请输入 1–200 字的找回描述。");
  let text=raw.trim(), range=null, domain="", status="", favorites=false, recorded=false;
  if(/上上周|前天|去年|今年|\d{4}年|\d+月\d+日|\d+天前/.test(text))throw new Error("目前支持今天、昨天、本周、上周、本月、上个月和最近 N 天。");
  if(/(?:今天|昨天|上周|本周|上个月|本月|最近|近\d+天).*(?:修改|创建|访问|打开)/.test(text))throw new Error("智能找回目前支持下载或首次观察时间，暂不支持修改、创建或访问时间。");
  const dates=text.match(/上个月|这个月|上月|本月|上周|本周|这周|昨天|今天|最近\s*\d+\s*天|近\s*\d+\s*天|最近/g)||[];
  if(dates.length>1) throw new Error("请每次指定一个时间范围。");
  if(dates.length){range=dateRange(dates[0],now);text=text.replace(dates[0]," ");}
  if(/(?:前天|去年|今年|\d{4}年|\d+月|\d+天前|上上周)/.test(text)) throw new Error("目前支持今天、昨天、本周、上周、本月、上个月和最近 N 天。");
  const sites = [];
  text=text.replace(/https?:\/\/[^\s，。；、]+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?![a-z0-9-])/ig, match=>{
    // An explicitly named extension is a file term, not a website.
    if(/\.(?:pdf|docx?|pptx?|xlsx?|txt|md|zip|rar|7z|exe|png|jpe?g|csv|dat)$/i.test(match)&&!/^https?:/i.test(match)) return match;
    try { const u=new URL(/^https?:/i.test(match)?match:"https://"+match); sites.push(u.hostname.toLowerCase()); return " "; } catch{return match;}
  });
  text=text.replace(/github|gitlab|gitee|知乎|哔哩哔哩|bilibili|百度网盘|arxiv|huggingface/ig, match=>{sites.push(aliases[match.toLowerCase()]);return " ";});
  const unique=[...new Set(sites)];
  if(unique.length>1) throw new Error("请每次指定一个来源网站。");
  domain=unique[0]||"";
  if(!domain && /(?:从|来自)\s*.+?(?:下载|获取|保存)/.test(text)) throw new Error("请用网站域名描述来源，例如 github.com。");
  if(/回收站/.test(text)){status="recycled";text=text.replace(/(?:在|已进入|移入)?回收站(?:里|中)?/g," ");}
  else if(/已删除|已经删除|删掉|彻底删除|丢失|历史文件|找不(?:到|见)/.test(text)){status="missing";text=text.replace(/已删除|已经删除|删掉|彻底删除|丢失|历史文件|找不(?:到|见)/g," ");}
  else if(/仍然存在|现存|未删除|还在(?:电脑|本地)?/.test(text)){status="present";text=text.replace(/仍然存在|现存|未删除|还在(?:电脑|本地)?/g," ");}
  favorites=/收藏/.test(text);text=text.replace(/(?:我)?收藏(?:过|的)?/g," ");
  recorded=/下载|来源|获取/.test(text)||Boolean(domain)||Boolean(range)||status==="recycled"||status==="missing";
  const extensions=[];
  for(const [pattern,exts] of types) {
    // Keep exact filenames such as report.pdf as a single topic.
    text=text.replace(pattern,(match,offset,whole)=>{
      if(offset>0 && whole[offset-1]===".")return match;
      extensions.push(...exts);return " ";
    });
  }
  text=text.replace(/(?:请帮我|帮我|我想|我记得|找一下|找到|查找|搜索|找回|之前|以前|已经|下载|来自|获取|保存|有关|关于|相关|文件|资料|文档|的|从|了|但|在|我)/g," ");
  text=text.replace(/[，。！？；、："'“”‘’]/g," ").replace(/\s+/g," ").trim();
  // Avoid treating generic nouns as an exact keyword. '课件' / '报告' are
  // useful topics and are kept.
  const plan={topic:text,domain,extensions:[...new Set(extensions)],range,status,favorites,recorded};
  if(!plan.topic&&!plan.domain&&!plan.extensions.length&&!plan.range&&!plan.status&&!plan.favorites&&!plan.recorded) throw new Error("请描述文件名、主题、来源或时间。");
  return plan;
}
function domainMatches(host,wanted) {
  const a=String(host||"").toLowerCase(),b=String(wanted||"").toLowerCase();
  return !b||a===b||a.endsWith("."+b);
}
function urlDomain(url) { try{return new URL(url).hostname;}catch{return "";} }
function extensionMatches(name,extensions) {return !extensions.length||extensions.includes(String(name).toLowerCase().split(".").at(-1))&&String(name).includes(".");}
const keyPath = path => String(path||"").replaceAll("/","\\").toLowerCase();
function matchesTopic(file,topic){
  if(!topic)return true;
  const hay=[file.name,file.path,file.sourceTitle,file.domain].filter(Boolean).join(" ").toLowerCase();
  return topic.toLowerCase().split(/\s+/).every(word=>hay.includes(word));
}
function matchesSource(row,plan){
  return (!plan.domain||row.sourceDomainMatched===true||domainMatches(row.domain,plan.domain)||domainMatches(urlDomain(row.sourceTitle),plan.domain)) &&
    extensionMatches(row.name,plan.extensions) &&
    (!plan.range||(row.startedAt>=plan.range.from&&row.startedAt<plan.range.until)) &&
    (!plan.status||row.pathStatus===plan.status||(plan.status==="missing"&&row.pathStatus==="recycled"));
}
module.exports={parseSmartQuery,domainMatches,urlDomain,extensionMatches,matchesTopic,matchesSource,keyPath};
