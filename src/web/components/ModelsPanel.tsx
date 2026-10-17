import { useEffect, useMemo, useState } from "react";
import type { BootstrapData, CustomModelInput, CustomProviderInput, ModelInfo, PiState } from "../../shared/types";
import { api } from "../api";
import {
  EMPTY_MODEL_PREFERENCES,
  modelPreferenceKey,
  type ModelPreferencesSnapshot,
} from "../lib/model-preferences";
import { ChevronRightIcon, FolderIcon, StarIcon } from "./Icons";

type PanelView =
  | { kind: "catalog" }
  | { kind: "providers" }
  | { kind: "edit-provider"; provider: string }
  | { kind: "add-provider" }
  | { kind: "edit-model"; provider: string; id: string }
  | { kind: "add-model" };

const APIS: CustomProviderInput["api"][] = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
];

function isCustomModel(model: ModelInfo): boolean {
  return model.source === "models-json" || model.custom === true;
}

function formatContext(model: ModelInfo): string {
  return model.contextWindow ? `${Math.round(model.contextWindow / 1000)}K` : "";
}

function emptyProvider(): CustomProviderInput {
  return { provider: "", baseUrl: "", api: "openai-completions", apiKey: "", models: [{ id: "", name: "" }] };
}

function emptyModel(provider = ""): CustomModelInput {
  return {
    provider,
    id: "",
    name: "",
    api: "openai-completions",
    reasoning: false,
    imageInput: false,
  };
}

export function ModelsPanel({
  models,
  modelRuntimeSyncPending,
  state,
  busy,
  browseBusy,
  onModel,
  onBrowseModels,
  onModelsChanged,
}: {
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
  const [view, setView] = useState<PanelView>({ kind: "catalog" });
  const [prefs, setPrefs] = useState<ModelPreferencesSnapshot>(EMPTY_MODEL_PREFERENCES);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [providerDraft, setProviderDraft] = useState<CustomProviderInput | null>(null);
  const [modelDraft, setModelDraft] = useState<CustomModelInput | null>(null);

  const reloadPrefs = async () => {
    try { setPrefs(await api.modelPreferences()); }
    catch { /* keep last snapshot */ }
  };

  useEffect(() => { void reloadPrefs(); }, [models]);

  const current = state.model;
  const currentKey = current ? modelPreferenceKey(current.provider, current.id) : "";
  const defaultKey = prefs.defaultProvider && prefs.defaultModel
    ? modelPreferenceKey(prefs.defaultProvider, prefs.defaultModel)
    : "";
  const favoriteSet = useMemo(() => new Set(prefs.favorites), [prefs.favorites]);

  const orderedModels = useMemo(() => {
    const rank = (model: ModelInfo) => {
      const key = modelPreferenceKey(model.provider, model.id);
      if (key === currentKey) return 0;
      if (favoriteSet.has(key)) return 1;
      return 2;
    };
    return [...models].sort((left, right) => {
      const delta = rank(left) - rank(right);
      if (delta) return delta;
      return `${left.provider}/${left.name}`.localeCompare(`${right.provider}/${right.name}`);
    });
  }, [currentKey, favoriteSet, models]);

  const providers = useMemo(() => {
    const groups = new Map<string, ModelInfo[]>();
    for (const model of models) groups.set(model.provider, [...(groups.get(model.provider) || []), model]);
    return [...groups.entries()];
  }, [models]);

  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
  const goCatalog = () => {
    setView({ kind: "catalog" });
    setProviderDraft(null);
    setModelDraft(null);
    setAdvanced(false);
  };

  const useInSession = (model: ModelInfo) => {
    onModel(model.provider, model.id, model.api);
    void api.patchModelPreferences({ used: { provider: model.provider, id: model.id } })
      .then(setPrefs)
      .catch(() => undefined);
  };

  const toggleFavorite = async (model: ModelInfo) => {
    const key = modelPreferenceKey(model.provider, model.id);
    setPrefs(await api.patchModelPreferences({
      favorite: { provider: model.provider, id: model.id, on: !favoriteSet.has(key) },
    }));
  };

  const setDefault = async (model: ModelInfo) => {
    setPrefs(await api.patchModelPreferences({ default: { provider: model.provider, id: model.id } }));
    setNotice(`新会话默认已设为 ${model.name || model.id}。当前会话未改变。`);
  };

  const openProvider = async (provider: string) => {
    setError(""); setNotice("");
    setView({ kind: "edit-provider", provider });
    setProviderDraft(null);
    try { setProviderDraft((await api.getCustomProvider(provider)).provider); }
    catch (cause) { fail(cause); setView({ kind: "providers" }); }
  };

  const openModel = async (provider: string, id: string) => {
    setError(""); setNotice(""); setAdvanced(false);
    setView({ kind: "edit-model", provider, id });
    setModelDraft(null);
    try { setModelDraft((await api.getCustomModel(provider, id)).model); }
    catch (cause) { fail(cause); goCatalog(); }
  };

  const saveProvider = async () => {
    if (!providerDraft || saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const result = view.kind === "add-provider"
        ? await api.addCustomProvider(providerDraft)
        : await api.updateCustomProvider((view as { provider: string }).provider, providerDraft);
      onModelsChanged(result);
      setNotice("连接配置已保存，正在刷新模型目录。当前请求仍使用原配置。");
      setView({ kind: "providers" });
      setProviderDraft(null);
    } catch (cause) { fail(cause); }
    finally { setSaving(false); }
  };

  const saveModel = async () => {
    if (!modelDraft || saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const result = view.kind === "add-model"
        ? await api.addCustomModel(modelDraft)
        : await api.updateCustomModel((view as { provider: string }).provider, (view as { id: string }).id, modelDraft);
      onModelsChanged(result);
      setNotice("模型已保存，正在刷新模型目录。当前请求仍使用原配置。");
      goCatalog();
    } catch (cause) { fail(cause); }
    finally { setSaving(false); }
  };

  const removeProvider = async (provider: string) => {
    if (saving || !window.confirm(`删除自定义提供方 ${provider} 及其全部模型？`)) return;
    setSaving(true); setError(""); setNotice("");
    try {
      onModelsChanged(await api.deleteCustomProvider(provider));
      setNotice("Provider 已删除。");
      if (view.kind === "edit-provider") setView({ kind: "providers" });
    } catch (cause) { fail(cause); }
    finally { setSaving(false); }
  };

  return <div className="settings-resource-panel models-panel">
    <div className="settings-resource-heading">
      <div className="settings-resource-title">
        <h3>模型<span className="count-badge">{models.length}</span></h3>
        <p>选择当前会话使用的模型。连接配置和新会话默认分开管理。</p>
        <span className={`model-runtime-status ${modelRuntimeSyncPending ? "is-pending" : "is-ready"}`}>
          {modelRuntimeSyncPending ? "正在刷新模型目录" : "模型目录已刷新"}
        </span>
      </div>
      <div className="models-panel-actions">
        {view.kind === "catalog"
          ? <>
              <button type="button" className="model-add-button" onClick={() => {
                if (providers.length) {
                  setView({ kind: "add-model" });
                  setModelDraft(emptyModel(providers[0][0]));
                } else {
                  setView({ kind: "add-provider" });
                  setProviderDraft(emptyProvider());
                }
                setError(""); setNotice("");
              }}>添加模型</button>
              <button type="button" className="model-add-button" onClick={() => setView({ kind: "providers" })}>管理连接</button>
            </>
          : <button type="button" className="model-add-button" onClick={goCatalog}>返回模型</button>}
        <button type="button" className="resource-browse-root" title="打开 models.json" aria-label="打开 models.json" disabled={browseBusy} onClick={onBrowseModels}><FolderIcon /></button>
      </div>
    </div>
    {error && <div className="resource-error">{error}</div>}
    {notice && !error && <div className="resource-notice">{notice}</div>}
    <div className="models-panel-body">
      {view.kind === "catalog" && <CatalogList
        models={orderedModels}
        currentKey={currentKey}
        defaultKey={defaultKey}
        favoriteSet={favoriteSet}
        busy={busy}
        onUse={useInSession}
        onFavorite={(model) => void toggleFavorite(model)}
        onDefault={(model) => void setDefault(model)}
        onEdit={(model) => void openModel(model.provider, model.id)}
      />}
      {view.kind === "providers" && <ProvidersList
        providers={providers}
        saving={saving}
        onEdit={(provider, custom) => custom ? void openProvider(provider) : undefined}
        onDelete={(provider) => void removeProvider(provider)}
        onAdd={() => { setView({ kind: "add-provider" }); setProviderDraft(emptyProvider()); setError(""); setNotice(""); }}
      />}
      {(view.kind === "edit-provider" || view.kind === "add-provider") && providerDraft && <ProviderForm
        draft={providerDraft}
        adding={view.kind === "add-provider"}
        saving={saving}
        onChange={setProviderDraft}
        onCancel={() => setView({ kind: "providers" })}
        onSave={() => void saveProvider()}
        onEditModel={(provider, id) => void openModel(provider, id)}
        onAddModel={() => {
          setView({ kind: "add-model" });
          setModelDraft(emptyModel(providerDraft.provider));
        }}
      />}
      {(view.kind === "edit-model" || view.kind === "add-model") && modelDraft && <ModelForm
        draft={modelDraft}
        adding={view.kind === "add-model"}
        providers={providers.map(([name]) => name)}
        saving={saving}
        advanced={advanced}
        onAdvanced={setAdvanced}
        onChange={setModelDraft}
        onCancel={goCatalog}
        onSave={() => void saveModel()}
      />}
    </div>
  </div>;
}

function CatalogList({ models, currentKey, defaultKey, favoriteSet, busy, onUse, onFavorite, onDefault, onEdit }: {
  models: ModelInfo[];
  currentKey: string;
  defaultKey: string;
  favoriteSet: Set<string>;
  busy: boolean;
  onUse: (model: ModelInfo) => void;
  onFavorite: (model: ModelInfo) => void;
  onDefault: (model: ModelInfo) => void;
  onEdit: (model: ModelInfo) => void;
}) {
  if (!models.length) return <p className="resource-loading">当前没有可用模型</p>;
  return <div className="model-catalog-list" aria-label="模型目录">
    {models.map((model) => {
      const key = modelPreferenceKey(model.provider, model.id);
      const current = key === currentKey;
      const isDefault = key === defaultKey;
      const favorite = favoriteSet.has(key);
      return <article className={`model-catalog-row${current ? " is-current" : ""}`} key={key}>
        <button type="button" className="model-catalog-main" disabled={busy || current} onClick={() => onUse(model)}>
          <strong>{model.name || model.id}</strong>
          <small>{model.provider}{formatContext(model) ? ` · ${formatContext(model)}` : ""}{model.reasoning ? " · Reasoning" : ""}{model.input?.includes("image") ? " · Vision" : ""}</small>
        </button>
        <div className="model-catalog-badges">
          {current && <span className="model-badge is-current">当前会话</span>}
          {isDefault && <span className="model-badge is-default">新会话默认</span>}
        </div>
        <div className="model-catalog-actions">
          <button type="button" className={`model-star${favorite ? " is-on" : ""}`} aria-pressed={favorite} title={favorite ? "取消常用" : "标为常用"} aria-label={favorite ? `取消常用 ${model.name || model.id}` : `标为常用 ${model.name || model.id}`} onClick={() => onFavorite(model)}><StarIcon /></button>
          <button type="button" disabled={isDefault} onClick={() => onDefault(model)}>设为默认</button>
          {isCustomModel(model) && <button type="button" onClick={() => onEdit(model)}>编辑</button>}
        </div>
      </article>;
    })}
  </div>;
}

function ProvidersList({ providers, saving, onEdit, onDelete, onAdd }: {
  providers: Array<[string, ModelInfo[]]>;
  saving: boolean;
  onEdit: (provider: string, custom: boolean) => void;
  onDelete: (provider: string) => void;
  onAdd: () => void;
}) {
  return <div className="model-provider-list">
    <div className="models-panel-actions" style={{ marginBottom: 8 }}>
      <button type="button" className="model-add-button" disabled={saving} onClick={onAdd}>添加自定义提供方</button>
    </div>
    {providers.map(([provider, providerModels], index) => {
      const custom = providerModels.some(isCustomModel);
      const panelId = `model-provider-panel-${index}`;
      return <section className="model-provider-card" key={provider}>
        <header className="model-provider-head">
          <button type="button" className="model-provider-disclosure" aria-expanded="false" aria-controls={panelId} onClick={() => onEdit(provider, custom)}>
            <span className="model-provider-chevron" aria-hidden="true"><ChevronRightIcon /></span>
            <strong>{provider}</strong>
            {custom && <span className="model-custom-badge">自定义</span>}
          </button>
          <div className="model-provider-actions">
            <span className="model-provider-count">{providerModels.length} 个模型</span>
            {custom ? <>
              <button type="button" disabled={saving} onClick={() => onEdit(provider, true)}>编辑</button>
              <button type="button" className="model-delete-action" disabled={saving} onClick={() => onDelete(provider)}>删除</button>
            </> : <span className="model-provider-managed">{providerModels.some((model) => model.authMode === "pi-managed") ? "Pi 登录管理" : "Pi Runtime 管理"}</span>}
          </div>
        </header>
      </section>;
    })}
  </div>;
}

function ProviderForm({ draft, adding, saving, onChange, onCancel, onSave, onEditModel, onAddModel }: {
  draft: CustomProviderInput;
  adding: boolean;
  saving: boolean;
  onChange: (next: CustomProviderInput) => void;
  onCancel: () => void;
  onSave: () => void;
  onEditModel: (provider: string, id: string) => void;
  onAddModel: () => void;
}) {
  return <div className="model-editor model-provider-editor" aria-label={adding ? "添加 Provider" : "编辑 Provider"}>
    <div className="model-editor-head"><strong>{adding ? "添加自定义提供方" : `${draft.provider} 连接`}</strong><button type="button" disabled={saving} onClick={onCancel}>取消</button></div>
    <div className="model-editor-grid">
      <label>Provider<input value={draft.provider} disabled={!adding || saving} onChange={(event) => onChange({ ...draft, provider: event.target.value })} /></label>
      <label>API 协议<select value={draft.api} disabled={saving} onChange={(event) => onChange({ ...draft, api: event.target.value as CustomProviderInput["api"] })}>{APIS.map((api) => <option key={api} value={api}>{api}</option>)}</select></label>
      <label className="model-editor-wide">API 地址<input value={draft.baseUrl} disabled={saving} placeholder="https://api.example.com/v1" onChange={(event) => onChange({ ...draft, baseUrl: event.target.value })} /></label>
      <label className="model-editor-wide">API 密钥<input type="password" value={draft.apiKey || ""} disabled={saving} placeholder="已配置 — 输入新值以替换" onChange={(event) => onChange({ ...draft, apiKey: event.target.value })} /></label>
      {adding && <label>首个模型 ID<input value={draft.models[0]?.id || ""} disabled={saving} onChange={(event) => onChange({ ...draft, models: [{ ...draft.models[0], id: event.target.value, name: draft.models[0]?.name || event.target.value }] })} /></label>}
      {adding && <label>显示名称<input value={draft.models[0]?.name || ""} disabled={saving} onChange={(event) => onChange({ ...draft, models: [{ ...draft.models[0], id: draft.models[0]?.id || "", name: event.target.value }] })} /></label>}
    </div>
    {!adding && <div className="model-provider-model-links">
      <p>此连接下的模型</p>
      {draft.models.map((model) => <button type="button" key={model.originalId || model.id} onClick={() => onEditModel(draft.provider, model.originalId || model.id)}>{model.name || model.id}</button>)}
      <button type="button" className="model-inline-add" onClick={onAddModel}>＋ 添加模型</button>
    </div>}
    <div className="model-editor-footer">
      <span>保存只更新连接配置，不会改当前会话模型。</span>
      <button type="button" className="model-save-button" disabled={saving} onClick={onSave}>{saving ? "保存中…" : "保存"}</button>
    </div>
  </div>;
}

function ModelForm({ draft, adding, providers, saving, advanced, onAdvanced, onChange, onCancel, onSave }: {
  draft: CustomModelInput;
  adding: boolean;
  providers: string[];
  saving: boolean;
  advanced: boolean;
  onAdvanced: (value: boolean) => void;
  onChange: (next: CustomModelInput) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return <div className="model-editor" aria-label={adding ? "添加模型" : "编辑模型"}>
    <div className="model-editor-head"><strong>{adding ? "添加模型" : `${draft.name || draft.id}`}</strong><button type="button" disabled={saving} onClick={onCancel}>取消</button></div>
    <div className="model-editor-grid">
      {adding && <label>Provider<select value={draft.provider} disabled={saving || !providers.length} onChange={(event) => onChange({ ...draft, provider: event.target.value })}>{providers.map((provider) => <option key={provider} value={provider}>{provider}</option>)}</select></label>}
      <label>Model ID<input value={draft.id} disabled={saving} onChange={(event) => onChange({ ...draft, id: event.target.value })} /></label>
      <label>显示名称<input value={draft.name || ""} disabled={saving} onChange={(event) => onChange({ ...draft, name: event.target.value })} /></label>
      <label>上下文<input type="number" min="1" value={draft.contextWindow || ""} disabled={saving} onChange={(event) => onChange({ ...draft, contextWindow: event.target.value ? Number(event.target.value) : undefined })} /></label>
      <label>最大输出<input type="number" min="1" value={draft.maxTokens || ""} disabled={saving} onChange={(event) => onChange({ ...draft, maxTokens: event.target.value ? Number(event.target.value) : undefined })} /></label>
      <label className="model-editor-check"><input type="checkbox" checked={draft.reasoning} disabled={saving} onChange={(event) => onChange({ ...draft, reasoning: event.target.checked })} /> Reasoning</label>
      <label className="model-editor-check"><input type="checkbox" checked={draft.imageInput} disabled={saving} onChange={(event) => onChange({ ...draft, imageInput: event.target.checked })} /> Vision</label>
    </div>
    <button type="button" className="model-advanced-toggle" onClick={() => onAdvanced(!advanced)}>{advanced ? "收起高级选项" : "高级选项"}</button>
    {advanced && <div className="model-editor-grid">
      <label>API 协议<select value={draft.api} disabled={saving} onChange={(event) => onChange({ ...draft, api: event.target.value as CustomModelInput["api"] })}>{APIS.map((api) => <option key={api} value={api}>{api}</option>)}</select></label>
    </div>}
    <div className="model-editor-footer">
      <span>保存后用于之后的请求，不会改写正在生成的 Prompt。</span>
      <button type="button" className="model-save-button" disabled={saving} onClick={onSave}>{saving ? "保存中…" : "保存"}</button>
    </div>
  </div>;
}
