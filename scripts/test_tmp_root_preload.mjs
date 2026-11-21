// Imported first by the test preloads: a direct run (no foreman_test_run.mjs, no outer root) gets its own run root before any other temp dir is made.
import { ownRunRoot } from "./test_tmp_root.mjs";

ownRunRoot();
