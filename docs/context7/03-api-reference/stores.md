---
title: Stores API Reference
status: canonical
audience: ai-agent, maintainer
last_verified: 2026-06-09
source_paths:
  - src/app/core/state/stores.ts
---

# Stores API Reference

## `TaskStore`

| Member | Purpose |
| --- | --- |
| `tasksMap` | `Map<string, Task>` Signal for O(1) task lookup |
| `tasks` | computed task list |
| `parkedTaskIds` | Signal `Set<string>` of tasks with parking metadata |
| `parkedTasks` | computed parked task list |
| `getTask(id)` | read a task |
| `getTaskProjectId(taskId)` | read project ownership |
| `getTasksByProject(projectId)` | list project tasks |
| `setTask(task, projectId)` | set one task |
| `setTasks(tasks, projectId)` | replace project tasks |
| `removeTask(id, projectId)` | remove one task |
| `bulkSetTasks(tasks, projectId)` | update project task subset |
| `bulkRemoveTasks(taskIds, projectId)` | remove many tasks |
| `clearProject(projectId)` | clear one project |
| `clear()` | clear all tasks |

## `ProjectStore`

| Member | Purpose |
| --- | --- |
| `projectsMap` | project lookup map |
| `projects` | computed project list |
| `activeProjectId` | active project ID Signal |
| `activeProject` | computed active project |
| `getProject(id)` | read a project |
| `setProject(project)` | set one project |
| `setProjects(projects)` | replace all projects |
| `removeProject(id)` | remove project |
| `removeProjectCascade(id, taskStore, connectionStore)` | remove project and child state |
| `bulkSetProjects(projects)` | update projects |
| `bulkRemoveProjects(projectIds)` | remove projects |
| `clear()` | clear all project state |

## `ConnectionStore`

| Member | Purpose |
| --- | --- |
| `connectionsMap` | connection lookup map |
| `connections` | computed connection list |
| `getConnection(id)` | read a connection |
| `getConnectionsByProject(projectId)` | list project connections |
| `setConnection(connection, projectId)` | set one connection |
| `setConnections(connections, projectId)` | replace project connections |
| `removeConnection(id, projectId)` | remove one connection |
| `bulkSetConnections(connections, projectId)` | update connection subset |
| `bulkRemoveConnections(connectionIds, projectId)` | remove many connections |
| `clearProject(projectId)` | clear project connections |
| `clear()` | clear all connections |

## Store Rules

- No facade store aggregation.
- Business field changes must bump `updatedAt`.
- Store equality is revision-based, not deep object comparison.
