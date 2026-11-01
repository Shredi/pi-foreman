import type { ScreenId } from "../../plan-types.ts";
import { createApply } from "./apply.ts";
import { createConfig } from "./config.ts";
import { createHome } from "./home.ts";
import { createModels } from "./models.ts";
import { createPlan } from "./plan.ts";
import { createUpdates } from "./updates.ts";
import { createWorkFolders } from "./workfolders.ts";
import type { ScreenFactory } from "./types.ts";

export const SCREEN_IDS: ScreenId[] = ["home", "plan", "updates", "config", "models", "workfolders", "apply"];

export const SCREENS: Record<ScreenId, ScreenFactory> = {
  home: createHome,
  plan: createPlan,
  updates: createUpdates,
  config: createConfig,
  models: createModels,
  workfolders: createWorkFolders,
  apply: createApply,
};
