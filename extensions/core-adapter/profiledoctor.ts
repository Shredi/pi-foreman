// Doctor lines for feature profiles (docs/install.md "Profiles, features and add-ons").
import { assignment, deviations, featureState, loadDefaults, loadFeatures, loadProfiles, toggleable } from "./profiles.mjs";

type Json = Record<string, unknown>;

/**
 * `userMerged`: the config merged from defaults, user file and overlay only (no project or session layer), so project
 * tightening is not reported as a deviation. `effective`: the config in force, for the relaxation warning.
 */
export function profileDoctorLines(userMerged: Json, effective: Json, root: string): string[] {
  const out: string[] = [];
  const recorded = userMerged.profile;
  const features = toggleable(loadFeatures(root)) as { id: string; toggle: { on?: Json; relaxes?: boolean } }[];
  const autoOn = new Set(features.filter((f) => Object.values(f.toggle.on ?? {}).some((v) => v === null)).map((f) => f.id));
  const label = (id: string, state: string): string => (state === "on" && autoOn.has(id) ? "auto" : state);
  if (typeof recorded !== "string" || !recorded) out.push("INFO profile: none (run foreman setup --pick or --profile <name>)");
  else if (!assignment(recorded, root)) out.push(`WARN profile ${recorded} unknown (valid: ${Object.keys(loadProfiles(root).profiles ?? {}).join(", ")}); fix: foreman setup --profile <name>`);
  else {
    out.push(`INFO profile: ${recorded}`);
    const rows = deviations(userMerged, recorded, root) as { id: string; expected: string; actual: string }[];
    out.push(`INFO profile deviations: ${rows.length ? rows.map((r) => `${r.id} is ${label(r.id, r.actual)}, profile says ${label(r.id, r.expected)}`).join("; ") : "none"}`);
  }
  const defaults = loadDefaults(root);
  const on = features.filter((f) => f.toggle.relaxes && featureState(f, effective, defaults) === "on").map((f) => f.id);
  if (on.length) out.push(`WARN safety relaxations on: ${on.join(", ")}`);
  return out;
}
