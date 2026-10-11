/** Local installation metadata only; never model credentials or RPC readiness authority. */
export interface RuntimeEntryInfo {
  entry: string;
  version?: string;
}

export interface RuntimeSetupStatus {
  current: RuntimeEntryInfo | null;
  configured: RuntimeEntryInfo | null;
  automatic: RuntimeEntryInfo | null;
  source: "environment" | "saved" | "automatic";
  environmentOverride: boolean;
  configurationRevision: string;
  error?: string;
  automaticError?: string;
  pickerAvailable: boolean;
  restartAvailable: boolean;
}

export type RuntimeSetupChange = {
  mode: "retry" | "automatic" | "select";
  configurationRevision: string;
  entry?: string;
};
