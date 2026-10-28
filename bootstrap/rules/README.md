# Global rule supplements

The six numbered files supplement Cline's default non-YOLO instructions. They
do not restate its general Plan/Act contract, absolute-path requirement, tool
batching, routine verification, or communication style. The Act prompt itself
owns the balance between useful planning and prompt/context cost.

Install only `0[1-6]-*.md` as rules. This README is reference documentation;
do not copy it into an active global rule directory. Copying rules alone does
not update Cline's compiled prompt: use a CLI/extension build containing the
matching Act-prompt changes before or together with these supplements.

## Review the defaults in source

| Source | What it supplies |
| --- | --- |
| [Act prompt](../../sdk/packages/shared/src/prompt/system/act.ts) | Proportionate planning and updates; context gathering; conventions and complete code; absolute paths; independent batching; verification and final reporting. |
| [Prompt assembly and mode contracts](../../sdk/packages/shared/src/prompt/cline.ts) | Both Act and Plan use the Act base. Plan additionally forbids changes and requires an agreed plan/mode switch. It also documents mode-tag handling and explicit prompt overrides. |
| [Default prompt selector](../../sdk/packages/shared/src/prompt/system/index.ts) | Chooses the Act or YOLO template; [YOLO](../../sdk/packages/shared/src/prompt/system/yolo.ts) has its own behavior and is outside this deduplication pass. |
| [CLI prompt entry](../../apps/cli/src/runtime/prompt.ts), [SDK-backed extension entry](../../apps/vscode/src/sdk/cline-session-factory.ts) | Both call the shared prompt builder. These are the current host entry points; legacy extension prompt files elsewhere are not the shared default. |
| [Native editor contracts and engine](../../sdk/packages/core/src/extensions/tools/file-editor/engine/editor.mjs), [draft protocol](../../sdk/packages/core/src/extensions/tools/file-editor/engine/drafts.mjs) | Required arguments, reads/hashes/ranges, payload limits, stale-edit recovery, dependent edit ordering, draft acknowledgements, locking and atomic writes. These instructions arrive with the tools. |
| [Instruction loader](../../sdk/packages/core/src/extensions/config/user-instruction-config-loader.ts), [rule search paths](../../sdk/packages/shared/src/storage/paths.ts) | Finds and loads global/workspace rule files and AGENTS.md. Loading an entry file does not replace following its links to relevant feature documentation. |
| [Conversation summary prompt](../../sdk/packages/core/src/extensions/context/summarize-conversation.ts), [agentic compaction](../../sdk/packages/core/src/extensions/context/agentic-compaction.ts) | Built-in continuation summaries and context retention. The supplements add operational continuity and targeted retrieval after compaction. |

Review the tool descriptions as well as the system prompt. Tool-specific
constraints are instructions too. An explicit custom prompt override can change
which default text is used; check the prompt builder before relying on this map.

## What the numbered files add

| Supplement | Policy retained beyond the defaults |
| --- | --- |
| [01: Scope and authorization](01-scope-and-communication.md) | Latest corrections and continuing authorization, smallest complete scope, concrete need for added dependencies/refactors, and real permission boundaries. No separate communication-style override. |
| [02: Workspace and evidence](02-workspace-and-evidence.md) | Host/container/VM/subsystem/remote distinctions; source versus installed/deployed copies; project knowledge maps; API evidence, privacy and focused repository research. |
| [03: Setup and budgets](03-tools-and-edits.md) | Resolve prerequisites using the declared toolchain and lockfile; verify the actual execution shell; do not evade normal setup; keep complete generated calls within the model's output budget. No preference for obsolete MCP replacements or blanket same-file ban. |
| [04: Recovery and continuity](04-recovery-and-continuity.md) | Explicit expert authorization and same-job continuation; focused failure recovery; preserve pending questions/working evidence; resume after compaction without repeating discovery. |
| [05: Validation and delivery](05-validation-and-delivery.md) | Acceptance evidence rather than syntax alone; protect unrelated work; exact-worktree PR validation; local required checks; honest blockers and a clear stopping condition. |
| [06: Documentation and recoverability](06-documentation-and-backups.md) | Stable entry instructions for cache reuse, authoritative feature documentation, privacy-safe recoverability, Git history instead of routine backups, and scratch cleanup. |

Expert delegation is an additional MCP contract, not a stock Cline capability.
Its [tool descriptions](../consult-expert/src/consult_expert/server.py) and
[assignment contract](../consult-expert/src/consult_expert/contracts.py) supply
the detailed workflow. Rule 04 preserves the user's explicit-authorization and
continuation policy without copying the full tool manual.

## Same-file edits

The old blanket ban was broader than the editor's actual requirement. The native
editor serializes writes and checks for stale file state; independent exact-match
replacements can therefore be safe even within one file. Its lock cannot decide
the intended order of dependent changes, and a successful first write invalidates
a shared whole-file hash. Even non-overlapping positional edits can consequently
conflict. Ordered draft chunks also depend on prior acknowledgements.

The Act prompt and tool contracts carry this distinction. The numbered global
rules do not repeat a universal ban on same-file batching. Use sequential calls
when one operation depends on the content, positions, hash or draft state produced
by another; refresh the relevant state after a conflict.
