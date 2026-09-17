import { useEffect, useMemo, useRef, useState } from "react";
import type { BootstrapData, BuildIdentity, CustomProviderInput, ExtensionResource, ModelInfo, PackageResource, PiState, PrimaryRuntimeReadiness, SkillResource } from "../../shared/types";
import { useModalFocus } from "../lib/modal-focus";
import { api, PI_CHAT_RELEASES_URL, type UpdateCheckResult } from "../api";
import { DEFAULT_APPEARANCE, snapToStep, type AppearancePreferences, type FontPreference, type ThemePreference } from "../lib/preferences";
import { CompactSelect, type CompactSelectOption } from "./CompactSelect";
import { ChevronDownIcon, ChevronRightIcon, CloseIcon, FolderIcon, MinusIcon, PiMarkIcon, PlusIcon, TrashIcon } from "./Icons";

export type ManagementSection = "settings" | "models";
type SettingsTab = "appearance" | "models" | "skills" | "extensions" | "packages" | "about";

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "appearance", label: "外观" },
  { id: "models", label: "Models" },
  { id: "skills", label: "Skills" },
  { id: "extensions", label: "Extensions" },
  { id: "packages", label: "Packages" },
  { id: "about", label: "关于" },
];

const THEME_OPTIONS: Array<CompactSelectOption<ThemePreference>> = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

const FONT_OPTIONS: Array<CompactSelectOption<FontPreference>> = [
  { value: "system", label: "系统字体" },
  { value: "serif", label: "衬线阅读字体" },
  { value: "mono", label: "等宽字体" },
];

export function ManagementPanel({ section, appearance, workspaceCwd, workspacePicking, workspaceDisabled, models, modelRuntimeSyncPending, state, busy, shutdownBlocked, diagnosticsBusy, buildIdentity, webBuildIdentity, piVersion, primaryRuntime, onClose, onAppearance, onPickWorkspace, onModel, onModelsChanged, onExportDiagnostics, onShutdown }: {
  section: ManagementSection | null;
  appearance: AppearancePreferences;
  /** Persisted default for future drafts; existing Session cwd values stay immutable. */
  workspaceCwd: string;
  workspacePicking: boolean;
  workspaceDisabled: boolean;
  models: ModelInfo[];
  modelRuntimeSyncPending: boolean;
  state: PiState;
  busy: boolean;
  /** Identity mismatch blocks ordinary settings, not the guarded shutdown recovery. */
  shutdownBlocked: boolean;
  diagnosticsBusy: boolean;
  buildIdentity: BuildIdentity;
  webBuildIdentity: BuildIdentity;
  piVersion?: string;
  primaryRuntime: PrimaryRuntimeReadiness;
  onClose: () => void;
  onAppearance: (value: AppearancePreferences) => void;
  onPickWorkspace: () => void;
  onModel: (provider: string, id: string, api?: string) => void;
  onModelsChanged: (data: Pick<
    BootstrapData,
    "models" | "state" | "modelRuntimeSyncPending" | "modelCatalogueRevision"
  >) => void;
  onExportDiagnostics: () => Promise<void>;
  onShutdown: () => void;
}) {
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(() =>
    section === "models" ? "models" : "appearance",
  );
  const previousSectionRef = useRef(section);
  const [skills, setSkills] = useState<SkillResource[]>([]);
  const [extensions, setExtensions] = useState<ExtensionResource[]>([]);
  const [packages, setPackages] = useState<PackageResource[]>([]);
  const [resourceBusy, setResourceBusy] = useState(false);
  const [resourceError, setResourceError] = useState("");
  const [resourceNotice, setResourceNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  useModalFocus(Boolean(section), dialogRef);

  useEffect(() => {
    // Initial state already reflects the requested section. Skipping the mount
    // reset prevents a very fast tab click from being overwritten when the
    // lazy Settings chunk finishes its first passive-effect flush.
    if (previousSectionRef.current === section) return;
    previousSectionRef.current = section;
    setSettingsTab(section === "models" ? "models" : "appearance");
    setResourceError("");
  }, [section]);

  useEffect(() => {
    if (!section) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [section, onClose]);

  useEffect(() => {
    setResourceError("");
    setResourceNotice("");
    if (!section || !["skills", "extensions", "packages"].includes(settingsTab)) return;
    setLoading(true);
    const load = settingsTab === "skills" ? api.skills() : settingsTab === "extensions" ? api.extensions() : api.packages();
    load.then((result) => {
      if (settingsTab === "skills") setSkills(result.resources as SkillResource[]);
      else if (settingsTab === "extensions") setExtensions(result.resources as ExtensionResource[]);
      else setPackages(result.resources as PackageResource[]);
    }).catch((error) => setResourceError(error instanceof Error ? error.message : String(error))).finally(() => setLoading(false));
  }, [section, settingsTab]);
  if (!section) return null;

  const browseResource = async (kind: "skills-root" | "extensions-root" | "packages-root" | "models-root") => {
    setResourceBusy(true);
    setResourceError("");
    setResourceNotice("");
    try {
      const result = await api.browseResource(kind);
      setResourceNotice(`已在资源管理器中打开：${result.path}`);
    } catch (error) {
      setResourceError(error instanceof Error ? error.message : String(error));
    } finally {
      setResourceBusy(false);
    }
  };

  return (
    <div className="panel-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} id="pi-chat-settings-dialog" className="management-panel panel-settings" role="dialog" aria-modal="true" aria-labelledby="management-title">
        <header className="management-head">
          <div>
            <span className="management-kicker">Pi Chat</span>
            <h2 id="management-title">设置</h2>
          </div>
          <button type="button" className="panel-close" onClick={onClose} aria-label="关闭"><CloseIcon /></button>
        </header>

        {(
          <div className="settings-workspace">
            <nav className="settings-nav" aria-label="设置分类">
              <div className="settings-nav-tabs">
                {SETTINGS_TABS.map((tab) => (
                  <button type="button" key={tab.id} className={settingsTab === tab.id ? "is-active" : ""} onClick={() => setSettingsTab(tab.id)}>
                    {tab.label}
                  </button>
                ))}
              </div>
              <button type="button" className="settings-shutdown" disabled={shutdownBlocked} onClick={onShutdown} title="检查全部对话后，关闭所有 Pi Chat 窗口、服务和会话进程">关闭 Pi Chat</button>
            </nav>
            <div className="settings-content">
              {settingsTab === "about" && <AboutPanel
                buildIdentity={buildIdentity}
                webBuildIdentity={webBuildIdentity}
                piVersion={piVersion}
                primaryRuntime={primaryRuntime}
                diagnosticsBusy={diagnosticsBusy}
                onExportDiagnostics={onExportDiagnostics}
              />}
              {settingsTab === "appearance" && <AppearancePanel value={appearance} workspaceCwd={workspaceCwd} workspacePicking={workspacePicking} workspaceDisabled={workspaceDisabled} onChange={onAppearance} onPickWorkspace={onPickWorkspace} />}
              {settingsTab === "models" && <ModelsPanel models={models} modelRuntimeSyncPending={modelRuntimeSyncPending} state={state} busy={busy} browseBusy={resourceBusy} onModel={onModel} onBrowseModels={() => void browseResource("models-root")} onModelsChanged={onModelsChanged} />}
              {settingsTab === "skills" && <SettingsResourceList
                title="Skills"
                description="仅显示当前已启用的 Skill。管理请在本地 agent 目录中进行。"
                loading={loading}
                error={resourceError}
                notice={resourceNotice}
                resources={skills}
                busy={resourceBusy}
                pathFor={(item) => item.packageSource ? `${item.pathLabel} · 来自 ${item.packageSource}` : item.pathLabel}
                onBrowseRoot={() => void browseResource("skills-root")}
                rootLabel="打开 Skills 目录"
              />}
              {settingsTab === "extensions" && <SettingsResourceList
                title="Extensions"
                description="仅显示当前已启用的 Extension。启停与安装请直接编辑本地扩展目录。"
                loading={loading}
                error={resourceError}
                notice={resourceNotice}
                resources={extensions}
                busy={resourceBusy}
                pathFor={(item) => item.packageSource ? `${item.source} · 来自 Package` : item.installedPath || item.source}
                onBrowseRoot={() => void browseResource("extensions-root")}
                rootLabel="打开 Extensions 目录"
              />}
              {settingsTab === "packages" && <SettingsResourceList
                title="Packages"
                description="仅显示当前已启用的 Package。安装来源与集合请在本地 agent/npm 目录管理。"
                loading={loading}
                error={resourceError}
                notice={resourceNotice}
                resources={packages}
                busy={resourceBusy}
                pathFor={(item) => packageSummary(item)}
                onBrowseRoot={() => void browseResource("packages-root")}
                rootLabel="打开 Packages 目录"
              />}
            </div>
          </div>
        )}

      </section>
    </div>
  );
}

function AboutPanel({ buildIdentity, webBuildIdentity, piVersion, primaryRuntime, diagnosticsBusy, onExportDiagnostics }: {
  buildIdentity: BuildIdentity;
  webBuildIdentity: BuildIdentity;
  piVersion?: string;
  primaryRuntime: PrimaryRuntimeReadiness;
  diagnosticsBusy: boolean;
  onExportDiagnostics: () => Promise<void>;
}) {
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<UpdateCheckResult | null>(null);
  const [error, setError] = useState("");
  const check = async () => {
    setChecking(true);
    setError("");
    try {
      setUpdate(await api.checkForUpdates(buildIdentity.packageVersion));
    } catch (cause) {
      setUpdate(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChecking(false);
    }
  };
  const version = buildIdentity.packageVersion || "unknown";
  const identityMismatch = webBuildIdentity.fingerprint !== "unknown"
    && buildIdentity.fingerprint !== "unknown"
    && webBuildIdentity.fingerprint !== buildIdentity.fingerprint;
  const formatBuiltAt = (value: string) => {
    if (!value || value === "unknown") return "unknown";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  };
  return <div className="settings-resource-panel about-panel">
    <div className="settings-resource-heading">
      <div className="settings-resource-title"><h3>关于 Pi Chat</h3><p>版本、运行环境与本地诊断信息。这里不会自动下载或替换任何文件。</p></div>
    </div>
    <div className="about-hero">
      <PiMarkIcon className="about-mark" />
      <div><strong>Pi Chat</strong><span>Local-first Web client for Pi RPC</span></div>
      <code>v{version}</code>
    </div>
    <div className="about-grid">
      <AboutValue label="Pi Chat 版本" value={`v${version}`} />
      <AboutValue label="Pi Runtime" value={piVersion ? `v${piVersion}` : "未发现 / 未就绪"} />
      <AboutValue label="Build Revision" value={buildIdentity.revision} mono />
      <AboutValue label="Build Fingerprint" value={buildIdentity.fingerprint} mono title={buildIdentity.fingerprint} />
      <AboutValue label="构建时间" value={formatBuiltAt(buildIdentity.builtAt)} />
      <AboutValue label="Web / 服务一致性" value={identityMismatch ? "不一致：请完整重启" : "一致"} tone={identityMismatch ? "warning" : "ok"} />
    </div>
    {primaryRuntime.status === "failed" && <div className="about-notice is-warning">Primary Runtime 暂不可用，但历史 Session 与 JSONL 浏览仍可继续。{primaryRuntime.error ? ` ${primaryRuntime.error}` : ""}</div>}
    {error && <div className="resource-error">{error}</div>}
    {update && <div className={`about-update ${update.updateAvailable ? "is-update" : "is-current"}`}>
      <strong>{update.updateAvailable ? `发现新版本 v${update.latestVersion}` : update.updateAvailable === false ? "当前已是最新版本" : `已找到最新版本 v${update.latestVersion}`}</strong>
      <span>当前 v{version} · {update.publishedAt ? new Date(update.publishedAt).toLocaleDateString() : ""}</span>
      <a href={update.releaseUrl || PI_CHAT_RELEASES_URL} target="_blank" rel="noreferrer">查看 Release</a>
    </div>}
    <div className="about-actions">
      <button type="button" className="about-primary-action" disabled={checking} onClick={() => void check()}>{checking ? "正在检查…" : "检查更新"}</button>
      <a className="about-link-button" href={PI_CHAT_RELEASES_URL} target="_blank" rel="noreferrer">打开 GitHub Releases</a>
    </div>
    <p className="about-footnote">检查更新仅在你主动点击后访问 GitHub Release API；不会自动安装、重启或部署。</p>
    <div className="about-diagnostics-section">
      <DiagnosticsPanel busy={diagnosticsBusy} onExport={onExportDiagnostics} />
    </div>
  </div>;
}

function AboutValue({ label, value, mono, title, tone }: { label: string; value: string; mono?: boolean; title?: string; tone?: "ok" | "warning" }) {
  return <div className="about-value"><small>{label}</small><code className={`${mono ? "is-mono " : ""}${tone ? `is-${tone}` : ""}`} title={title || value}>{value}</code></div>;
}

function DiagnosticsPanel({ busy, onExport }: {
  busy: boolean;
  onExport: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const run = async (operation: () => Promise<void>) => {
    setError("");
    try { await operation(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="settings-resource-panel diagnostics-panel">
    <div className="settings-resource-heading">
      <div className="settings-resource-title">
        <h3>状态诊断<span className="count-badge">自动保留</span></h3>
        <p>Pi Chat 会在内存中自动保留最近五分钟的脱敏结构状态，用于定位 Runtime、SSE、Sidebar、Composer 和队列投影不一致。</p>
      </div>
    </div>
    <div className="diagnostics-privacy">
      不包含请求 token、聊天正文、草稿正文、图片数据、文件路径、密钥、原始错误堆栈或稳定 Session ID。服务端与当前浏览器页面各自保存本地顺序；页面刷新后浏览器记录会消失。
    </div>
    {error && <div className="resource-error">{error}</div>}
    <div className="diagnostics-actions">
      <button type="button" disabled={busy} onClick={() => void run(onExport)}>导出最近五分钟诊断</button>
    </div>
    <p className="resource-loading">问题出现后请尽量不要刷新页面，直接回到这里导出。</p>
  </div>;
}

function ModelsPanel({ models, modelRuntimeSyncPending, state, busy, browseBusy, onModel, onBrowseModels, onModelsChanged }: {
  models: ModelInfo[];
  modelRuntimeSyncPending: boolean;
  state: PiState;
  busy: boolean;
  browseBusy: boolean;
  onModel: (provider: string, id: string, api?: string) => void;
  onBrowseModels: () => void;
  onModelsChanged: (data: Pick<
    BootstrapData,
    "models" | "state" | "modelRuntimeSyncPending" | "modelCatalogueRevision"
  >) => void;
}) {
  const [editingProvider, setEditingProvider] = useState<CustomProviderInput | null>(null);
  const [editingProviderKey, setEditingProviderKey] = useState("");
  const [expandedProvider, setExpandedProvider] = useState("");
  const providerLoadSequence = useRef(0);
  useEffect(() => () => { providerLoadSequence.current += 1; }, []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const modelGroups = useMemo(() => {
    const groups = new Map<string, ModelInfo[]>();
    for (const model of models) groups.set(model.provider, [...(groups.get(model.provider) || []), model]);
    return [...groups.entries()];
  }, [models]);
  const closeProvider = () => {
    providerLoadSequence.current += 1;
    setExpandedProvider("");
    setEditingProvider(null);
    setEditingProviderKey("");
  };
  const beginAddProvider = () => {
    if (busy || saving) return;
    providerLoadSequence.current += 1;
    setEditingProviderKey("");
    setExpandedProvider("__new__");
    setEditingProvider({ provider: "", baseUrl: "", api: "openai-completions", apiKey: "", models: [{ id: "", name: "" }] });
    setError(""); setNotice("");
  };
  const beginEditProvider = async (provider: string, custom: boolean) => {
    if (saving) return;
    if (expandedProvider === provider) {
      closeProvider();
      return;
    }
    const sequence = ++providerLoadSequence.current;
    setExpandedProvider(provider);
    setEditingProviderKey(provider);
    setEditingProvider(null);
    setError(""); setNotice("");
    if (!custom) {
      // Built-in/login-backed Providers are owned by Pi. They have no
      // models.json URL or API key to edit; expansion is read-only.
      setEditingProviderKey("");
      return;
    }
    try {
      const result = await api.getCustomProvider(provider);
      if (sequence !== providerLoadSequence.current) return;
      setEditingProvider({ ...result.provider, apiKey: "" });
    } catch (cause) {
      if (sequence === providerLoadSequence.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setEditingProviderKey("");
      }
    }
  };
  const updateProvider = <K extends keyof CustomProviderInput>(key: K, value: CustomProviderInput[K]) => setEditingProvider((current) => current ? { ...current, [key]: value } : current);
  const updateModel = (index: number, key: "id" | "name" | "contextWindow" | "maxTokens", value: string) => setEditingProvider((current) => {
    if (!current) return current;
    const models = current.models.map((model, modelIndex) => modelIndex === index ? { ...model, [key]: key === "contextWindow" || key === "maxTokens" ? (value ? Number(value) : undefined) : value } : model);
    return { ...current, models };
  });
  const addModelRow = () => setEditingProvider((current) => current ? { ...current, models: [...current.models, { id: "", name: "" }] } : current);
  const removeModelRow = (index: number) => setEditingProvider((current) => current && current.models.length > 1 ? { ...current, models: current.models.filter((_, modelIndex) => modelIndex !== index) } : current);
  const saveProvider = async () => {
    if (!editingProvider || saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      let result;
      if (editingProviderKey) result = await api.updateCustomProvider(editingProviderKey, editingProvider);
      else result = await api.addCustomProvider(editingProvider);
      onModelsChanged(result);
      closeProvider();
      setNotice("Provider 配置已保存，Runtime 将在安全空闲点同步。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  const removeProvider = async (provider: string) => {
    if (saving || !window.confirm(`删除自定义提供方 ${provider} 及其全部模型？`)) return;
    setSaving(true); setError(""); setNotice("");
    try {
      onModelsChanged(await api.deleteCustomProvider(provider));
      if (expandedProvider === provider) closeProvider();
      setNotice("Provider 已删除。");
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  const providerEditor = editingProvider ? <div className="model-editor model-provider-editor" aria-label={editingProviderKey ? "编辑 Provider" : "添加 Provider"}>
    <div className="model-editor-head"><strong>{editingProviderKey ? `${editingProviderKey} 配置` : "添加自定义提供方"}</strong><button type="button" disabled={saving} onClick={closeProvider}>取消</button></div>
    <div className="model-editor-grid"><label>Provider<input value={editingProvider.provider} disabled={Boolean(editingProviderKey) || busy || saving} onChange={(event) => updateProvider("provider", event.target.value)} /></label><label>API 协议<select value={editingProvider.api} disabled={busy || saving} onChange={(event) => updateProvider("api", event.target.value as CustomProviderInput["api"])}><option value="openai-completions">openai-completions</option><option value="openai-responses">openai-responses</option><option value="anthropic-messages">anthropic-messages</option><option value="google-generative-ai">google-generative-ai</option></select></label><label className="model-editor-wide">API 地址<input value={editingProvider.baseUrl} disabled={busy || saving} placeholder="https://api.example.com/v1" onChange={(event) => updateProvider("baseUrl", event.target.value)} /></label><label className="model-editor-wide">API 密钥<input type="password" value={editingProvider.apiKey || ""} disabled={busy || saving} placeholder="已配置 — 输入新值以替换" onChange={(event) => updateProvider("apiKey", event.target.value)} /></label></div>
    <div className="provider-models-heading"><span>ID</span><span>显示名称</span><span>上下文</span><span>最大输出</span><span aria-hidden="true" /></div>
    <div className="provider-model-editor-list">{editingProvider.models.map((model, index) => <div className="provider-model-editor-row" key={index}><input aria-label={`模型 ${index + 1} ID`} placeholder="Model ID" value={model.id} disabled={busy || saving} onChange={(event) => updateModel(index, "id", event.target.value)} /><input aria-label={`模型 ${index + 1} 名称`} placeholder="显示名称" value={model.name} disabled={busy || saving} onChange={(event) => updateModel(index, "name", event.target.value)} /><input aria-label={`模型 ${index + 1} 上下文大小`} type="number" min="1" placeholder="上下文" value={model.contextWindow || ""} disabled={busy || saving} onChange={(event) => updateModel(index, "contextWindow", event.target.value)} /><input aria-label={`模型 ${index + 1} 最大输出`} type="number" min="1" placeholder="最大输出" value={model.maxTokens || ""} disabled={busy || saving} onChange={(event) => updateModel(index, "maxTokens", event.target.value)} /><button type="button" className="model-trash-button" aria-label={`删除模型 ${model.id || index + 1}`} title="删除模型条目" disabled={editingProvider.models.length <= 1 || busy || saving} onClick={() => removeModelRow(index)}><TrashIcon /></button></div>)}</div>
    <button type="button" className="model-inline-add" disabled={busy || saving} onClick={addModelRow}>＋ 添加模型</button><div className="model-editor-footer"><span>保存不会修改当前正在执行的 Prompt。</span><button type="button" className="model-save-button" disabled={saving || busy} onClick={() => void saveProvider()}>{saving ? "保存中…" : "保存"}</button></div>
  </div> : null;
  return <div className="settings-resource-panel models-panel">
    <div className="settings-resource-heading"><div className="settings-resource-title"><h3>模型<span className="count-badge">{models.length}</span></h3><p>按 Provider 管理自定义连接和模型目录。内置登录 Provider 由 Pi Runtime 管理。</p><span className={`model-runtime-status ${modelRuntimeSyncPending ? "is-pending" : "is-ready"}`}>{modelRuntimeSyncPending ? "Runtime 等待同步" : "Runtime 已同步"}</span></div><div className="models-panel-actions"><button type="button" className="model-add-button" disabled={busy || saving} onClick={beginAddProvider}>添加自定义提供方</button><button type="button" className="resource-browse-root" title="打开 models.json 所在目录" aria-label="打开 models.json 所在目录" disabled={browseBusy} onClick={onBrowseModels}><FolderIcon /></button></div></div>
    {error && <div className="resource-error">{error}</div>}{notice && !error && <div className="resource-notice">{notice}</div>}
    {expandedProvider === "__new__" && providerEditor}
    <div className="model-provider-list">{modelGroups.map(([provider, providerModels]) => { const custom = providerModels.some((model) => model.source === "models-json" || model.custom); const expanded = expandedProvider === provider; return <section className={`model-provider-card ${expanded ? "is-expanded" : ""}`} key={provider}><header className="model-provider-head" role="button" tabIndex={0} onClick={() => void beginEditProvider(provider, custom)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") void beginEditProvider(provider, custom); }}><div><span className="model-provider-chevron">{expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}</span><strong>{provider}</strong>{custom && <span className="model-custom-badge">自定义</span>}<i className="model-health-dot" title="已发现" /></div><div className="model-provider-actions"><span className="model-provider-count">{providerModels.length} 个模型</span>{custom ? <><button type="button" disabled={saving} onClick={(event) => { event.stopPropagation(); void beginEditProvider(provider, custom); }}>编辑</button><button type="button" className="model-delete-action" disabled={busy || saving} onClick={(event) => { event.stopPropagation(); void removeProvider(provider); }}>删除</button></> : <span className="model-provider-managed">{providerModels.some((model) => model.authMode === "pi-managed") ? "Pi 登录管理" : "Pi Runtime 管理"}</span>}</div></header>{expanded && (editingProviderKey === provider && editingProvider ? providerEditor : custom ? <p className="model-provider-loading">正在读取 Provider 配置…</p> : <><p className="model-provider-readonly">这是 Pi 内置登录 Provider，地址、密钥和模型目录由 Pi Runtime 管理。</p><div className="model-provider-rows">{providerModels.map((model) => { const active = state.model?.provider === model.provider && state.model?.id === model.id; return <article className={`model-provider-row ${active ? "is-active" : ""}`} key={`${model.provider}/${model.id}/${model.api || ""}`}><button type="button" className="model-select-row" disabled={busy || active} onClick={() => onModel(model.provider, model.id, model.api)} title={`${model.provider}/${model.id}`}><code>{model.id}</code><span>{model.name !== model.id ? model.name : ""}</span>{model.api && <small>{model.api}</small>}{model.contextWindow && <em>{Math.round(model.contextWindow / 1000)}k</em>}</button></article>; })}</div></>)}</section>; })}{!models.length && <p className="resource-loading">当前没有可用模型</p>}</div>
  </div>;
}

function filterList<T>(items: T[], filter: string, text: (item: T) => string): T[] {
  const needle = filter.trim().toLowerCase();
  return needle ? items.filter((item) => text(item).toLowerCase().includes(needle)) : items;
}

function Search({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <input className="panel-search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />;
}

function PanelIntro({ title, description, count }: { title: string; description?: string; count?: number }) {
  return <div className="panel-intro"><div><h3>{title}{typeof count === "number" && <span className="count-badge">{count}</span>}</h3>{description && <p>{description}</p>}</div></div>;
}

function packageSummary(item: PackageResource): string {
  const counts = item.resources.reduce<Record<string, number>>((result, resource) => ({ ...result, [resource.kind]: (result[resource.kind] || 0) + 1 }), {});
  const labels = (["extension", "skill", "prompt", "theme"] as const).flatMap((kind) => counts[kind] ? [`${counts[kind]} ${kind === "extension" ? "Extensions" : kind === "skill" ? "Skills" : kind === "prompt" ? "Prompts" : "Themes"}`] : []);
  return `${item.source}${item.version ? ` · v${item.version}` : ""}${labels.length ? ` · 含 ${labels.join(" · ")}` : ""}`;
}

function SettingsResourceList<T extends { id: string; name: string }>({ title, description, loading, error, notice, resources, busy, pathFor, onBrowseRoot, rootLabel }: {
  title: string;
  description: string;
  loading: boolean;
  error: string;
  notice?: string;
  resources: T[];
  busy: boolean;
  pathFor: (item: T) => string;
  onBrowseRoot: () => void;
  rootLabel: string;
}) {
  return <div className="settings-resource-panel">
    <div className="settings-resource-heading">
      <div className="settings-resource-title"><h3>{title}<span className="count-badge">{resources.length}</span></h3><p>{description}</p></div>
      <button type="button" className="resource-browse-root" title={rootLabel} aria-label={rootLabel} disabled={busy || loading} onClick={onBrowseRoot}><FolderIcon /></button>
    </div>
    {error && <div className="resource-error">{error}</div>}
    {notice && !error && <div className="resource-notice">{notice}</div>}
    <div className="settings-resource-list">
      {loading ? <p className="resource-loading">正在扫描…</p> : resources.map((item) => <article key={item.id} className="settings-resource-row">
        <div><strong>{item.name}</strong><code title={pathFor(item)}>{pathFor(item)}</code></div>
      </article>)}
      {!loading && !resources.length && <p className="resource-loading">当前没有已启用的 {title}</p>}
    </div>
  </div>;
}

function AppearancePanel({ value, workspaceCwd, workspacePicking, workspaceDisabled, onChange, onPickWorkspace }: {
  value: AppearancePreferences;
  workspaceCwd: string;
  workspacePicking: boolean;
  workspaceDisabled: boolean;
  onChange: (value: AppearancePreferences) => void;
  onPickWorkspace: () => void;
}) {
  const update = <K extends keyof AppearancePreferences>(key: K, next: AppearancePreferences[K]) => onChange({ ...value, [key]: next });
  const isDefault = Object.keys(DEFAULT_APPEARANCE).every((key) => value[key as keyof AppearancePreferences] === DEFAULT_APPEARANCE[key as keyof AppearancePreferences]);
  return <div className="panel-body appearance-panel">
    <div className="appearance-panel-heading">
      <PanelIntro title="外观与阅读" />
      <button type="button" className="appearance-reset" disabled={isDefault} onClick={() => onChange({ ...DEFAULT_APPEARANCE })}>重置外观</button>
    </div>
    <SettingRow title="默认工作路径" description="仅用于以后新建的对话；已有对话不会改变">
      <div className="workspace-setting-control">
        <code title={workspaceCwd}>{workspaceCwd || "未设置工作路径"}</code>
        <button type="button" className="workspace-picker" disabled={workspaceDisabled || workspacePicking} onClick={onPickWorkspace} title="选择默认工作路径" aria-label="选择默认工作路径"><FolderIcon /></button>
      </div>
    </SettingRow>
    <SettingRow title="主题"><CompactSelect value={value.theme} options={THEME_OPTIONS} ariaLabel="主题" title="主题" align="right" className="appearance-select" onChange={(next) => update("theme", next)} /></SettingRow>
    <SettingRow title="聊天字体"><CompactSelect value={value.font} options={FONT_OPTIONS} ariaLabel="聊天字体" title="聊天字体" align="right" className="appearance-select" onChange={(next) => update("font", next)} /></SettingRow>
    <StepperSetting title="字号" hint="10 ~ 30 px" value={value.fontSize} minimum={10} maximum={30} step={1} onChange={(next) => update("fontSize", next)} />
    <StepperSetting title="行间距" hint="1.0 ~ 3.0" value={value.lineHeight} minimum={1.0} maximum={3.0} step={0.1} decimals={1} onChange={(next) => update("lineHeight", next)} />
    <StepperSetting title="对话宽度" hint="600 ~ 1200 px" value={value.chatWidth} minimum={600} maximum={1200} step={50} onChange={(next) => update("chatWidth", next)} />
    <details className="markdown-css-settings">
      <summary>更多外观设置 · Markdown CSS</summary>
      <p>仅用于调整聊天 Markdown 的显示。请使用 <code>.markdown-body</code> 作为每条规则的选择器前缀，避免影响其他界面。</p>
      <textarea value={value.markdownCss} onChange={(event) => update("markdownCss", event.target.value)} spellCheck={false} placeholder={".markdown-body h1 {\n  color: #2368d8;\n}\n\n.markdown-body blockquote {\n  border-left-width: 5px;\n}"} aria-label="Markdown 自定义 CSS" />
      <button type="button" className="markdown-css-clear" disabled={!value.markdownCss} onClick={() => update("markdownCss", "")}>清空自定义 CSS</button>
    </details>
  </div>;
}

function SettingRow({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  // Custom controls contain buttons/listboxes, so a label wrapper would create invalid nested interactive content.
  return <div className="setting-row"><span><strong>{title}</strong>{description && <small>{description}</small>}</span>{children}</div>;
}

function StepperSetting({ title, hint, value, minimum, maximum, step, suffix, decimals = 0, onChange }: {
  title: string;
  hint?: string;
  value: number;
  minimum: number;
  maximum: number;
  step: number;
  suffix?: string;
  decimals?: number;
  onChange: (value: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const valueRef = useRef(value);
  valueRef.current = value;
  const repeatRef = useRef<{ timeout?: number; interval?: number }>({});
  const pointerActiveRef = useRef(false);

  const stopRepeat = () => {
    window.clearTimeout(repeatRef.current.timeout);
    window.clearInterval(repeatRef.current.interval);
    repeatRef.current = {};
  };
  useEffect(() => stopRepeat, []);

  const applyStep = (direction: 1 | -1) => {
    const next = snapToStep(valueRef.current + direction * step, minimum, maximum, step);
    if (next === valueRef.current) {
      stopRepeat();
      return;
    }
    onChange(next);
  };
  const beginRepeat = (direction: 1 | -1) => {
    stopRepeat();
    applyStep(direction);
    repeatRef.current.timeout = window.setTimeout(() => {
      repeatRef.current.interval = window.setInterval(() => applyStep(direction), 90);
    }, 420);
  };

  const commitDraft = () => {
    const parsed = Number(draft.trim().replace(/px$/i, ""));
    if (draft.trim() && Number.isFinite(parsed)) onChange(snapToStep(parsed, minimum, maximum, step));
    setEditing(false);
  };

  return <div className="stepper-setting">
    <span className="stepper-setting-label"><strong>{title}</strong>{hint && <small>{hint}</small>}</span>
    <div className="stepper" role="group" aria-label={title}>
      <button type="button" className="stepper-button" disabled={value <= minimum} aria-label={`减小${title}`}
        onPointerDown={() => { pointerActiveRef.current = true; beginRepeat(-1); }}
        onPointerUp={stopRepeat} onPointerLeave={stopRepeat} onPointerCancel={stopRepeat}
        onClick={() => { if (pointerActiveRef.current) { pointerActiveRef.current = false; return; } applyStep(-1); }}
      ><MinusIcon /></button>
      {editing
        ? <input className="stepper-input" value={draft} autoFocus inputMode="decimal" aria-label={`${title}数值`}
            onChange={(event) => setDraft(event.target.value)} onBlur={commitDraft}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); commitDraft(); }
              if (event.key === "Escape") { event.preventDefault(); setEditing(false); }
            }} />
        : <button type="button" className="stepper-value" title="点击输入精确数值（自动纠正到档位）" aria-label={`${title}当前值 ${value.toFixed(decimals)}${suffix}`}
            onClick={() => { setDraft(String(Number(value.toFixed(decimals)))); setEditing(true); }}
          >{value.toFixed(decimals)}{suffix}</button>}
      <button type="button" className="stepper-button" disabled={value >= maximum} aria-label={`增大${title}`}
        onPointerDown={() => { pointerActiveRef.current = true; beginRepeat(1); }}
        onPointerUp={stopRepeat} onPointerLeave={stopRepeat} onPointerCancel={stopRepeat}
        onClick={() => { if (pointerActiveRef.current) { pointerActiveRef.current = false; return; } applyStep(1); }}
      ><PlusIcon /></button>
    </div>
  </div>;
}
