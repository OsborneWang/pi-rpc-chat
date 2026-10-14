# Task File Template

给 `auto-team` 的任务文件建议包含以下内容：

```markdown
# Task: <slug>

## User request

<用户原始需求或主 agent 整理后的需求>

## Classification

- Tier: tiny | standard | major
- Planning artifact: .workflow/changes/<slug>/brief.yaml
- Worktree: none | .worktrees/<slug>

## Intended approach

- <主 agent 当前方案>

## Questions for teammate

1. <希望 teammate 回答的问题>

## Constraints

- Read-only review/scouting only. Do not edit files.
- Project root: /WorkSpace/pi-rpc-chat
```
