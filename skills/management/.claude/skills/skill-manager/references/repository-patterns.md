# Repository patterns

These are researched examples, not hardcoded installers. Inspect the current repository before acting.

- `https://gitee.com/ai-dvps/agent-skill-creator`: root SKILL.md plus scripts and references. Check `docs/INSTALL.md` and any companion skill requirements such as semantic-recon. A companion is a separate choice; do not silently install all dependencies or native plugins.
- `https://gitee.com/ai-dvps/compound-engineering-plugin`: a collection under `skills/`. Select specific Skill directories and preserve their complete references. A plugin manifest, hook or platform command is not itself a Skill; do not install those as a prerequisite for Comate.
- `https://gitee.com/ai-dvps/ui-ux-pro-max-skill`: inspect the CLI's `init --ai claude|codex|opencode` flow. Its `ui-ux-pro-max-cli` generator materializes platform-specific Skills with scripts and data. If generation is required, use the documented generator for the selected scope and targets, check runtime prerequisites, and verify referenced data. Copying a source template alone is not a successful install.

Do not claim these repositories support every target unchanged. Report missing dependencies, unsupported platform output or partial success explicitly.
