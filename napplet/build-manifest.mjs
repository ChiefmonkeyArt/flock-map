// Kept for backward compatibility: the napplet, its single-file bundle and the
// UNSIGNED kind 35129 / 30617 events are all produced by the main build so the
// web app and napplet can never drift. This script never signs.
//   node napplet/build-manifest.mjs [--check]   (same as: node tools/build.mjs)
import { main } from '../tools/build.mjs';
main();
