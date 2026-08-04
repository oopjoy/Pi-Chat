import { useEffect, useMemo, useRef, useState } from "react";
import type { ExtensionResource, ModelInfo, PackageResource, PiState, SkillResource } from "../../shared/types";
import { useModalFocus } from "../lib/modal-focus";
import { api } from "../api";
import { DEFAULT_APPEARANCE, snapToStep, type AppearancePreferences, type FontPreference, type ThemePreference } from "../lib/preferences";
import { CompactSelect, type CompactSelectOption } from "./CompactSelect";
import { CloseIcon, FolderIcon, MinusIcon, PlusIcon } from "./Icons";

export type ManagementSection = "settings" | "models";
type SettingsTab = "appearance" | "models" | "skills" | "extensions" | "packages";

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "appearance", label: "外观" },
  { id: "models", label: "Models" },
  { id: "skills", label: "Skills" },
  { id: "extensions", label: "Extensions" },
  { id: "packages", label: "Packages" },
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

export function ManagementPanel({ section, appearance, models, state, busy, shutdownBlocked, onClose, onAppearance, onModel, onShutdown }: {
  section: ManagementSection | null;
  appearance: AppearancePreferences;
  models: ModelInfo[];
  state: PiState;
  busy: boolean;
  /** Identity mismatch blocks ordinary settings, not the guarded shutdown recovery. */
  shutdownBlocked: boolean;
  onClose: () => void;
  onAppearance: (value: AppearancePreferences) => void;
  onModel: (provider: string, id: string) => void;
  onShutdown: () => void;
}) {
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("appearance");
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
              {settingsTab === "appearance" && <AppearancePanel value={appearance} onChange={onAppearance} />}
              {settingsTab === "models" && <ModelsPanel models={models} state={state} busy={busy} browseBusy={resourceBusy} onModel={onModel} onBrowseModels={() => void browseResource("models-root")} />}
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

function ModelsPanel({ models, state, busy, browseBusy, onModel, onBrowseModels }: {
  models: ModelInfo[];
  state: PiState;
  busy: boolean;
  browseBusy: boolean;
  onModel: (provider: string, id: string) => void;
  onBrowseModels: () => void;
}) {
  return <div className="settings-resource-panel models-panel">
    <div className="settings-resource-heading">
      <div className="settings-resource-title"><h3>Models<span className="count-badge">{models.length}</span></h3><p>只读显示当前可用模型；在本地 models.json 中管理自定义模型。</p></div>
      <button type="button" className="resource-browse-root" title="打开 models.json 所在目录" aria-label="打开 models.json 所在目录" disabled={browseBusy} onClick={onBrowseModels}><FolderIcon /></button>
    </div>
    <div className="settings-resource-list">{models.map((model) => {
      const active = state.model?.provider === model.provider && state.model?.id === model.id;
      return <article className={`settings-resource-row model-resource-row ${active ? "is-active" : ""}`} key={`${model.provider}/${model.id}`}>
        <button type="button" disabled={busy || active} onClick={() => onModel(model.provider, model.id)} title={`${model.provider}/${model.id}`}>
          <strong>{model.provider}</strong><code>{model.id}</code>{model.contextWindow && <span>{Math.round(model.contextWindow / 1000)}k</span>}
        </button>
      </article>;
    })}{!models.length && <p className="resource-loading">当前没有可用模型</p>}</div>
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

function AppearancePanel({ value, onChange }: { value: AppearancePreferences; onChange: (value: AppearancePreferences) => void }) {
  const update = <K extends keyof AppearancePreferences>(key: K, next: AppearancePreferences[K]) => onChange({ ...value, [key]: next });
  const isDefault = Object.keys(DEFAULT_APPEARANCE).every((key) => value[key as keyof AppearancePreferences] === DEFAULT_APPEARANCE[key as keyof AppearancePreferences]);
  return <div className="panel-body appearance-panel">
    <div className="appearance-panel-heading">
      <PanelIntro title="外观与阅读" />
      <button type="button" className="appearance-reset" disabled={isDefault} onClick={() => onChange({ ...DEFAULT_APPEARANCE })}>重置外观</button>
    </div>
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
