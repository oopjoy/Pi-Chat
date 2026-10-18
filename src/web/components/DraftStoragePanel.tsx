import { useState } from "react";
import { api } from "../api";
import { DraftRecoveryStore } from "../lib/draft-recovery";

export function DraftStoragePanel() {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [summary, setSummary] = useState("");
  const run = async (action: "inspect" | "clear" | "cleanup" | "open") => {
    if (busy) return;
    if (action === "clear" && !window.confirm("清除这个浏览器保存的所有草稿备份和图片备份？当前编辑内容及 Pi 历史不会删除；继续编辑或完成尚在进行的输入操作会重新备份。")) return;
    if (action === "open" && !window.confirm("打开附件保存目录？已发送附件也在这里，手动删除会使对应历史路径失效；Pi Chat 不会替你删除它们。")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const store = new DraftRecoveryStore(setError);
      if (action === "open") {
        await api.openAttachmentStorage();
        setNotice("已打开附件目录；没有自动删除任何文件。");
      } else if (action === "clear") {
        await store.clear();
        window.dispatchEvent(new Event("pi-chat-draft-storage-cleared"));
        setSummary("");
        setNotice("已清除旧的浏览器草稿备份；当前输入和已发送附件未删除。继续编辑会重新备份。");
      } else {
        await store.cleanup();
        const records = await store.records();
        if (action === "cleanup") {
          // A browser backup can outlive an offline service. Renew all files
          // still referenced by this browser before asking for safe collection.
          const paths = [...new Set(records.flatMap((record) => record.frames.flatMap((frame) => frame.files)))];
          if (paths.length > 2048) throw new Error("附件备份过多，安全清理已取消；请先处理旧草稿。");
          for (let i = 0; i < paths.length; i += 16) {
            const { missing } = await api.leaseLocalFiles(paths.slice(i, i + 16), true, "browser-backup");
            if (missing.length) throw new Error("部分草稿附件已经失效，未继续清理；请先核对或恢复草稿。");
          }
        }
        const attachments = await api.attachmentStorage(action === "cleanup");
        setSummary(`本浏览器 ${records.length} 份备份；附件存储 ${attachments.drafts} 个待发文件、${attachments.retained} 个已保留文件，共 ${(attachments.bytes / 1024 / 1024).toFixed(1)} MB${attachments.skipped ? `；${attachments.skipped} 项未知或暂不可检查，已保守保留` : ""}${attachments.truncated ? "（扫描已达上限）" : ""}。`);
        if (action === "cleanup") setNotice(`已清理 ${attachments.removed} 个过期待发附件；已保留文件不受影响。`);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <section className="about-diagnostics-section" aria-label="草稿与附件保存">
    <h3>草稿与附件保存</h3>
    <p>草稿只在本机浏览器备份，保留 30 天。恢复不会自动发送；发送结果未确认的内容需要先核对历史。</p>
    <p>新拖入的文件保存在本机 PiChatData 用户数据目录，不依赖 Windows 临时目录或安装目录。已发送或可能已发送的附件不按时间自动删除；安全清理只回收过期且无人使用的待发文件。</p>
    <div className="draft-storage-actions">
      <button type="button" className="about-link-button" disabled={busy} onClick={() => void run("inspect")}>查看保存情况</button>
      <button type="button" className="about-link-button" disabled={busy} onClick={() => void run("clear")}>清除草稿备份</button>
      <button type="button" className="about-link-button" disabled={busy} onClick={() => void run("cleanup")}>清理过期待发附件</button>
      <button type="button" className="about-link-button" disabled={busy} onClick={() => void run("open")}>打开附件目录</button>
    </div>
    {summary && <p>{summary}</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    <small>本地备份不是加密保险箱。清除浏览器站点数据、外部删除文件或磁盘故障仍可能导致无法恢复。旧版临时目录文件不参与自动清理，也不会擅自改写历史路径。</small>
  </section>;
}
