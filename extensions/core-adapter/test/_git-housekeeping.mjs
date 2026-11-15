// The git settings that keep housekeeping off for every git child of a test: after a commit git runs `git maintenance run --auto --detach`,
// which takes and removes `objects/maintenance.lock` while a rig copies the repository. Shared by _hermetic-env.mjs (the preload) and the
// tests whose helper drops GIT_CONFIG_* from the environment and sets them again. Not a test: the test glob matches only *.test.ts.
export const GIT_HOUSEKEEPING_OFF = [["maintenance.auto", "false"], ["gc.auto", "0"]];
