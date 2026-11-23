import { useEffect, useRef, useState } from "react";

export default function useSemanticSearch() {
  const [model, setModel] = useState<ModelStatus>();
  const [installing, setInstalling] = useState(false);
  const [searching, setSearching] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const [result, setResult] = useState<{ query: string; result: SemanticResult }>();
  const [error, setError] = useState("");
  const searchVersion = useRef(0);

  useEffect(() => {
    window.fileRecall.semanticStatus().then(setModel).catch(() => setError("无法读取模型状态。"));
    const updates = window.fileRecall.onModelProgress((next) => setModel((previous) => ({
      ...previous, ...next, ready: false, downloading: true,
    })));
    const work = window.fileRecall.onSemanticProgress(setProgress);
    return () => { updates(); work(); };
  }, []);

  function invalidate() {
    searchVersion.current++;
    setResult(undefined);
    setError("");
  }

  async function install() {
    setInstalling(true);
    invalidate();
    try {
      setModel(await window.fileRecall.installSemantic());
    } catch {
      setError("模型下载失败，请检查网络后重试。");
      setModel(await window.fileRecall.semanticStatus().catch(() => undefined));
    } finally {
      setInstalling(false);
    }
  }

  async function search(query: string) {
    if (searching || !query.trim()) return;
    invalidate();
    const version = searchVersion.current;
    setSearching(true);
    setProgress(undefined);
    try {
      const next = await window.fileRecall.semanticSearch(query);
      if (version === searchVersion.current) setResult({ query, result: next });
    } catch (err) {
      if (version === searchVersion.current) setError(err instanceof Error ? err.message : "语义搜索失败，请重试。");
    } finally {
      setSearching(false);
    }
  }

  return { model, installing, searching, progress, result, error, install, search, invalidate };
}
