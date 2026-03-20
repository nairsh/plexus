Place backend-managed skills in this directory.

Each skill should live in its own subdirectory and include a `SKILL.md` file.

Example:

```
skills/
  my-skill/
    SKILL.md
```

The API and orchestrator load skills from this backend-local `skills/` folder.
