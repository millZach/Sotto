# Worker swarms give each angle a worktree and one lead

## Status

Accepted by Drake on October 29, 2026, following [the Worker counts plan](../plans/watcher-worker-counts.html), merged in [#1810](https://github.com/millZach/Sotto/pull/1810). **Number provisional until merge** (docs/agents/domain.md).

Drake settled four choices: every angle gets its own worktree; starts above the machine ceiling queue in order rather than being refused for capacity; the controls and one-call swarm flow ship in one pull request; and the Owl feature is `worker-swarms`, with `sentToStable: false`.

This amends [ADR-0091](0091-worker-roles-say-what-each-kind-of-work-starts-on.md) decisions 2, 4, 6 and 7, [ADR-0081](0081-a-thread-may-delegate-work-to-threads-it-starts.md) decisions 2, 5 and 7 and its October 17 roster amendment, and [ADR-0073](0073-watcher-coordinates-threads-with-its-providers-own-tools.md)'s October 19 warning-only start policy. Placement still follows [ADR-0082](0082-work-moves-between-a-desktops-machines-over-its-own-ssh-link.md). Their behavior with this feature off stays as it was.

## Context

One model can investigate several angles serially, but Drake also wants several researchers to work on different angles of the same question. The role table says which model, effort, speed and permission a kind of work uses; it did not say how many workers the agent should start. Independent calls left the agent to coordinate their identities, replies and retries, while the warning above ten working threads never held a new start back.

A swarm gives those starts one owner and one result. Its count is a count of angle workers, with a separate lead. The machine ceiling is a limit on simultaneous work, not a limit on the size of a request.

## Decision

**1. Workers belongs to each worker role.** Settings → Watcher adds **Workers**, with **Usual** and **Up to**, beside the role's other choices. Usual is the count to choose normally; Up to bounds a count the agent chooses on its own. Both are whole numbers from 1 to 1,000, and Usual cannot exceed Up to. The defaults are:

| Role | Usual | Up to |
| --- | ---: | ---: |
| Research | 1 | 8 |
| Code review | 1 | 4 |
| Building | 1 | 2 |
| UI | 1 | 2 |
| Computer use | 1 | 1 |

Orchestrating is Watcher itself and has no Workers control. Counts are stored as `workers: { usual, upTo }` beside the saved role choices. An invalid Workers value drops only the counts, keeping the row's other choices. Reset and Reset all remove counts with the rest of the chosen row, and Undo restores them. A provider connecting or disconnecting does not overwrite them.

The user's own number overrides Usual and Up to for that request, just as their model, effort or speed does. Tools carry a number, not proof of who chose it: instructions enforce that distinction, and the tool never treats a count as an approval or a wider permission. The runtime enforces machine capacity separately. During review Drake approved a 1,000-angle input limit per request to bound allocation and receipt size; this is separate from the machine ceiling, which queues all valid angles.

**2. One call makes one swarm.** `start_thread` and `sotto_delegate.delegate` add optional `count` and `prompts`. A count above one creates that many **angles** and one **lead**, on the requested role's model. `prompts`, when present, has one complete brief per angle. Without them, the lead plans the angles and fills this swarm through one delegation call with its original retry key. That call fills the reserved angles rather than creating a second lead. Nested swarms are not part of this flow.

A call without `count` keeps its existing single-worker path. Agents are told each role's Usual and Up to, and choose a count when they need a swarm. The existing role, project, machine, operating-system, branch and permission rules apply to the starts. A lead that cannot use delegation cannot promise a completed swarm.

Every angle gets a new worktree, including Research and Code review. Angles do not share the lead's checkout or one another's checkout. Worktrees remain ordinary Sotto-owned worktrees, with the same branch, cleanup and bring-back rules as other independent delegated threads.

**3. One retry key owns all the starts.** Before dispatch, Sotto records the swarm ID, its owner and user-message root, the input digest, the lead identity and a stable key for each angle. A retry with the same input returns the existing partial receipt; it never makes another lead or repeats a member that was already admitted. Changed input with the same key is refused. The receipt names the swarm, lead and each angle, including those still planned or queued, and reports how many wait.

The durable record contains identities, configuration, digests and states. Briefs and replies remain in thread history under Keep local history; they are not copied into the swarm record or logs. After a restart, the owner can retry the original request to fill angles recorded as never admitted; Sotto does not replay their briefs automatically. An admitted start whose outcome cannot be proved becomes Unknown. An unavailable or failed angle remains visible. Sotto never reads success, failure or permission from its prose.

**4. Each machine owns one admission queue.** Settings → Watcher adds **Worker capacity**, with **Most working at once** defaulting to ten, and can save an override for a listed machine. A remote override is a requested limit: the target machine applies the lower of that request and its own ceiling. A host must advertise swarm admission before accepting these starts.

The running machine owns a single queue shared by Watcher starts and delegations from every controller. It reserves capacity atomically before starting work, so two callers cannot take the same last slot. Working threads count whether the user or an agent started them; Watcher itself and provider-native subagents do not. The user's own sends are not held by this queue. Lowering a ceiling leaves work already running alone.

A full machine queues new worker starts in order. Capacity alone refuses none. Each receipt states the wait, and Stop on a queued angle removes that start without launching it. Existing placement rules still refuse a disconnected machine, the wrong operating system or work that cannot be admitted under its permissions; the ceiling never silently moves it elsewhere. Checks retain their one-at-a-time rule as well as the worker ceiling. A waiting check must not hold a worker slot.

The lead uses capacity while planning, releases it when that turn ends, and takes capacity again to write its synthesis. It holds no slot while waiting for the angles, so a ceiling of one can complete a swarm.

**5. The lead owns the replies and synthesis.** Angles are ordinary delegated threads owned by the lead. Their replies reach that owner under ADR-0081, labelled as their own words. Sotto holds member completion news until it can wake the lead for the synthesis; it does not wake the parked lead once per finished angle. A question or permission that needs the user still surfaces at once.

Watcher watches the lead and gets aggregated progress such as “5 of 8 angles done, 1 failed”. The Threads list groups the angles under the lead, keeping each angle's open, stop and question controls. The lead writes one synthesis naming findings, sources, disagreements and missing or failed angles. A planning reply is not the final answer. Unknown, paused or background work does not count as a finished angle.

The receipt states the cost shape: N times the role's effort, plus the lead's planning and synthesis. This describes the work, not a price quote. Sotto adds no account, key, network host or route for prompt text.

**6. Stop and settle follow ownership.** Stopping the lead cancels its queued angles and stops its active descendants through the existing delegation cascade. Stopping one queued angle removes only that angle. User takeover and Stop watching keep their existing authority.

Settling the lead settles its finished angles with it. The existing per-thread checks still apply: no running or unknown work, pending sends, unanswered user cards or open pull requests may be discarded. Automatic settlement also waits for Watcher to hear the result and finish its own turn. A partial or failed swarm never disguises an unfinished angle as done.

**7. One Owl switch covers the whole feature.** `worker-swarms` gates Workers, machine ceilings, tool fields, swarm instructions, queues and group views together. Stable with that switch off shows and starts none of them and keeps saved counts and records whole, including through a whole Settings save or reset, following ADR-0091 decision 7. Existing one-worker calls, role choices and warning-only behavior remain available as before. There is no setting-only interim release.

## Verification

Extend the existing role-table, Settings, Watcher tools and delegation unit files for count defaults and validation, feature-off preservation, retry identity, queue order, cancellation, lead synthesis and a ceiling of one. Check the Settings column headlessly in dark and light at the supported sizes. Run typecheck, lint and only the touched unit files locally; the rest of CI runs on GitHub. The app is not launched for these checks.
