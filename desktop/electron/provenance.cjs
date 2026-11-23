"use strict";

const samePath = (left, right) => left.toLowerCase() === right.toLowerCase();

function createProvenance(index, readDownloads) {
  async function local(path) {
    const identity = await index.sourceIdentity(path);
    if (!identity) return { identity: null, confirmed: null, candidates: [], rejected: [], aliases: [], annotation: null };
    const aliases = index.sourceAliases(identity);
    const decisions = index.sourceDecisions(identity);
    const confirmedId = decisions.find(({ decision }) => decision === "confirmed")?.id;
    const rejectedIds = new Set(decisions.filter(({ decision }) => decision === "rejected").map(({ id }) => id));
    const base = { identity, confirmed: null, candidates: [], rejected: [], aliases, annotation: index.annotation(identity) };
    return readDownloads((sources) => ({
      ...base,
      confirmed: confirmedId ? sources.byId(confirmedId) : null,
      candidates: sources.candidates(aliases)
        .filter(({ id }) => id !== confirmedId && !rejectedIds.has(id) && !index.linkedIdentity(id))
        .slice(0, 6)
        .map((record) => ({ ...record, evidence: aliases.some(({ path }) => samePath(path, record.path)) ? "路径一致" : "文件名一致" })),
      rejected: [...rejectedIds].map((id) => sources.byId(id)).filter(Boolean),
    }), base);
  }

  async function decide(path, identity, id, decision) {
    if (typeof identity !== "string" || typeof id !== "string" || id.length > 160
      || !["confirmed", "rejected", "undo"].includes(decision)) throw new Error("无效的关联操作。");
    const state = await local(path);
    if (state.identity !== identity) throw new Error("文件状态已改变，请重新打开详情。");
    if (decision === "undo") {
      if (state.confirmed?.id !== id && !state.rejected.some((record) => record.id === id)) {
        throw new Error("这条关联已经改变。");
      }
    } else {
      if (!state.candidates.some((record) => record.id === id)) throw new Error("此下载已不在候选列表中。");
      if (decision === "confirmed" && state.confirmed) throw new Error("请先撤销已有的关联。");
    }
    index.decideSource(identity, id, decision);
    return local(path);
  }

  return { local, decide };
}

module.exports = { createProvenance };
