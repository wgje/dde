---
title: Documentation Maintenance
status: canonical
audience: maintainer, ai-agent
last_verified: 2026-06-11
category: develop-maintain
source_paths:
  - docs/README.md
  - docs/handbook/catalog.json
  - docs/context7/README.md
  - scripts/validate-context7-docs.cjs
  - package.json
---

# Documentation Maintenance

NanoFlow documentation has two layers. Keep them separate and keep both validated.

## In This Article

- [Human docs versus Context7 docs](#human-docs-versus-context7-docs)
- [When to update the handbook](#when-to-update-the-handbook)
- [When to update Context7](#when-to-update-context7)
- [Add a handbook page](#add-a-handbook-page)
- [Run documentation gates](#run-documentation-gates)
- [Next steps](#next-steps)

## Human Docs Versus Context7 Docs

| Layer | Path | Audience | Style |
| --- | --- | --- | --- |
| Human handbook | `docs/handbook` | users, operators, contributors | explanatory, procedural, readable |
| Context7 corpus | `docs/context7` | AI agents, retrieval tools, maintainers | precise, source-backed, machine-consumable |

The same topic can exist in both layers, but with different writing goals.

## When To Update the Handbook

Update `docs/handbook` when a change affects:

- user workflow;
- onboarding;
- deployment or operations;
- recovery behavior;
- security expectations;
- contributor setup;
- verification commands.

## When To Update Context7

Update `docs/context7` when a change affects:

- source paths;
- model fields;
- services or ownership boundaries;
- sync contracts;
- security contracts;
- API or Edge Function references;
- machine retrieval routes.

## Add a Handbook Page

1. Pick the existing category.
2. Create a Markdown file under that category.
3. Add required front matter.
4. Include `## In This Article`.
5. Add links to adjacent pages.
6. Add the page to `docs/handbook/catalog.json`.
7. Run validation.

Required front matter:

```yaml
---
title: Page Title
status: canonical
audience: user, operator
last_verified: 2026-06-11
category: use-nanoflow
source_paths:
  - README.md
---
```

## Run Documentation Gates

Human docs:

```bash
npm run docs:human:validate
```

Context7 docs:

```bash
npm run docs:context7:validate
```

Combined docs:

```bash
npm run docs:validate
```

If a behavior change touches both reader-facing guidance and source contracts, both layers should change in the same work item.

## Next Steps

- Use [Testing and Quality](03-testing-and-quality.md) to choose a verification command.
- Use the machine corpus at [Context7 Documentation](../../context7/README.md) when an AI agent needs exact source-backed facts.
