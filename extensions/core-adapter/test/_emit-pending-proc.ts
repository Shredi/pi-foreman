// Helper process of steward-revision.test.ts: one main-session start emits the pending lessons of the store in argv[2]; prints how many it emitted.
import { emitPendingLessons } from "../reportstool.ts";

let n = 0;
emitPendingLessons({ cwd: process.argv[2], isChild: false, id: `p${process.pid}`, foremanSession: `p${process.pid}`, role: "foreman", launchId: null, enabled: true, expireDays: undefined, workspaceOverride: null, emit: () => { n++; } });
console.log(n);
