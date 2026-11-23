import { useState } from "react";

export default function FileNotes({ path, identity, initial }: {
  path: string;
  identity: string;
  initial: FileAnnotation;
}) {
  const [favorite, setFavorite] = useState(initial.favorite);
  const [note, setNote] = useState(initial.note);
  const [tags, setTags] = useState(initial.tags.join("、"));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  return <details className="detail-section file-notes">
    <summary>{favorite ? "★ " : ""}收藏、备注和标签</summary>
    <form onSubmit={async (event) => {
      event.preventDefault();
      setSaving(true);
      try {
        const saved = await window.fileRecall.annotate(path, identity, {
          favorite, note, tags: tags.split(/[,，、]/).map((tag) => tag.trim()).filter(Boolean),
        });
        setNote(saved.note);
        setTags(saved.tags.join("、"));
        setMessage("已保存在本机。");
      } catch (error) { setMessage(error instanceof Error ? error.message : "无法保存。"); }
      finally { setSaving(false); }
    }}>
      <label><input type="checkbox" checked={favorite} onChange={(event) => setFavorite(event.target.checked)} /> 收藏文件</label>
      <label>备注<textarea rows={3} maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} /></label>
      <label>标签<input value={tags} maxLength={310} placeholder="合同、报税" onChange={(event) => setTags(event.target.value)} /></label>
      <button disabled={saving}>保存</button>
      {message && <p role="status" className="muted">{message}</p>}
    </form>
  </details>;
}
