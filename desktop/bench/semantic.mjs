import { createRequire } from "node:module";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const [workspace] = process.argv.slice(2);
if (!workspace) throw new Error("用法：node desktop/bench/semantic.mjs <原型工作目录>");

const model = "Xenova/multilingual-e5-small";
const modelPath = join(resolve(workspace), "models");
const modelFiles = ["config.json", "tokenizer_config.json", "tokenizer.json", "onnx/model_quantized.onnx"];
const modelSize = (await Promise.all(modelFiles.map((file) => stat(join(modelPath, model, file)))))
  .reduce((total, file) => total + file.size, 0);

const require = createRequire(join(resolve(workspace), "package.json"));
const { env, pipeline } = require("@huggingface/transformers");
env.localModelPath = modelPath;
env.allowRemoteModels = false;
env.useFSCache = false;

const documents = [
  ["q4-budget", "第四季度预算。明年一月前将差旅、耗材和团队活动的预估费用提交财务。"],
  ["new-computers", "信息部设备采购。每个小组申报笔记本数量，汇总后向供应商询价。"],
  ["leave-policy", "员工年度休假办法。通过人事系统填报审批，未使用天数可结转。"],
  ["deposit", "房屋租赁终止。交还钥匙并核对水电，验房通过后一周内退还押金。"],
  ["dentist", "口腔门诊周二早晨九点，常规洁牙前可照常进食，请携带就诊卡。"],
  ["python-install", "开发环境配置。使用 Python 3.13 创建 venv，并通过 pip 安装依赖。"],
  ["city-trip", "周末京都行程。上午抵达岚山，傍晚乘电车返回车站附近的酒店。"],
  ["garden", "番茄种植记录。幼苗长出两片真叶后移栽，每隔三天检查土壤湿度。"],
  ["flight-refund", "The airline allows a fare refund within 24 hours of booking when the departure is at least one week away."],
  ["parcel", "The courier requires a signature on delivery. A neighbour may receive the package if you are away."],
  ["bike", "Bicycle maintenance checklist. Inflate tires to the recommended pressure and lubricate the chain."],
  ["reimbursement", "Submit receipts through the expense portal. Finance reimburses approved out-of-pocket travel costs."],
  ["shared-drive", "To restore a deleted company document, open the shared drive recycle bin and select the previous version."],
  ["job-interview", "Your second-round interview covers system design and project experience. Please bring a copy of your resume."],
  ["printer", "Replace the toner cartridge when prints appear faded. Run the alignment utility after setup."],
  ["invoice", "The supplier invoice is due thirty days after delivery. Pay by bank transfer using the invoice number."],
  ["q3-expenses", "第三季度报销。已发生的出差、办公用品和团队活动支出请在十月前提交凭证。"],
  ["leave-request", "公司无薪事假须由部门主管审批。假期开始前提交书面申请。"],
  ["hotel-cancellation", "Hotel reservations can be cancelled before 6 p.m. two days prior to arrival. Later cancellations cost one night."],
  ["cloud-archive", "Move completed team projects into cloud storage when the retention period begins. This frees up space on the shared drive."],
];

const queries = [
  ["exact", "第四季度预算", "q4-budget"],
  ["exact", "venv", "python-install"],
  ["exact", "toner cartridge", "printer"],
  ["exact", "recycle bin", "shared-drive"],
  ["paraphrase", "冬天的开销计划", "q4-budget"],
  ["paraphrase", "想给组里的同事换一批电脑", "new-computers"],
  ["paraphrase", "退租后什么时候能把钱拿回来", "deposit"],
  ["paraphrase", "看牙前能不能吃早餐", "dentist"],
  ["paraphrase", "what if nobody is home to accept my shipment", "parcel"],
  ["paraphrase", "how to get back the money I spent on a work trip", "reimbursement"],
  ["paraphrase", "I need to recover a file someone removed from the team folder", "shared-drive"],
  ["cross-language", "打印的字太淡怎么处理", "printer"],
  ["cross-language", "刚买机票后悔了，能退票吗", "flight-refund"],
  ["paraphrase", "what to prepare for the follow-up hiring meeting", "job-interview"],
  ["cross-language", "vacation days carry forward", "leave-policy"],
  ["cross-language", "when should I transplant my tomato seedlings", "garden"],
  ["cross-language", "which places to visit on a Kyoto weekend", "city-trip"],
  ["no-answer", "北京房贷首付比例是多少", null],
  ["no-answer", "who won the national swimming championship", null],
  ["no-answer", "为什么月球有背面", null],
];

const started = performance.now();
const embed = await pipeline("feature-extraction", model, { dtype: "q8", device: "cpu" });
const loadMs = performance.now() - started;
const encode = async (inputs) => (await embed(inputs, { pooling: "mean", normalize: true })).tolist();

function similarity(left, right) {
  return left.reduce((sum, value, i) => sum + value * right[i], 0);
}

function percentile(values, fraction) {
  const sorted = values.toSorted((a, b) => a - b);
  return Math.round(sorted[Math.ceil(sorted.length * fraction) - 1] * 10) / 10;
}

try {
  const indexing = performance.now();
  const vectors = await encode(documents.map(([, content]) => "passage: " + content));
  const indexMs = performance.now() - indexing;
  await encode(["query: warm up"]);

  const outcomes = [];
  for (const [group, query, expected] of queries) {
    const queryStarted = performance.now();
    const [vector] = await encode(["query: " + query]);
    const ranked = documents.map(([id], i) => ({ id, score: similarity(vector, vectors[i]) }))
      .sort((a, b) => b.score - a.score);
    const ms = performance.now() - queryStarted;
    const literal = documents.filter(([id, content]) =>
      id.includes(query.toLowerCase()) || content.toLowerCase().includes(query.toLowerCase()));

    outcomes.push({
      group, query, expected,
      literalHit: expected === null ? literal.length === 0 : literal.some(([id]) => id === expected),
      semanticRank: expected === null ? null : ranked.findIndex(({ id }) => id === expected) + 1,
      top: ranked.slice(0, 3).map(({ id, score }) => ({ id, score: Number(score.toFixed(4)) })),
      ms: Math.round(ms * 10) / 10,
    });
  }

  const answerable = outcomes.filter(({ expected }) => expected !== null);
  const groups = [...new Set(answerable.map(({ group }) => group))].map((group) => {
    const rows = answerable.filter((row) => row.group === group);
    return {
      group, queries: rows.length,
      literalHits: rows.filter(({ literalHit }) => literalHit).length,
      semanticTop1: rows.filter(({ semanticRank }) => semanticRank === 1).length,
      semanticTop3: rows.filter(({ semanticRank }) => semanticRank <= 3).length,
    };
  });
  console.log(JSON.stringify({
    model, modelSize, documents: documents.length,
    loadMs: Math.round(loadMs), indexMs: Math.round(indexMs),
    queryMs: { p50: percentile(outcomes.map(({ ms }) => ms), 0.5), p95: percentile(outcomes.map(({ ms }) => ms), 0.95) },
    groups, outcomes,
  }, null, 2));
} finally {
  await embed.dispose();
}
