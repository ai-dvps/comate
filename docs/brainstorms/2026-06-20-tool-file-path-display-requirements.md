---
date: 2026-06-20
topic: tool-file-path-display
---

# Tool File Path Display Improvements

## Summary

Improve how file paths are shown in tool input renderers so paths are cleaner, workspace-relative, and clickable. Strip trailing slashes, render the workspace-relative path as the primary text, keep the absolute path available on hover, and let users open the referenced file in the file panel by clicking the path.

## Problem Frame

Tool input renderers such as `Read`, `Write`, `Edit`, `Glob`, and `Grep` currently display raw absolute paths in the **Parameters** section. These paths repeat the workspace root, often carry a trailing slash when the target is a directory, and are rendered as plain text. Users who want to inspect the referenced file must locate it manually in the file explorer instead of jumping directly to it.

## Requirements

**Path cleaning and display**

- R1. Remove any trailing slash from a file path before rendering it.
- R2. When the path is inside the active workspace, display it relative to the workspace root.
- R3. Keep the absolute path accessible via a hover tooltip or title attribute.

**Interaction**

- R4. Clicking a displayed file path opens the file in the existing file panel using the same behavior as clicking a file in the file explorer.
- R5. If the path cannot be opened (missing file, directory, or path outside the workspace), do not show inline error UI; leave the path non-clickable or no-op.

## Scope Boundaries

- **Deferred for later:** applying the same path treatment to the tool header summary line, which may also contain file paths.
- **Outside this product's identity:** editing files from the tool card, opening files in an external editor, or mutating the underlying tool input data.

## Dependencies / Assumptions

- The active workspace's `folderPath` is available to tool renderers or their rendering context.
- A file-open callback equivalent to the file explorer's click handler can be supplied to tool renderers.
- Paths passed to file-handling tools are absolute or workspace-relative today.
