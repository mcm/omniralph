# Epic: Task priorities

## Problem

Tasks have no priority, so nobody can tell what matters.

## Scope

### In

- A priority on every task

### Out

- No notifications

## Requirements

- FR-1: The system must store a priority (high, medium, low) on every task
- FR-2: The system must show each task's priority in the task list

## Open Questions

1. Who can set a priority?

---

# Story: Add the priority column

I want you to add a priority to tasks, so that people know what matters.

Build it by adding a priority column to the tasks table.

Don't stop until tasks have a priority column.

---

# Story: Show the priority

I want you to add a priority to tasks, so that people know what matters.

Build it by adding a priority column to the tasks table.

Don't stop until tasks have a visible priority.

---

# Fix: Keep the priority on save

I want you to fix saving a task with a priority, which drops the priority today: the priority should be kept.

Build it by checking the save handler, which likely ignores the field.

Don't stop until saving a task keeps its priority. Tasks without a priority save as before.
