# 📖 `clever migrate` command reference

## ➡️ `clever migrate` <kbd>Unreleased</kbd>

Analyze a project and list what is missing to deploy it on Clever Cloud

```bash
clever migrate [<path>] [options]
```

### 📥 Arguments

|Name|Description|
|---|---|
|`path`|Path of the project to analyze (current directory if not specified) *(optional)*|

### ⚙️ Options

|Name|Description|
|---|---|
|`-F`, `--format` `<format>`|Output format (human, json) (default: human)|
|`-n`, `--name` `<app-name>`|Application name used in the migration plan (current directory name by default)|
|`--strict`|Exit with code 1 if blockers are found (useful in CI)|
|`-t`, `--type` `<instance-type>`|Force the target instance type instead of detecting it|
|`--write`|Write the proposed configuration files (existing files are never overwritten)|
