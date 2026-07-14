/**
 * Tests for participant profile-image capture (Google Meet).
 *
 * `getGoogleParticipantImage` lives inside a `page.evaluate` closure in
 * recording.ts (same reason `getGoogleParticipantName` isn't unit-tested
 * directly elsewhere in this codebase — it only exists in a browser
 * context, not as a standalone export), so this pins the live DOM-scrape
 * logic with a structural source-shape check (mirrors admission.test.ts).
 * The captured image rides the live path:
 *   recording.ts getGoogleParticipantImage
 *     -> window.__vexaSpeakerEvents (participant_image)
 *     -> unified-callback -> meeting.data.speaker_events
 *     -> post_meeting.py -> meeting.data.participant_details
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function expectTrue(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
    passed++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`);
    if (detail) console.log(`        ${detail}`);
    failed++;
  }
}

// --- Structural: DOM-scrape source shape (recording.ts / selectors.ts) ---

const RECORDING_TS = path.join(__dirname, 'recording.ts');
const SELECTORS_TS = path.join(__dirname, 'selectors.ts');
const recordingBody = fs.readFileSync(RECORDING_TS, 'utf-8');
const selectorsBody = fs.readFileSync(SELECTORS_TS, 'utf-8');

console.log('\n=== Google Meet participant profile-image capture ===');

expectTrue(
  'selectors.ts exports googleParticipantImageSelectors',
  selectorsBody.includes('export const googleParticipantImageSelectors'),
);

expectTrue(
  'selectors.ts prefers the googleusercontent avatar host',
  selectorsBody.includes('lh3.googleusercontent.com'),
);

expectTrue(
  'selectors.ts does NOT use a bare img[src] last-resort fallback (avoids non-avatar icons)',
  !/['"]img\[src\]['"]/.test(selectorsBody),
);

expectTrue(
  'recording.ts defines getGoogleParticipantImage',
  recordingBody.includes('function getGoogleParticipantImage(participantElement: HTMLElement)'),
);

expectTrue(
  'recording.ts returns null when no avatar <img> is found (non-throwing)',
  /function getGoogleParticipantImage[\s\S]*?return null;\s*\n\s*\}/.test(recordingBody),
);

expectTrue(
  'getGoogleParticipantImage filters out data:image placeholder pixels',
  /function getGoogleParticipantImage[\s\S]*?data:image/.test(recordingBody),
);

expectTrue(
  'sendGoogleSpeakerEvent captures participant_image alongside participant_name/id (the live path)',
  /participant_name: participantName,\s*\n\s*participant_id: participantId,\s*\n\s*participant_image: participantImage,/.test(
    recordingBody,
  ),
);

expectTrue(
  '__vexaGetAllParticipantNames additively exposes an images map',
  recordingBody.includes('images: Record<string, string | null>'),
);

console.log(`\n=== participant-image summary: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
