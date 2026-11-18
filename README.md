# Jev Speaker Router 0.5.2

## 0.5.2: cast row follows the theme, size pulled back a notch

0.5.1 fixed the clipping and made the buttons easier to press, but it
introduced a light-grey row background that looks terrible on a dark /
custom theme. That was my fault: I set the row's background to
`var(--SmartThemeBodyColor)`, which renders light on Dre's theme, instead
of letting the row inherit its surroundings. 0.5.2 sets the row background
to transparent, so it follows whatever theme `#sheld` already has, and
never sets a theme colour itself. All on / Hide keep their normal
`menu_button` styling.

Size is also pulled back from 0.5.1's overcorrection: 32px avatars with
40px tap targets in a 46px row, between 0.5.0's 28px / 32px and 0.5.1's
36px / 44px / 56px. Text buttons stay at 36px high, non-wrapping, with a
minimum width, since those were the part that was actually easier to
press. The `#chat` height adjustment from 0.5.1 is unchanged.

## 0.5.1: taller cast row, wider text buttons, sole-character shortcut

- **Cast row sizing (the screenshot bug).** Avatars are now 36px for a 44px
  tap target (up from 28px / 32px), the row is 56px tall with
  `flex: 0 0 auto` so a flex parent cannot squeeze it, and it keeps its
  own background. **All on** and **Hide** (and the collapsed **Cast** button)
  are now `white-space: nowrap` with a minimum width, so they cannot wrap
  out of view in a flex row. The underlying cause found in SillyTavern
  1.19.0's CSS: `#sheld` has a fixed height and `#chat`'s own max-height
  does not account for a row inserted before it, so the row's height would
  otherwise push `#sheld` past its height and let it scroll/clip the row.
  `#chat` itself is statically positioned and does not overlay in-flow
  content. 0.5.1 therefore shrinks `#chat` by the row's measured height
  (and restores it when the row is removed), so the total fits and `#chat`
  scrolls internally as before.
- **Sole-eligible-character shortcut.** The earlier deferred idea, now
  included: if exactly one eligible character remains, even if USER is
  also eligible (previous speaker null, or a now-muted character), that
  character is chosen directly with no API call, shown as 100% with USER
  at 0%. No-repeat is preserved because the eligible set already excludes
  the previous speaker. The normal cases were already covered by the
  existing single-eligible shortcut; this only fills the null-previous
  gap.

## 0.5.0: cast row and silence bonus

Two changes, both aimed at the same problem: present characters going quiet
while two others ping-pong.

- **Cast row.** A small row of avatar bubbles inserted in-flow immediately
  before `#chat` (after `#sheldheader`), so it sits below the top menu and
  above the messages, with no fixed positioning. Tap a bubble to toggle
  SillyTavern's existing group mute for that character
  (`group.disabled_members`, via the exported `editGroup` function, exactly
  as the native group-menu button does). Muted avatars are greyed out.
  The router already excludes muted characters, so no new cast state is
  needed. The row re-renders only on group/chat change, never per message.
  Use **All on** for a one-tap morning reset, and **Hide** to collapse the
  row to a single button. Toggling a bubble cancels a pending decision,
  like any other group change.
- **Silence bonus (gap bonus).** Each participant now carries
  `turns_since_last_spoke`, counted over the full chat in character turns
  (user messages do not count, system/empty messages do not count, speaking
  resets it to zero). The decision prompt now says silence alone is not a
  reason to exclude a present character, and a long-silent present
  character with a relevant contribution is a good next speaker. The
  plugin then adds a capped bonus to eligible characters only: slider
  0 = off, 100 = strongest, cap 0.50 at 100 (about 0.17 at the default
  33), saturating after 10 silent turns. There is deliberately no floor
  on raw probability: a present character stuck below 5% is exactly the
  case the bonus is for, and bedroom-style protection now comes from
  muting, not from a floor. USER is never bonused, muted / previous-speaker
  / Continue-excluded speakers are excluded before any bonus, and the
  single-eligible shortcut bypasses the bonus entirely (no API call).
  The **Silence bonus** slider in the drawer is per group, default 33.
  Evaluate only shows raw probability, bonus, and adjusted probability,
  so the slider can be tuned against a real transcript. The bonus is
  internal only: OpenRouter only ever sees `{model, state, questions}`.

Continue override, no-repeat, single-eligible shortcut, and all previous
behaviour are preserved unchanged. In particular, Continue with an empty
Send box, the Continue button/menu, and **Continue with someone else**
still exclude USER and the last speaker, and mute-everyone-but-one plus
Continue still selects that one character directly with no API call
(unless that character was the last speaker, in which case no-repeat
still blocks an immediate repeat).

## 0.4.1: repackaged release (same code as 0.4.0)

0.4.1 is identical to 0.4.0 except for the release packaging: the tarball now
carries clean `root:root` ownership, standard `755`/`644` permissions, and an
executable `install.sh`, so no `chmod +x` step is needed. If 0.4.0 is already
installed and working, there is no need to upgrade.

## Decision model choice in 0.4.0

The Jev-only restriction is gone. The **Decision model** field in the extension panel accepts any model served on [OpenRouter's Decisions API](https://openrouter.ai/api/alpha/decisions) (`/api/alpha/decisions`), with suggestions for the known ones:

- `typesafe/jev-1.13` (default; unchanged behaviour)
- `~typesafe/jev-latest`
- `perplexity/pplx-decider-v1.1-27b`

OpenRouter confirms the Perplexity decider uses the same request/response contract as Jev: the router posts `{model, state, questions}` with a `choice`-type `next_speaker` question and parses the typed probabilistic answer the same way, so no per-model build is needed. A model ID that OpenRouter does not serve on the Decisions API is rejected upstream and reported as a provider error; the request validation itself only checks the ID format (OpenRouter `author/model` shape, optional `~` alias prefix and `:variant` suffix).

Existing settings are untouched: if you never edit the field, everything behaves exactly as 0.3.2. The debug panel still shows the model name, probabilities, timing and cost for each decision.

For SillyTavern 1.19.0, tested against source supplied from Dre's Node 24 Docker container on LibreELEC.

## Soft two-response preference in 0.3.2

When multiple companions are plausibly participating, Jev is asked to favour two complementary responses: after one, prefer another relevant contribution; after two, prefer returning to the human. A third is still possible when it meaningfully develops the conversation. Questions requiring the human's answer, private exchanges, and lack of a useful contribution can end the exchange after one. Presence and no-repeat rules still apply. This is a prompt preference, not a fixed quota or a measured frequency guarantee.

The request now includes `response_pacing`: completed responses, preferred responses (two), configured maximum, and where counting starts. Ordinary routing and Evaluate only count nonempty character messages since the latest user message, using the full chat rather than truncated history. System messages and empty placeholders do not count. Explicit Continue starts a fresh sequence and counts responses produced in that sequence. The existing maximum caps generations per run, including Continue; it is not raised by the preference. Leave the maximum at three to allow occasional third responses.

Evaluate only shows the same pacing context as ordinary routing at that point in the conversation. It does not generate messages. The change needs live comparison across multiple scenes; local tests verify request construction and control flow, not Jev's judgment quality.

## No-repeat rule in 0.3.1

The immediately previous speaker is removed from the eligible choices on every decision, including Evaluate only, Route now, automatic routing after a user message, and each step in a response chain. After USER, only characters are eligible. After a character, that character is excluded and USER can end the exchange. Nori → Dre → Nori remains valid. The browser also rejects a repeated speaker returned by an outdated plugin.

The latest nonempty conversation message determines the previous speaker; system notes and empty placeholders are ignored. Avatar identity distinguishes cards with duplicate names. For legacy messages without avatar identity, a unique card-name match is accepted; ambiguous matches stop routing safely.

Highest-probability selection, the configured response limit, profiles, and settings are retained. No randomizer or Talkativeness weighting has been added. This rule applies to turns selected by this extension; native manual generation, swipes, and internal continuations retain their existing behavior.

## Continue override (introduced in 0.3.0)

When active routing is enabled for the group, user clicks on SillyTavern's visible Continue controls (the quick button or menu item), or Send with an empty text box, request a different character. There is also a **Continue with someone else** button inside this extension.

For the first decision of that sequence, USER and the most recent character speaker are removed from the eligible choices. The last speaker is resolved from the full chat history, even if user messages followed their response. Muted characters remain excluded. The ordinary participant/scene information is still supplied as context.

After the selected character completes its response, normal routing resumes with USER eligible again. The configured response limit applies to this sequence and includes the first response. Ordinary Route now and new user messages retain normal selection rules, with the previous speaker excluded.

If only one eligible speaker remains, it is selected directly without an unnecessary API call; the result is labelled accordingly. If none remain, the router displays **No other available character** and sends no generation request. If a legacy message has no avatar identity and its speaker name matches multiple cards, the router stops rather than guessing whom to exclude.

The UI capture hook applies to actual user click events, not SillyTavern's internal automatic continuations. Slash commands and programmatically triggered clicks retain their existing meaning; use the visible Continue button for the override. The override does not affect groups where active routing is disabled. Native button integration is covered by simulated click tests, but still needs confirmation in the live browser.

Upgrade both components using the installer below. Your profiles, settings and previous version are preserved/backed up as before.

## Fixes retained from 0.2.1

This is a compatibility/diagnostic update for the reported stopped routing. It does not claim to resolve the Qvink preset/context-size errors, whose exact cause is still unverified.

- Prompt-building events marked dryRun no longer cancel a queued user turn or an owned response loop. These events build context and need not represent a new visible reply.
- Memory-only changes to chat metadata/message extra fields no longer invalidate a Jev decision. Text edits, scenario changes, member changes and muted status still invalidate it.
- Programmatic input events are distinguished from actual typing.
- Routing diagnostics retain the last 100 events during the page session, including cancellations, choices and response completion checks. They survive Evaluate only and drawer re-rendering but are cleared on browser reload. No chat transcript or API key is intentionally included in that log.

After upgrading, leave Qvink enabled for the first test. If routing stops unexpectedly, copy **Routing diagnostics (last 100 events)** from the extension panel before reloading. A fresh Evaluate only request makes a new decision; it does not show why an earlier automatic run stopped. The diagnostic trace distinguishes normal USER/limit stops from cancellation and generation failures.

Regression tests simulate background dry-run events during/after a user turn and memory-only writes during a Jev request. These pass locally, but the installed Qvink integration remains to be verified. A genuine external generation still pauses the router rather than risking concurrent visible responses.

## Changes

- Uses SillyTavern's standard inline drawer header, bold title and chevron, inheriting the selected theme.
- Fixes blank character names in `{{char}}` substitutions by using the 1.19 options-object API.
- Adds optional active routing per group. Each completed response is followed by a new decision until USER or the response limit (default three).
- Keeps dry-run evaluation, dynamic membership, optional shared character profiles, and saved settings from 0.1.0.
- No character names are hard-coded. Request IDs are mapped to avatar filenames and resolved to current array indices immediately before generation.

## Upgrade from 0.1.0, 0.2.0, 0.2.1, 0.4.0, 0.4.1, 0.5.0 or 0.5.1

Copy `jev-speaker-router-0.5.2.tar.gz` to `/storage/docker/sillytavern/`, then run:

```sh
cd /storage/docker/sillytavern
tar -xzf jev-speaker-router-0.5.2.tar.gz
sh jev-speaker-router-0.5.2/install.sh
docker restart sillytavern
```

The installer backs up both installed components and config under `jev-backups/<timestamp>-<process-id>/`, replaces the project files, and enables server plugins if necessary. It does not modify character cards, chats or user extension settings. It also supports a first installation with the existing folder mappings. Enabling server plugins enables any other server plugins installed there.

Hard-refresh the browser with Ctrl+Shift+R. In Extensions, find the normal-looking **Jev Speaker Router** drawer; inside it, confirm Version 0.5.2.

## First check

1. Open a group and click **Check connection**.
2. Click **Preview context**. Character descriptions containing `{{char}}` should now contain the actual character name.
3. **Evaluate only** still makes a decision without generating a response.

## Enable active routing

1. Disable **Group Response Router**, visible in Dre's screenshot, and any other extension that controls speaker generation. Coexistence with another router is not supported or automatically detected.
2. Set the current group's reply-order strategy to **Manual**.
3. Turn SillyTavern's built-in **Auto-mode off**.
4. In Jev Speaker Router, select **Enable active routing for this group**. This does not immediately start generation.
5. Send a normal message, or use **Route now** to route from the current conversation.

You can start with a maximum of one response for an initial test, then increase it to the default three. Enabling active routing is per group, so other groups retain their previous behaviour. Use one controlling browser tab for initial testing; there is no cross-tab coordinator.

Each routing cycle:

- Collects the current unmuted members and recent context.
- Asks the decision model who should speak next.
- Validates that the chat, settings and membership are still unchanged.
- Waits if USER is selected, or triggers exactly one selected character using SillyTavern's normal pipeline.
- Waits for the full group wrapper, including automatic continuations, to finish.
- Repeats until USER or the configured limit. No extra decision request is sent at the limit.

A repeated speaker is allowed. The configured limit counts completed character turns, not streaming chunks or continuations. A failed, empty or interrupted generation stops the sequence. No random fallback or automatic retry is used.

## Stop and manual control

- **Stop routing** cancels the pending decision request and stops a response owned by this extension.
- SillyTavern's normal Stop action cancels the sequence too.
- Typing pauses further routing. If a character is already responding, that response may finish; another will not start automatically. Send your message or use Route now when ready.
- Switching chats, editing/deleting/swiping messages, changing relevant settings, or manually triggering another generation cancels the pending sequence.
- Regenerations and swipes do not automatically restart active routing.
- Use Continue (or an empty Send click) for the different-speaker override in active groups. Route now uses ordinary candidate rules. When active routing is disabled, SillyTavern retains its own empty-Send behaviour.
- Turning active routing off cancels the current sequence. It does not restore or change your group's reply-order strategy.

## Context and settings

20 recent messages by default (adjustable 4–50), bounded to 18,000 characters of message text in total and 3,000 per message, favouring recent messages. Long messages keep their beginning and carry a truncation marker. Up to 24 unmuted characters, with routing profiles capped at 1,800 characters. Blank profile fields use bounded description/personality excerpts. Profiles are reused across groups and keyed by avatar filename; changing that filename can require re-entering a profile.

Presence is inferred within the single speaker decision. Silence is explicitly neutral evidence; the router does not force quiet characters to speak. Recent movement and scene evidence take precedence over starting scenarios. There is no presence database. Departures or arrivals outside the supplied context may be misinterpreted.

The server plugin uses the active saved OpenRouter key and the separate Decisions API. Default model: `typesafe/jev-1.13`, changeable in the panel's Decision model field to any other model served on the Decisions API. Requests time out after 15 seconds. It permits one request per SillyTavern user at a time. Keys are never stored in UI settings or returned to the browser. Context is sent to OpenRouter for each evaluation; debug context/results are shown locally in the panel without a separate transcript log.

Highest-score selection is used. Debug shows probabilities, not invented explanations. Muted characters are excluded as candidates but their historical messages remain as context. Lorebooks, Qvink memories, images and hidden reasoning are not separately included.

## Validation and limitations

Local tests cover: context construction, response validation, credential handling with stubs, cancellation/concurrency, bounded sequential routing, and the frontend with simulated DOM and SillyTavern events. JavaScript and shell syntax checks pass. The installer retains the existing backup and settings-preservation behavior. Run the tests with `node --test tests/*.test.mjs` from the extracted release directory.

Dre confirmed the preceding 0.3.0 release working in his SillyTavern 1.19.0 container. The 0.5.2 update has passed local automated tests (85 tests, unchanged from 0.5.1 except for cast-row styling). It still needs a live check after installation on the Pi, especially: the cast row background follows the dark/custom theme, and the row height feels right.

## Troubleshooting and rollback

If auto-routing seems dead after you send a message, open the extension drawer first: routing errors (provider failures, timeouts, response mismatches) are only shown in the panel's status line, so a closed drawer makes a failed run look like nothing happened. The **Routing diagnostics (last 100 events)** log records why each run stopped.

If the panel or plugin fails to load, run `docker logs --tail 80 sillytavern` and share relevant error lines only. For a generation problem, disable active routing, retain the latest request/result and note whether a character began responding.

To roll back to the backed-up version, turn off active routing in each group first. Copy the backed-up `extensions/jev-speaker-router` and `plugins/jev-speaker-router` folders over the installed folders, restart the container, then hard-refresh. The old index will ignore the new runner file if it remains. Don't restore the entire config backup over later unrelated configuration changes.

References: the supplied SillyTavern 1.19.0 source; https://docs.sillytavern.app/for-contributors/server-plugins/ ; https://docs.sillytavern.app/for-contributors/writing-extensions/ ; https://openrouter.ai/blog/insights/what-is-jev/
