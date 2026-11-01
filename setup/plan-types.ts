// Types for the setup plan model. Type-only: the preview fixture and the future engine share them.

export type ComponentKind = "pi-self" | "pi-foreman" | "pi-package" | "npm-global" | "herdr-plugin" | "herdr-mod" | "external";

export interface Component {
  id: string;
  name: string;
  kind: ComponentKind | string;
  installed?: string;
  available?: string;
  pin?: string;
  source: string;
  managed: boolean;
  note?: string;
}

export type StepKind = "install" | "update" | "write" | "permission" | "run";
export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface FileWrite {
  path: string;
  before: string;
  after: string;
  diff: string[];
}

export interface Step {
  id: string;
  kind: StepKind;
  title: string;
  package?: string;
  version?: { from?: string; to: string };
  source?: string;
  writes?: FileWrite[];
  permission?: { before: string; after: string; summary: string };
  status: StepStatus;
}

export interface ModelChoice {
  model: string;
  thinking?: string;
}

export interface ModelRow {
  role: string;
  rung: string;
  values: Record<string, ModelChoice>;
}

export interface ModelGrid {
  providers: string[];
  rows: ModelRow[];
  effectiveReviewer: { rung: "main" | "idle"; model: string }[];
  warnings: string[];
}

export interface WorkFolder {
  path: string;
  mode: string;
}

export interface ConfigTarget {
  id: string;
  title: string;
  path: string;
  diff: string[];
}

export interface ApplyProgress {
  steps: Step[];
  log: string[];
}

export type ScreenId = "home" | "plan" | "updates" | "config" | "models" | "workfolders" | "apply";

export interface PreviewFixture {
  screens: { id: ScreenId; title: string }[];
  components: Component[];
  steps: Step[];
  modelGrid: ModelGrid;
  workFolders: WorkFolder[];
  configTargets: ConfigTarget[];
  apply: ApplyProgress;
}
